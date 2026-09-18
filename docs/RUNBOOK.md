# StatusBus — Operational Runbook

> Part of the StatusBus documentation set. Overview & quick start:
> [`../README.md`](../README.md). Worker architecture rationale:
> [`ARCHITECTURE-DECISIONS.md`](./ARCHITECTURE-DECISIONS.md).

This runbook covers the common day-2 operations for the live StatusBus worker
mesh (GCP kubeadm cluster + standalone US spot consumer). All commands assume the
GCP project `statusbus-app-1ek8`, zone `asia-south1-a` (India) /
`us-central1-a` (US), and an SSH key at `/tmp/sbk8s/k8s-key`.

Environment helper (run in any shell):

```bash
export PROJECT_ID=statusbus-app-1ek8
export ZONE=asia-south1-a   # or us-central1-a for the US VM
SSH_KEY=/tmp/sbk8s/k8s-key
```

---

## 1. Inventory

| VM | Zone | Model | Role | Start via |
| --- | --- | --- | --- | --- |
| `k8s-control-plane` | `asia-south1-a` | on-demand, e2-small | etcd + apiserver + **producer** | `gcp-infra/k8s/create-vms.sh` (single VM) |
| `k8s-workers-*` (MIG) | `asia-south1-a` | spot, e2-small | India **consumer** group (x2, anti-affinity) | same script |
| `us-consumers-*` (MIG) | `us-central1-a` | spot, e2-small | US **consumer** group (x1) | same script |

Secrets (GCP Secret Manager): `statusbus-db-url`, `statusbus-redis-url`,
`statusbus-internal-key`, `k8s-join-command`, `k8s-puller-key` (Artifact Registry
auth, mounted into pods via `gcp-artifact-registry-key` docker-registry secret).

---

## 2. Health Checks

```bash
# Nodes (via SSH + kubectl through IAP)
gcloud compute ssh ubuntu@k8s-control-plane --zone=$ZONE \
    --ssh-key-file=$SSH_KEY --tunnel-through-iap \
    --command='sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl get nodes -o wide'

# Workload pods
... --command='sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl -n statusbus-workloads get pods -o wide'

# Recent ticks (Neon, from local shell with gcloud + psql available)
source gcp-infra/k8s/variables.env
DB_URL="$(gcloud secrets versions access latest --secret=statusbus-db-url --project=$PROJECT_ID)"
psql "$DB_URL" -c "SELECT region_id, count(*), max(t.\"createdAt\") FROM \"WebsiteTick\" t GROUP BY 1;"
```

**What "healthy" looks like:** 3 `Ready` nodes; producer + 2 consumer pods
`Running`; ticks from *both* regions updating within the last producer interval
(~5 min).

---

## 3. Control-Plane Loss / Recovery

The control-plane VM holds etcd on its persistent boot disk. If the VM is
deleted or recreated, the disk survives and the startup script re-initialises
everything from it.

```bash
# Reattach the existing disk (disk name: same as the VM, lives in $ZONE)
gcloud compute instances attach-disk k8s-control-plane \
    --disk=k8s-control-plane --zone=$ZONE

# Recreate the VM (startup script will see kubelet.conf → skip init,
# rejoin from the persistent etcd data; it also regenerates the join token)
gcloud compute instances create k8s-control-plane \
    --zone=$ZONE --machine-type=e2-small --on-demand \
    --metadata-from-file=startup-script=gcp-infra/k8s/bootstrap/control-plane.sh \
    ...
# (use the exact flags from create-vms.sh; copy-paste is fine)

# Verify once serial output shows "bootstrap complete"
gcloud compute instances get-serial-port-output k8s-control-plane \
    --zone=$ZONE --port=1 | grep "bootstrap complete"
```

After the control plane is back, worker VMs that were evicted in the interim
rejoin automatically (they read the join token from Secret Manager).

---

## 4. Spot Worker / US Consumer Loss

**This is expected and self-healing.** The relevant MIG detects the lost
instance and recreates it from the current template. The startup script
installs the runtime and joins (or starts the consumer container). Typical
recovery: **2–4 min** (worker) or **3–5 min** (US, needs docker pull across
continents).

```bash
# Watch the MIG (India workers)
gcloud compute instance-groups managed list-instances k8s-workers \
    --zone=$ZONE --format="table(instance,instanceStatus,currentAction)"

# Watch the MIG (US consumer)
gcloud compute instance-groups managed list-instances us-consumers \
    --zone=us-central1-a --format="table(instance,instanceStatus,currentAction)"
```

If you want to **provoke** a spot eviction (chaos test):

```bash
# Kill an India worker
gcloud compute instances delete k8s-workers-XXXXX --zone=$ZONE --quiet

# Kill the US consumer
gcloud compute instances delete us-consumers-XXXXX --zone=us-central1-a --quiet
```

Wait for the MIG recreation; re-run the health check above. After the US
instance is recreated, confirm the `us-consumer bootstrap complete` marker
in its serial output.

**Mid-provisioning reboot:** spot VMs occasionally reboot during host
maintenance. Because docker is already installed on the persistent boot disk,
the idempotent startup script resumes the pull automatically; no manual
intervention required.

---

## 5. Image Rebuild & Rollback

Worker images live in Artifact Registry `asia-south1-docker.pkg.dev/<project>/statusbus`.
The startup scripts pull `:latest` at boot; no immutable tag is used for the
consumer/producer images (this is intentional for this proof-of-concept).

