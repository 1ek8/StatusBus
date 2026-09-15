#!/usr/bin/env bash
# StatusBus second-region consumer bootstrap (standalone VM, no Kubernetes).
# Runs the consumer container on a spot VM in us-central1 so probes truly
# originate from a US data center (REGION_ID=2). Managed via Instance Group so
# GCP recreates it after a spot eviction — the container respawns from the same
# startup script.
set -euo pipefail

PROJECT="$(curl -sfH 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/project/project-id' || true)"
API_URL="$(curl -sfH 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/attributes/api-url' || true)"
CONSUMER_IMAGE="$(curl -sfH 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/attributes/consumer-image' || true)"

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
  log "installing docker"
  apt_get update
  apt_get install -y docker.io curl
  systemctl enable --now docker

  log "installing docker credential helper for Artifact Registry (pinned v2.1.22)"
  curl -fsSL \
    https://github.com/GoogleCloudPlatform/docker-credential-gcr/releases/download/v2.1.22/docker-credential-gcr_linux_amd64-2.1.22.tar.gz \
    | tar xz -C /usr/local/bin docker-credential-gcr
  docker-credential-gcr configure-docker

  touch /var/lib/statusbus-bootstrap-done
fi

if [ -z "$API_URL" ] || [ -z "$CONSUMER_IMAGE" ]; then
  log "FATAL: missing 'api-url' / 'consumer-image' instance metadata"
  exit 1
fi

log "running consumer ($CONSUMER_IMAGE) against $API_URL"
docker rm -f us-consumer >/dev/null 2>&1 || true
docker run -d \
  --name us-consumer \
  --restart unless-stopped \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  -e API_URL="$API_URL" \
  -e INTERNAL_KEY="$(sm_get statusbus-internal-key)" \
  -e REDIS_URL="$(sm_get statusbus-redis-url)" \
  -e REGION_ID=2 \
  -e CONSUMER_ID=us-consumer-1 \
  "$CONSUMER_IMAGE"

log "us-consumer bootstrap complete"