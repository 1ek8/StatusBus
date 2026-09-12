# StatusBus — Architecture Decisions & Learnings

*Decision log.* Records the *why* behind the infrastructure architecture, especially the
transition from the original internet deployment over to the current live Cloud Run setup
and onward toward a real Kubernetes deployment. Goal: when re-implementing the k8s target,
the rationale — and the mistakes that preceded it — are in the repo, not lost in a chat.

---

## 1. Decision: Spot workers + on-demand control plane, with self-healing bootstrap

**Status:** agreed; implementation planned (not yet built).

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

## 3. Learnings extracted (one-liners)

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

---

## Repo pointers

- `gcp-infra/` — legacy manifests + suspend/resume/tunnel scripts (the old model, kept as
  reference; a fresh reimplementation is planned).
- `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md` — design + flow docs this decision log refines.
- `docs/DEVELOPMENT-CHALLENGES.md` — the engineer-facing bug/fix history (consumer-group +
  `XAUTOCLAIM` specifics referenced above).
- `packages/redisq/index.ts` — stream/group/`XAUTOCLAIM` implementation.
- `apps/producer/index.ts`, `apps/consumer/index.ts` — workers that will run on the planned
  spot nodes.