### 5a. Rebuild images

```bash
# From repo root
gcloud builds submit --config cloudbuild/statusbus-workers.yaml .
```

### 5b. Roll the US consumer (MIG rolling replace)

The US MIG template references the `us-consumer` image baked into its startup
script. To force a fresh pull, the simplest mechanism is to recreate the
instance (MIG will pull the new `:latest`):

```bash
gcloud compute instance-groups managed recreate-instances us-consumers \
    --zone=us-central1-a --instances=us-consumers-XXXXX
```

For a **full MIG refresh** (replace all instances):

```bash
gcloud compute instance-groups managed rolling-replace us-consumers \
    --zone=us-central1-a --max-unavailable=1
```

### 5c. Roll India consumer pods (control plane)

India consumers are a Deployment in `statusbus-workloads`. Forcing a new pod
pull:

```bash
gcloud compute ssh ubuntu@k8s-control-plane --zone=$ZONE \
    --ssh-key-file=$SSH_KEY --tunnel-through-iap --command='
        sudo KUBECONFIG=/etc/kubernetes/admin.conf \
        kubectl -n statusbus-workloads rollout restart deployment statusbus-consumer-india'
```

### 5d. Rollback

Rebuild the image from a known-good commit, push, then trigger either of the
above rolling operations. The MIG or Deployment will pull the (new) `:latest`.

---

## 6. Join-Token Refresh

The join token is published to Secret Manager (`k8s-join-command`) with
`--ttl=0` (infinite cluster lifetime). It is refreshed automatically whenever
the control-plane startup script runs (i.e. every reboot). If you need to
refresh it manually:

```bash
gcloud compute ssh ubuntu@k8s-control-plane --zone=$ZONE \
    --ssh-key-file=$SSH_KEY --tunnel-through-iap --command='
        sudo kubeadm token create --print-join-command'
```

For security, rotate the CA hash if you suspect compromise (requires
regenerating all kubelet certs — overkill for this proof-of-concept).

---

## 7. Secrets Rotation

Secrets live in GCP Secret Manager. To rotate:

```bash
# Example: rotate the internal key
NEW_KEY="$(openssl rand -hex 32)"
echo -n "$NEW_KEY" | gcloud secrets versions add statusbus-internal-key \
    --data-file=- --project=$PROJECT_ID
```

After rotation, **restart the producer/consumer pods** (they read the env at
startup):

```bash
# On the control plane
sudo KUBECONFIG=/etc/kubernetes/admin.conf \
    kubectl -n statusbus-workloads rollout restart deployment statusbus-producer \
    deployment statusbus-consumer-india
```

---

## 8. Budget & Upstash Headroom

```bash
# Current GCP budget alerts (INR 2500, thresholds 60/90/100%)
# list existing budgets
gcloud billing budgets list --billing-account=01D8A7-0E84E2-ACFA0F --format=table(displayName,amount)

# Upstash Redis headroom (free tier: 500K commands/mo)
./gcp-infra/k8s/scripts/upstash-stats.sh   # uses bun + redis, shows total_cmds + est 30-day
```

---

## 9. Common Gotchas

| Symptom | Fix |
| --- | --- |
| **US consumer SSH fails** after VM recreation — `Permission denied (publickey)` | The instance lost its metadata `ssh-keys`. Re-inject: `gcloud compute instances add-metadata us-consumers-XXXXX --zone=us-central1-a --metadata=ssh-keys=ubuntu:$(cat /tmp/sbk8s/k8s-key.pub)` |
| **Worker pods stuck `ContainerCreating`** after scaling; no network between nodes | Calico IP-in-IP (protocol 4) is dropped by GCP. Patch the IPPool: `kubectl -n kube-system patch ippool default-ipv4-ippool --type=merge -p '{"spec":{"ipipMode":"Never","vxlanMode":"Always"}}'` then restart calico-node pods. The `control-plane.sh` bootstrap does this on init. |
| **Serial output is the only debug path** during bootstrap | SSH keys and kubeconfig don't exist yet. Always `gcloud compute instances get-serial-port-output ... --port=1`. Build bootstrap scripts around `log()` lines that appear in serial. |
| **MIG won't accept `instance-termination-action=DELETE`** | Spot VMs in a GCP MIG must use `--instance-termination-action=STOP`. This is a platform policy; the MIG still auto-repairs on preemption. |
| **Budget creation fails `INVALID_ARGUMENT`** | The billing account uses INR. Create with `--budget-amount=NNNN INR` (not USD). The `create-budget.sh` script handles this automatically. |

---

## Appendix: Relevant Script Paths

| Purpose | Path |
| --- | --- |
| Full cluster provision | `gcp-infra/k8s/create-vms.sh` |
| Control-plane bootstrap | `gcp-infra/k8s/bootstrap/control-plane.sh` |
| Worker bootstrap | `gcp-infra/k8s/bootstrap/worker.sh` |
| US consumer bootstrap | `gcp-infra/k8s/bootstrap/us-consumer.sh` |
| Cluster secrets (AR pull, SM env) | `gcp-infra/k8s/setup-cluster-secrets.sh` |
| Budget alert | `gcp-infra/k8s/create-budget.sh` |
| Upstash headroom | `gcp-infra/k8s/scripts/upstash-stats.sh` |
| Worker image build | `cloudbuild/statusbus-workers.yaml` |