# StatusBus — Architecture Decisions & Learnings

*Decision log.* Records the *why* behind the infrastructure architecture, especially the
transition from the original internet deployment over to the current live Cloud Run setup
and onward toward a real Kubernetes deployment. Goal: when re-implementing the k8s target,
the rationale — and the mistakes that preceded it — are in the repo, not lost in a chat.

---

## 1. Decision: Spot workers + on-demand control plane, with self-healing bootstrap

**Status:** agreed; Phase 1–2 implemented and live (see §3).

**The plan in one paragraph.** The new k8s target is a self-managed kubeadm cluster where
the **control plane node is on-demand** (never reclaimed; holds etcd + apiserver) and the
**worker nodes are spot instances** that are fully re-provisioned automatically whenever
they are evicted. Recovery is built into the *infrastructure* (startup scripts), not into
the *documentation*.

### 1.1 The old problem — why "things went haywire" on resume

The original cluster struggled every time VMs were stopped/resumed. The root cause was not
"Kubernetes can't handle machines coming and going" — it was a cluster that had **no
automated provisioning anything**:

1. **Zero provisioning scripts existed.** Nothing in the repo (current tree or all 108
   commits) contained `kubeadm init`, `kubeadm join`, join tokens, CA hashes, instance
   creation, or startup scripts. Only `suspend`/`resume` and an SSH-tunnel script existed.
   Rebuilding a lost node was a fully manual, undocumented procedure.
2. **No kubeconfig was ever committed** — only a 0-byte `admin.conf` placeholder. The real
   one lived (and only existed) as the GitHub `KUBE_CONFIG_DATA` secret. Lose or rotate it
   and the entire toolchain breaks at once.
3. **Images were drift-prone** — `consumer:latest`, `api:latest`, and Calico installed from
   `quay.io/calico/node:master`. After days idle, "resume" could pull different behavior
   than whatever had worked before.
4. **Calico IPIP + BGP over single-zone nodes.** The deleted `calico.yaml` configured
   `CALICO_IPV4POOL_IPIP=Always`. After any node blip, IPIP tunnels and BGP peers
   re-establish with timing sensitivity, and iptables/CNI state can be left inconsistent →
   pods stuck `ContainerCreating`, nodes `NotReady`.
5. **Cluster-state rot was already happening.** The tombstone `tmp-ns.json` shows the
   `ngrok-operator` Namespace stuck in `Terminating` on a finalizer — evidence of
   Kubernetes state getting wedged in ways nobody had automation to resolve.
6. **One failure domain.** All nodes were in a single zone (`asia-south2-a`), with a
   **single control plane** and etcd on a plain VM. Any interruption was cluster-wide.

The critical fact this hides: `gcloud compute instances suspend`/`resume` is a **pause
button** (GCP freezes memory state like ACPI sleep; the same OS/processes/kernel resume).
That generally survives fine. **Spot is not suspend — it is a kill-and-delete:** when a
spot VM is reclaimed the machine is *terminated and its disk deleted*. The replacement is a
brand-new VM with a blank disk that must be installed and **joined with a token + CA hash**
from scratch. That is literally "reconfiguration from the very beginning", every time — and
with zero automation it was a manual disaster. The observation "spot can't work for k8s"
was correct *for the old architecture*; the real enemy was absent automation, not spot.

### 1.2 How the new design solves each of the six problems

