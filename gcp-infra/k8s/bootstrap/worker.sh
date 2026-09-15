#!/usr/bin/env bash
# StatusBus spot-worker bootstrap (kubeadm).
# Runs on every fresh VM as part of a Managed Instance Group: installs the
# runtime, then joins the existing cluster using the join command that the
# control plane publishes to Secret Manager. Retries until the control plane
# is reachable (it may still be initializing when the worker boots).
set -euo pipefail

PROJECT="$(curl -sfH 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/project/project-id' || true)"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

sm_token() {
  curl -sfH 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
}
sm_get() {
  local token; token="$(sm_token)"
  curl -sf -H "Authorization: Bearer $token" \
    "https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/$1/versions/latest:access" \
    | sed -n 's/.*"data"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | base64 -d | head -1
}

apt_get() { DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::='--force-confdef' -o Dpkg::Options::='--force-confold' "$@"; }

if [ ! -f /var/lib/statusbus-bootstrap-done ]; then
  log "installing base packages"
  apt_get update
  apt_get install -y apt-transport-https ca-certificates curl gnupg containerd

  log "installing kubeadm/kubelet (pinned v1.29)"
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.29/deb/Release.key \
    | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
  echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.29/deb/ /' \
    > /etc/apt/sources.list.d/kubernetes.list
  apt_get update
  apt_get install -y kubelet kubeadm
  apt-mark hold kubelet kubeadm

  log "configuring containerd + kernel"
  mkdir -p /etc/containerd
  containerd config default > /etc/containerd/config.toml
  sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
  systemctl restart containerd

  swapoff -a
  sed -i '/swap/d' /etc/fstab || true
  echo br_netfilter > /etc/modules-load.d/k8s.conf
  modprobe br_netfilter || true
  tee /etc/sysctl.d/k8s.conf >/dev/null <<'EOF'
net.bridge.bridge-nf-call-iptables = 1
net.ipv4.ip_forward = 1
EOF
  sysctl --system >/dev/null

  touch /var/lib/statusbus-bootstrap-done
else
  log "packages already installed on this disk; skipping"
fi

# ---- Join (idempotent: skip if this disk already joined) ----
if [ -f /etc/kubernetes/kubelet.conf ]; then
  log "worker already joined; nothing to do"
  exit 0
fi

JOIN_CMD=""
for i in $(seq 1 30); do
  if JOIN_CMD="$(sm_get k8s-join-command 2>/dev/null)" && [ -n "$JOIN_CMD" ]; then
    break
  fi
  log "join command not published yet, retrying in 20s ($i/30)"
  sleep 20
done

if [ -z "$JOIN_CMD" ]; then
  log "FATAL: never received a join command from Secret Manager"
  exit 1
fi

log "joining cluster"
eval "$JOIN_CMD --node-name=\"$(hostname)\""

log "worker bootstrap complete"