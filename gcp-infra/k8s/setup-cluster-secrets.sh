#!/usr/bin/env bash
# StatusBus — create the in-cluster credentials the worker workloads need.
# Idempotent. Run after the control plane is up (create-vms.sh).
#
#   1. Ensures a `k8s-puller` SA exists with read access to the Artifact
#      Registry repo, plus a JSON key on disk under gcp-infra/k8s/keys/.
#   2. Creates the `statusbus-workloads` namespace on the cluster.
#   3. Creates the docker-registry pull secret and the worker env secret
#      (REDIS_URL, INTERNAL_KEY) sourced from Secret Manager.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="variables.env"
[ -f "$HERE/$SRC" ] || SRC="variables.env.example"
# shellcheck source=/dev/null
source "$HERE/$SRC"

CONTROL_NAME="${CONTROL_NAME:-k8s-control-plane}"
SSH_KEY="${SSH_KEY:-/tmp/sbk8s/k8s-key}"
AR_REGION="${CLUSTER_ZONE%-*}"
PULLER_SA="k8s-puller"
PULLER_EMAIL="$PULLER_SA@$PROJECT_ID.iam.gserviceaccount.com"
KEY_DIR="$HERE/keys"
KEY_FILE="$KEY_DIR/$PULLER_SA-key.json"
NAMESPACE="statusbus-workloads"
PULL_SECRET="gcp-artifact-registry-key"
ENV_SECRET="statusbus-worker-env"

log() { echo "[setup-cluster-secrets] $*"; }

kubectl_apply_stdin() {
  gcloud compute ssh "ubuntu@$CONTROL_NAME" \
    --zone="$CLUSTER_ZONE" --project="$PROJECT_ID" \
    --ssh-key-file="$SSH_KEY" --tunnel-through-iap \
    --command="sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl apply -f -" \
    >/dev/null
}

log "1/4 service account + Artifact Registry reader"
if ! gcloud iam service-accounts describe "$PULLER_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$PULLER_SA" \
    --display-name="StatusBus k8s image puller" --project="$PROJECT_ID" >/dev/null
fi
gcloud artifacts repositories add-iam-policy-binding statusbus \
  --location="$AR_REGION" --project="$PROJECT_ID" \
  --member="serviceAccount:$PULLER_EMAIL" \
  --role="roles/artifactregistry.reader" --quiet >/dev/null

log "2/4 JSON key"
mkdir -p "$KEY_DIR"
if [ ! -f "$KEY_FILE" ]; then
  gcloud iam service-accounts keys create "$KEY_FILE" \
    --iam-account="$PULLER_EMAIL" --project="$PROJECT_ID" >/dev/null
  log "created $KEY_FILE"
else
  log "key already present; reusing"
fi

log "3/4 reading Secret Manager values"
REDIS_URL="$(gcloud secrets versions access latest --secret=statusbus-redis-url --project="$PROJECT_ID")"
INTERNAL_KEY="$(gcloud secrets versions access latest --secret=statusbus-internal-key --project="$PROJECT_ID")"

DOCKERCFG="$(jq -n --rawfile key "$KEY_FILE" --arg host "$AR_REGION-docker.pkg.dev" \
  '{auths:{($host):{username:"_json_key",password:$key}}}')"
b64() { printf '%s' "$1" | openssl base64 -A; }

log "4/4 applying namespace + secrets to cluster"
{
  cat <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: $NAMESPACE
---
apiVersion: v1
kind: Secret
metadata:
  name: $PULL_SECRET
  namespace: $NAMESPACE
type: kubernetes.io/dockerconfigjson
data:
  .dockerconfigjson: $(b64 "$DOCKERCFG")
---
apiVersion: v1
kind: Secret
metadata:
  name: $ENV_SECRET
  namespace: $NAMESPACE
type: Opaque
data:
  REDIS_URL: $(b64 "$REDIS_URL")
  INTERNAL_KEY: $(b64 "$INTERNAL_KEY")
EOF
} | kubectl_apply_stdin

log "done. namespace=$NAMESPACE pull-secret=$PULL_SECRET env-secret=$ENV_SECRET"