| # | Old failure | New design |
| --- | --- | --- |
| 1 | No provisioning automation; node loss = manual rebuild | **Startup script** baked into the VM/instance template is now the source of truth: detect whether the control-plane persistent disk exists → `kubeadm init` on first boot only, otherwise `kubeadm join`. A reclaimed spot worker is replaced by a fresh VM that boots, runs the script, and joins itself in minutes. No manual anything. |
| 2 | kubeconfig only as an external secret; loss = total break | Join is driven by a **join token + CA hash held in Secret Manager**; kubeconfig for operators is regenerable from the control plane. No single secret is load-bearing for the cluster's survival. |
| 3 | Image/tag drift (`:latest`, `:master`) | **Every image pinned** to real tags — api, fe, producer, consumer, and Calico. No tag pulls ever. |
| 4 | CNI/IPIP state flakes on node blips | Self-healing node bootstrap re-establishes the CNI cleanly on a fresh boot; Calico pinned to a fixed version. (Node churn is the normal case, not the emergency.) |
| 5 | State rot with no tooling (stuck finalizer etc.) | Replacement machines are provisioned fresh from the startup script; no half-migrated state to heal. |
| 6 | Single zone, single control plane as the whole cluster | Worker sprawl is cheap and replaceable (spot). Failure of any one worker is absorbed; the **control plane is the only permanent piece** and stays on-demand. |

### 1.3 Non-negotiables

- **Control plane stays on-demand.** It holds etcd + apiserver; its loss takes the whole
  cluster down. Its data lives on a **persistent disk** that outlives any VM — a lost
  on-demand VM is replaced by reattaching the disk and letting the init script re-initiate
  from it.
- **The single producer runs on the reliable (on-demand) node**, not on a spot worker. If
  the producer is down, no new jobs reach the stream.
- **Consumers live on spot workers.** They already tolerate leaving-and-returning by design:
  the Redis stream uses **consumer groups + `XAUTOCLAIM`** (see
  `docs/DEVELOPMENT-CHALLENGES.md` §6). A reclaimed spot worker mid-job is the textbook case
  the re-claim mechanism recovers from. A 20-minute node gap = 20 minutes without probes
  from that region, which is an accepted trade for the price.

Honest caveat, stated once: StatusBus is an *uptime monitor*, and the risky component is the
monitoring compute itself. Spot + automation is the right trade for a demo/portfolio
deployment; a 4-nines product would demand on-demand workers (~+$20/mo).

---

## 2. Decision: no single cross-continent Kubernetes cluster (second region)

**Status:** agreed; we are **not** going to ask one control plane in Mumbai to manage a
worker in the US.

**Chosen approach:** a **standalone spot consumer VM in `us-central1`** running the consumer
with `REGION_ID=2` / `CONSUMER_ID=us-consumer-1`. It is not a Kubernetes node at all. The
repo's own (gitignored) deployment runbook already specified exactly this shape for the
"optional second-region probe" — this decision formalizes it.

### 2.1 Why a cross-continent worker join is specifically fragile

A k8s worker *can* technically join a control plane across the ocean. Doing so is fragile
for five independent reasons:

1. **Control plane reachability.** `kubeadm join` needs the apiserver reachable. The old
   control plane was only reachable through an **IAP SSH tunnel**
   (`kubectl_script.sh` → `127.0.0.1:6443`) — deliberately private. A US worker would force
   the apiserver onto the public internet (or a cross-region VPN/private link). Either way:
   money + attack surface.
2. **Kubelet heartbeats are time-fragile.** A kubelet renews its node lease every ~10 s and
   the API server declares a node `NotReady` (starting pod eviction) after ~40 s of
   unresponsiveness. Mumbai↔Iowa is **150–250 ms RTT**, so every heartbeat and API call
   eats a meaningful slice of those windows. One bout of packet loss (common on public,
   cross-continent paths) = the US node gets evicted-pod replanned onto Mumbai nodes —
   probing from the wrong region again. The purpose of the US node silently fails.
3. **CNI is a second fragile system across the WAN.** Calico's `IPIP=Always` tunnels
   pod-to-pod traffic between nodes. Across continents that is encapsulated traffic over the
   public internet with MTU/overhead issues — plus the CNI control plane (BGP peering +
   apiserver-backed `calico-node`) depends on the same heartbeats as reason 2.
4. **Tight coupling — the single point of failure is on the other continent.** A US k8s node
   whose control plane lives in Mumbai dies whenever the Mumbai cluster hiccups (node
   `NotReady`, cert renewals, maintenance). It couples the US probe's fate to India's
   uptime — the opposite of the resilience the distributed design intends.
