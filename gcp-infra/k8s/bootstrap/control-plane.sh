#!/usr/bin/env bash
# StatusBus control-plane bootstrap (kubeadm, single node).
# Runs once per VM create. Idempotent: if the cluster already exists on this
# disk (kubelet.conf present) it skips init and only refreshes the join token.
set -euo pipefail

PROJECT="$(curl -sfH 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/project/project-id' || true)"
ZONE_FULL="$(curl -sfH 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/zone' || true)"
ZONE="${ZONE_FULL##*/}"
HOSTNAME="$(hostname)"
HOST_IP="$(curl -sfH 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/ip')"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

# ---- Secret Manager helpers (REST, no gcloud needed on the VM) ----
sm_token() {
  curl -sfH 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
}
sm_get() {
  local token; token="$(sm_token)"
  curl -sf -H "Authorization: Bearer $token" \
    "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/$1/versions/latest:access" \
    | sed -n 's/.*"payload":{"data":"\([^"]*\)".*/\1/p' | base64 -d
}
sm_create() {
  local token; token="$(sm_token)"
  curl -sf -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d '{"replication":{"automatic":{}}}' \
    "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets?secretId=$1" >/dev/null || true
}
sm_add_version() {
  local token payload; token="$(sm_token)"; payload="$(base64 -w0 "$2")"
  curl -sf -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d "{\"payload\":{\"data\":\"$payload\"}}" \
    "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/$1:addVersion" >/dev/null
}
sm_set() { sm_create "$1"; sm_add_version "$1" "$2"; }

# ---- Base runtime ----
apt_get() { DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' "$@"; }

if [ ! -f /var/lib/statusbus-bootstrap-done ]; then
  log "installing base packages"
  apt_get update
  apt_get install -y apt-transport-https ca-certificates curl gnupg containerd

  log "installing kubeadm/kubelet/kubectl (pinned v1.29)"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.29/deb/Release.key \
    | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
  echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.29/deb/ /' \
    > /etc/apt/sources.list.d/kubernetes.list
  apt_get update
  apt_get install -y kubelet kubeadm kubectl
  apt-mark hold kubelet kubeadm kubectl

  log "configuring containerd + kernel"
  containerd config default > /etc/containerd/config.toml
  sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
  systemctl enable --now containerd

  swapoff -a
  sed -i '/swap/d' /etc/fstab || true
  tee /etc/sysctl.d/k8s.conf >/dev/null <<'EOF'
net.bridge.bridge-nf-call-iptables = 1
net.ipv4.ip_forward = 1
EOF
  sysctl --system >/dev/null

  touch /var/lib/statusbus-bootstrap-done
fi

# ---- kubeadm init (only if this disk has no cluster yet) ----
if [ ! -f /etc/kubernetes/kubelet.conf ]; then
  log "initializing cluster (pod CIDR 192.168.0.0/16, advertise $HOST_IP)"
  kubeadm init \
    --pod-network-cidr=192.168.0.0/16 \
    --apiserver-advertise-address="$HOST_IP" \
    --node-name="$HOSTNAME"

  export KUBECONFIG=/etc/kubernetes/admin.conf

  log "waiting for API server"
  for i in $(seq 1 60); do
    kubectl get nodes >/dev/null 2>&1 && break
    sleep 5
  done
  kubectl wait --for=condition=Ready node/"$HOSTNAME" --timeout=300s || log "node not ready yet (Calico pending)"

  log "installing Calico CNI (pinned v3.27.3)"
  kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.27.3/manifests/calico.yaml

  log "labeling node"
  kubectl label node "$HOSTNAME" nodeType=control-plane --overwrite
else
  log "cluster already initialized on this disk; skipping init"
fi

# ---- Refresh join credentials for workers ----
log "publishing join command to Secret Manager"
TOKEN="$(kubeadm token create --ttl=0 2>/dev/null)"
CA_HASH="sha256:$(openssl x509 -pubkey -in /etc/kubernetes/pki/ca.crt \
  | openssl rsa -pubin -outform der 2>/dev/null | openssl dgst -sha256 | sed 's/^.* //')"
printf 'kubeadm join %s:6443 --token %s --discovery-token-ca-cert-hash %s\n' "$HOST_IP" "$TOKEN" "$CA_HASH" \
  > /tmp/k8s-join-command
sm_set k8s-join-command /tmp/k8s-join-command

log "control-plane bootstrap complete"