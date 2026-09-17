#!/usr/bin/env bash
# StatusBus cloud provisioning for the kubeadm era.
# Creates (in order):
#   1. k8s-control-plane       on-demand VM  (asia-south1)   — kubeadm init
#   2. k8s-worker-template +   spot MIG, 2 VMs (asia-south1) — auto-join, auto-recreate
#   3. us-consumer-template +  spot MIG, 1 VM (us-central1)  — REGION_ID=2 consumer
# Also grants the default compute SA the Secret Manager role the startup
# scripts depend on, and ensures the required firewall rules exist.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="variables.env"
[ -f "$HERE/$SRC" ] || SRC="variables.env.example"
# shellcheck source=/dev/null
source "$HERE/$SRC"

CONTROL_NAME="k8s-control-plane"
WORKER_TEMPLATE="k8s-worker-template-v2"
WORKERS_MIG="k8s-workers"
US_TEMPLATE="us-consumer-template-v2"
US_MIG="us-consumers"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
COMPUTE_SA="$PROJECT_NUMBER-compute@developer.gserviceaccount.com"

log() { echo "[create-vms] $*"; }

log "1/4 IAM — granting compute SA Secret Manager + artifact access"
for role in roles/secretmanager.admin roles/artifactregistry.reader; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$COMPUTE_SA" --role="$role" \
    --condition=None --quiet >/dev/null 2>&1 || true
done

log "2/4 firewall — k8s node traffic + IAP SSH"
gcloud compute firewall-rules create allow-k8s-internal \
    --project="$PROJECT_ID" \
    --allow=tcp:6443,tcp:10250,udp:4789,tcp:179,tcp:2379-2380,tcp:30000-32767 \
    --source-tags="$NETWORK_TAG" --target-tags="$NETWORK_TAG" \
    --quiet >/dev/null 2>&1 || true
gcloud compute firewall-rules create allow-iap-ssh \
    --project="$PROJECT_ID" \
    --allow=tcp:22 \
    --source-ranges=35.235.240.0/20 \
    --target-tags="$NETWORK_TAG" \
    --quiet >/dev/null 2>&1 || true

log "3/4 control plane + worker group"
if ! gcloud compute instances describe "$CONTROL_NAME" --zone="$CLUSTER_ZONE" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute instances create "$CONTROL_NAME" \
    --project="$PROJECT_ID" \
    --zone="$CLUSTER_ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --network-interface=subnet="$SUBNET" \
    --image-family="$IMAGE_FAMILY" --image-project="$IMAGE_PROJECT" \
    --boot-disk-size="$BOOT_DISK_SIZE" --boot-disk-type=pd-standard \
    --metadata-from-file=startup-script="$HERE/bootstrap/control-plane.sh" \
    --scopes=cloud-platform \
    --tags="$NETWORK_TAG" \
    --labels=role=control-plane
else
  log "control plane VM already exists; skipping create"
fi

SUBNET_URL="https://www.googleapis.com/compute/v1/projects/$PROJECT_ID/regions/${CLUSTER_ZONE%-*}/subnetworks/$SUBNET"

gcloud compute instance-templates create "$WORKER_TEMPLATE" \
  --project="$PROJECT_ID" \
  --machine-type="$MACHINE_TYPE" \
  --network-interface="subnet=$SUBNET_URL" \
  --image-family="$IMAGE_FAMILY" --image-project="$IMAGE_PROJECT" \
  --boot-disk-size="$BOOT_DISK_SIZE" --boot-disk-type=pd-standard \
  --metadata-from-file=startup-script="$HERE/bootstrap/worker.sh" \
  --scopes=cloud-platform \
  --tags="$NETWORK_TAG" \
  --labels=role=worker \
  --provisioning-model=SPOT \
  --instance-termination-action=STOP \
  --quiet >/dev/null 2>&1 || true

gcloud compute instance-groups managed create "$WORKERS_MIG" \
  --project="$PROJECT_ID" \
  --zone="$CLUSTER_ZONE" \
  --template="$WORKER_TEMPLATE" \
  --size="$CLUSTER_WORKER_COUNT" \
  --quiet >/dev/null 2>&1 || true

log "4/4 US consumer group"
gcloud compute instance-templates create "$US_TEMPLATE" \
  --project="$PROJECT_ID" \
  --machine-type="$MACHINE_TYPE" \
  --network-interface=subnet="https://www.googleapis.com/compute/v1/projects/$PROJECT_ID/regions/${US_ZONE%-*}/subnetworks/default" \
  --image-family="$IMAGE_FAMILY" --image-project="$IMAGE_PROJECT" \
  --boot-disk-size="20" --boot-disk-type=pd-standard \
  --metadata-from-file=startup-script="$HERE/bootstrap/us-consumer.sh" \
  --metadata="api-url=$API_URL,consumer-image=$CONSUMER_IMAGE" \
  --scopes=cloud-platform \
  --tags="$NETWORK_TAG" \
  --labels=role=consumer,region=us \
  --provisioning-model=SPOT \
  --instance-termination-action=STOP \
  --quiet >/dev/null 2>&1 || true

gcloud compute instance-groups managed create "$US_MIG" \
  --project="$PROJECT_ID" \
  --zone="$US_ZONE" \
  --template="$US_TEMPLATE" \
  --size=1 \
  --quiet >/dev/null 2>&1 || true

log "done."
log "kubectl access (after init):
  gcloud compute ssh $CONTROL_NAME --zone=$CLUSTER_ZONE --tunnel-through-iap \\
      -- -N -L 8443:127.0.0.1:6443
  export KUBECONFIG=... # fetch /etc/kubernetes/admin.conf from the VM
  kubectl --kubeconfig=admin.conf get nodes"