5. **It doesn't even save money.** Joining still requires the apiserver reachable/secured
   and bootstrap certs issued. Once that work is done, provisioning a tiny on-demand
   control-plane VM in Iowa (or just a plain consumer VM) costs about the same with far
   less fragility.

### 2.2 The two workable options for true second-region probing

| Option | Shape | US-side cost | Notes |
| --- | --- | --- | --- |
| **A — chosen** | Standalone dockerized consumer VM in `us-central1`, `REGION_ID=2`, reading the **same Upstash stream** | ~$4/mo spot / ~$15 on-demand | Genuinely US vantage (`us-central1`); zero Kubernetes in the US; the consumer is exactly the component built to survive node loss (consumer groups + `XAUTOCLAIM`). |
| B | A **second tiny kubeadm cluster** in Iowa (on-demand control plane + spot worker) running the same consumer Deployment | ~$20–25/mo | Full Kubernetes in both regions; independent control planes so there is no cross-continent coupling; app-layer fan-out via Redis consumer groups still makes them behave as one mesh. |

**Convertible:** Option A can be promoted to Option B later (a second control plane in the
US) if/when the architecture is asked to be a fully-Kubernetes multi-region story. For now,
A is the plan.

### 2.3 Second-region data plane notes

- **Redis is on Upstash (free tier) and is single-region.** One region holds the stream; the
  other region reads it. Mumbai↔Iowa is ~150–250 ms RTT **per poll**, which is invisible at
  a 60 s cadence. Likely pick: stream hosted in India so the primary (India) side is fast and
  the US side reads across the ocean.
- **Each region's consumer uses its own consumer group** (`REGION_ID=1` / `2`), so *every*
  event fans out to both regions independently — the distributed design works exactly as
  documented in `docs/ARCHITECTURE.md` and `docs/WORKFLOW.md`.
- **DB region re-evaluation.** With a US consumer also writing ticks, moving Neon from
  `us-east-2` to `ap-south-1` is no longer obviously a win — the US node would then write
  ticks cross-continent. Tick volume is tiny either way; decide with real latency numbers
  during implementation.
- **Real probing means physical location.** A `REGION_ID=2` consumer sitting on the Mumbai
  cluster would write ticks *labeled* "US" from a Mumbai machine. "Region" is a physical
  fact, not a config flag: the probe must originate from a US data center.

---

## 3. Phase 2 execution — implementation issues and learnings

**Status:** implemented and live (cluster running, self-healing proven).

Phase 1 committed the bootstrap scripts and image builds. Phase 2 was the real bring-up
of the kubeadm cluster: control plane, worker MIG, join, and chaos-test verification. The
core problem was that none of these scripts had been tested on actual VMs — every bug
appeared the moment they hit a real GCP Ubuntu image.

### 3.1 Process

1. Created the control plane VM (`k8s-control-plane`, on-demand, `asia-south1-a`, `e2-small`)
   with the startup script attached via `--metadata-from-file`.
2. Polled Secret Manager for `k8s-join-command` (the signal that `kubeadm init` finished
   and published the token). Timed out after 12 minutes.
3. Pulled serial output via `gcloud compute instances get-serial-port-output` — found the
   startup script failed before kubeadm ever ran. Root-caused, fixed the script, deleted
   the VM + boot disk (`--delete-disks=all`), recreated from scratch.
4. Repeat. Total: 3 full boot cycles before the control plane came up clean.
5. Once the join command appeared, created `k8s-worker-template` (spot, `e2-small`) +
   `k8s-workers` MIG (size 2). Workers booted, installed packages, and then entered a
   retry loop: "join command not published yet" × 30. Root cause: `sm_get` sed parsing
   was silently returning empty because Secret Manager returns pretty-printed JSON.
6. Recreated workers with the fixed script (via MIG rolling replace), nodes joined,
   Calico brought them to Ready. Verified 3/3 nodes, all kube-system pods Running.
