# StatusBus — kubeadm deployment (Cloud: self-managed Kubernetes)

> Part of the StatusBus docs. Architecture rationale is in
> [`docs/ARCHITECTURE-DECISIONS.md`](../../docs/ARCHITECTURE-DECISIONS.md).

This is the active deployment for StatusBus worker infrastructure.
It replaces the legacy `gcp-infra/*.yaml` manifests (which targeted the
decommissioned project). The live public edge stays on Cloud Run
(`statusbus-api` / `statusbus-fe`); this cluster runs **only the
workers** (producer + India consumer) plus a standalone spot VM for the US
consumer.

```
             Cloud Run (asia-south1)                 kubeadm cluster (asia-south1-a)
  users ─▶ FE/API ───────┐                          ┌─ k8s-control-plane (on-demand, producer)
                         │  /monitoring/*           └─ k8s-worker-1/2 (spot, consumer REGION_ID=1)
                         ▼
                    Neon Postgres                   Upstash Redis (ap-south-1)  ◀──── us-consumer (spot, us-central1-a)
```

## Order of operations

1. `cp variables.env.example variables.env` and set `SUBNET` / tag to taste.
2. Enable APIs (one-time):
   ```bash
   gcloud services enable compute.googleapis.com container.googleapis.com
   ```
   Grant the default compute SA Secret Manager access (the startup scripts
   read `statusbus-redis-url` / `statusbus-internal-key` / `k8s-join-command`
   from Secret Manager):
   ```bash
   gcloud projects add-iam-policy-binding $PROJECT_ID \
     --member="serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
     --role=roles/secretmanager.admin
   ```
3. Build + push the worker images (from repo root):
   ```bash
   gcloud builds submit --config ../../cloudbuild/statusbus-workers.yaml .
   ```
4. Provision everything:
   ```bash
   ./create-vms.sh
   ```
5. After the control plane finishes `kubeadm init` (a few minutes), the spot
   workers auto-join from the join command published to Secret Manager, and
   the `us-consumer` container starts probing from us-central1.

## Applying the worker workloads

```bash
# one-time: Artifact Registry pull secret + worker env secrets + namespace
./setup-cluster-secrets.sh

# producer (control plane) + India consumers (anti-affinity across spot workers)
{ cat manifests/producer.yaml; printf '\n---\n'; cat manifests/india-consumer.yaml; } \
  | gcloud compute ssh k8s-control-plane --zone=asia-south1-a --tunnel-through-iap \
      --command='sudo KUBECONFIG=/etc/kubernetes/admin.conf kubectl apply -f -'
```

The control-plane bootstrap switches Calico from IP-in-IP to **VXLAN**: GCP drops
IP-in-IP (protocol 4), so without the patch pods on different nodes cannot reach
each other (worker → CoreDNS times out). VXLAN uses `udp/4789`, which the
`allow-k8s-internal` firewall rule permits.

## Self-healing model

- **Control plane:** on-demand, etcd/apiserver on a persistent boot disk. If
  the VM is ever recreated, reattach the disk — the bootstrap skips init
  (`/etc/kubernetes/kubelet.conf` present) and only refreshes the join token.
- **Workers:** spot (`--provisioning-model=SPOT`). Spot VMs in a MIG must use
  `--instance-termination-action=STOP` (DELETE is rejected by GCP for MIGs).
  On preemption the instance enters TERMINATED state and the MIG recreates it
  from the template; the startup script installs the runtime and re-joins via
  the Secret Manager join command. Tokens are created with `--ttl=0`
  (cluster-lifetime).
- **US consumer:** spot MIG in us-central1-a; the container respawns after
  eviction, picking up where consumer-group `2` left off (Redis `XAUTOCLAIM`
  recovers in-flight probes).

> Background on the GCP constraints hit during bring-up (pretty-printed Secret
> Manager JSON, `br_netfilter`, `/etc/containerd`, template pinning): see
> [`docs/ARCHITECTURE-DECISIONS.md`](../../docs/ARCHITECTURE-DECISIONS.md) §3.

## Verification

```bash
# nodes healthy
gcloud compute ssh k8s-control-plane --zone=asia-south1-a --tunnel-through-iap \
    -- -N -L 8443:127.0.0.1:6443
# then, from a second shell with KUBECONFIG pointed at admin.conf:
kubectl get nodes
kubectl get pods -A
```

- Ticks from both regions land in Neon; API keys: `region_id=1` (India) and
  `region_id=2` (US).
- Spot test: delete a worker (`gcloud compute instances delete k8s-worker-…`)
  and confirm the group creates a replacement that rejoins Ready.

## Cost baseline (e2-small, asia-south1 + us-central1)

| Resource | Model | ~$/mo |
| --- | --- | --- |
| k8s-control-plane | on-demand | ~15 |
| 2 workers | spot | ~8 |
| us-consumer | spot | ~4 |
| Upstash Redis | free tier | 0 |
| Neon | free tier | 0 |
| Cloud Run api/fe | as-used | ~1–2 |
| **Total** | | **~28–30** |