7. Ran the chaos test: `gcloud compute instances delete k8s-workers-db9m` → MIG
   detected the loss, `CREATING` appeared immediately, replacement booted, joined,
   Ready within 3 minutes. Cluster back to 3/3.

### 3.2 Bugs discovered

**Bug 1: `/etc/containerd/config.toml` directory missing**

The base `ubuntu-2204-lts` GCP image ships containerd as a binary package but does not
create `/etc/containerd/`. The script's `containerd config default > /etc/containerd/config.toml`
failed immediately with "No such file or directory", and `set -e` killed the entire startup
script before kubeadm init ever ran.

*Fix:* `mkdir -p /etc/containerd` before the redirect. Applied identically to both
`control-plane.sh` and `worker.sh`.

**Bug 2: `br_netfilter` kernel module not loaded**

After fixing Bug 1 and rerunning, `kubeadm init` failed at preflight:
`/proc/sys/net/bridge/bridge-nf-call-iptables does not exist`. The kernel module `br_netfilter`
was never loaded, so the sysctl the script wrote to `/etc/sysctl.d/k8s.conf` had nothing to
apply against. (The module needs an explicit `modprobe`; it does not auto-load on this
image.)

*Fix:* `echo br_netfilter > /etc/modules-load.d/k8s.conf` + `modprobe br_netfilter` before
`sysctl --system`. The `modules-load.d` entry persists across reboots.

**Bug 3: Secret Manager pretty-printed JSON breaks `sm_get`**

This was the worker-join blocker. The `sm_get` sed pattern in all three bootstrap scripts
was:

```bash
sed -n 's/.*"payload":{"data":"\([^"]*\)".*/\1/p' | base64 -d
```

The Secret Manager REST API actually returns:

```json
{
  "name": "projects/.../secrets/.../versions/latest",
  "payload": {
    "data": "base64...",
    "dataCrc32c": "..."
  }
}
```

The multi-line format means the regex `"payload":{"data":"..."` never matches a single
line — so `sm_get` returns empty, the retry loop exhausts, and the script exits. The
control plane never hit this because it only *writes* secrets (`sm_set`); workers only
*read* via `sm_get`. Identical code, opposite direction, completely different failure
mode.

*Fix:* whitespace-tolerant sed + `head -1`:

```bash
sed -n 's/.*"data"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | base64 -d | head -1
```

Applied to all three scripts (`control-plane.sh`, `worker.sh`, `us-consumer.sh`).

### 3.3 GCP platform constraints

Three GCP-specific constraints that took repeated cycles to discover:

**Constraint 1: Spot instances in MIGs require `instance-termination-action=STOP`**

Trying to create an instance template with `--provisioning-model=SPOT --instance-termination-action=DELETE`
for use in a managed instance group produces:

> *"Spot virtual machines with termination action set to DELETE cannot be used with Managed
Instance Groups."*

This is a GCP policy: MIGs with spot VMs must use STOP. The self-healing story is preserved —
when a spot VM is preempted, the instance enters TERMINATED state, the MIG detects the
state change and recreates it from the template (per GCP docs: *"MIGs always attempt to
maintain their target size... the group repeatedly tries to recreate those VMs"*). The
chaos test (manual instance delete) also confirms MIG recreation works.

**Constraint 2: Instance templates need full regional subnet URLs**

Global instance templates cannot reference a subnet by bare name (`default`) — the template
doesn't know which region's "default" subnet to use:

> *"Scope of the specified subnetwork doesn't match the scope of the instance."*

*Fix:* pass the full URL:
`https://www.googleapis.com/compute/v1/projects/$PROJECT_ID/regions/asia-south1/subnetworks/default`

**Constraint 3: MIG instance templates are pinned — update requires a new name**

A global instance template referenced by a MIG cannot be deleted or replaced in place.
Attempting to `delete k8s-worker-template` while the MIG references it fails with
*"already being used by instanceGroupManagers"*. Worse: deleting and recreating with
the *same name* produces a new resource object, but the MIG still holds a reference to
the original — the old startup script keeps running until you explicitly call
`set-instance-template` to switch and trigger a rolling replace.

*Fix:* create `k8s-worker-template-v2`, `set-instance-template` → v2, rolling replace,
then delete the stale v1.

### 3.4 Debug interface

The serial console (`gcloud compute instances get-serial-port-output --port=1`) was the
primary debug interface throughout — not SSH. This was unplanned but became the only
reliable way to diagnose startup script failures before the control plane existed and
before SSH keys were injected. Every bug above was root-caused via serial output grep,
not via an SSH session. Build scripts around `log()` output that survives serial; do not
assume you can SSH in during bootstrap.

---

## 4. Learnings extracted (one-liners)

1. **Recovery must live in the infrastructure**, not in the README. If node replacement has
   no provisioning automation, it doesn't work — spot simply makes that obvious.
2. **Suspend/resume ≠ spot eviction.** Suspend is a pause; spot is a delete-and-recreate.
   Plan for destroy/recreate, and it stops being scary.
3. **The control plane is the only thing that must never be reclaimed.** Everything else may
   be disposable.
4. **Don't stretch a Kubernetes control plane across a continent for the sake of topology.**
   Application-level fan-out over a shared queue delivers the behavior with a fraction of the
   fragility and cost.
5. **Pin everything.** Tag drift is a silent deploy-time killer.
6. **Probe from where you claim to probe.** Region labels must match physical location or the
   dashboard lies.
7. **Serial console first, SSH second.** On a fresh VM where SSH keys aren't injected and
   kubeconfig doesn't exist yet, the serial console is the only debug path. Build startup
   scripts around `log()` output that survives serial, not around commands that need a
   shell session.
8. **Secret Manager returns pretty-printed JSON.** A `sed` regex that assumes compact
   JSON (`"payload":{"data":"..."`) will silently fail against the real API response.
   Always parse with whitespace tolerance (`[[:space:]]*`) or use a tool that handles
   formatting.
9. **Write-path success ≠ read-path success.** A secret-publishing script (write) doesn't
   exercise the read format. `sm_set` succeeded on the control plane; `sm_get` — same
   data, opposite direction — returned empty on workers. Always test both sides.
10. **Instance templates are names, not objects.** Deleting and recreating a template with
    the same name does *not* update the MIG — the MIG holds a reference to the resource
    object, not the name. Create a new name and switch the MIG explicitly via
    `set-instance-template`.
11. **MIGs + spot in GCP: STOP, not DELETE.** Spot VMs in a managed instance group cannot
    use `instance-termination-action=DELETE`. The MIG still auto-repairs on preemption
    (instance enters TERMINATED → MIG recreates), but the termination action must be STOP.
12. **GCP global templates need full regional subnet URLs.** A bare `subnet=default`
    reference resolves to the wrong region and fails with a scope mismatch. Pass the full
    resource URL.

---

## Repo pointers

- `gcp-infra/k8s/bootstrap/` — the startup scripts whose bugs and fixes are documented
  in §3: `control-plane.sh`, `worker.sh`, `us-consumer.sh`.
- `gcp-infra/k8s/create-vms.sh` — the orchestration script (control plane + worker MIG +
  US consumer MIG); includes the regional subnet URL fix and STOP termination action.
- `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md` — design + flow docs this decision log refines.
- `docs/DEVELOPMENT-CHALLENGES.md` — the engineer-facing bug/fix history (consumer-group +
  `XAUTOCLAIM` specifics, monitoring endpoint security, SSRF protection, Redis stream
  hardening).
- `packages/redisq/index.ts` — stream/group/`XAUTOCLAIM` implementation.
- `apps/producer/index.ts`, `apps/consumer/index.ts` — workers that now run on the live
  spot nodes (cadence env vars `PRODUCER_INTERVAL_SEC`, `CONSUMER_POLL_SEC`,
  `CONSUMER_RECLAIM_INTERVAL_SEC`).