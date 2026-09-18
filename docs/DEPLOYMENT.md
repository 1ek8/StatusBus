# StatusBus — Deployment & CI/CD

> Part of the StatusBus documentation set. Overview & quick start: [`../README.md`](../README.md)

The application runs on three deployment shapes:

1. **Live production (GCP, current)** — Cloud Run (API/FE) + Neon Postgres + Upstash Redis,
   with the **worker mesh** on a self-managed kubeadm cluster (India consumers) and a
   standalone spot VM (US consumer).
2. **Local (docker-compose)** — the full stack on one machine for development.
3. **Local Kubernetes (kind)** — cluster plus `kind-deploy/deploy.sh` bootstrap for testing
   the k8s manifests locally.

> **History:** an earlier internet deployment ran the whole stack on **GKE** (nginx ingress +
> cert-manager, Cloud SQL). That project was decommissioned; its manifests still live under
> `gcp-infra/` but target the dead account and are slated for removal. All live worker
> hosting now lives under `gcp-infra/k8s/` (see [`gcp-infra/k8s/README.md`](../gcp-infra/k8s/README.md)).

All apps are built with **Bun** (`oven/bun:1-slim` base images) and the images are made
from the repo root context (workspace layout is recreated inside the image so Bun's
lockfile + Prisma generation resolve correctly). The runtime `bun dist/index.js` runs the
bundled output.

## 1. Live Production (current)

```
   Cloudflare
      │  https://statusbus.byaniket.site        https://api-statusbus.byaniket.site
      ▼
 Cloud Run             (asia-south1)
   statusbus-fe ──────────▶ statusbus-api ──▶ Neon Postgres (ap-south-1, free tier)
         │                       ▲
         │   /monitoring/* (x-internal-key)   │  GET /monitoring/websites (producer, 5 min)
         ▼                       │            ▼
   kubeadm cluster (asia-south1-a)      Upstash Redis (ap-south-1, free tier)
   ├─ k8s-control-plane (on-demand) ▶ producer + XADD → stream statusbus:web
   └─ k8s-worker-1/2 (spot, MIG)     ▶ consumer REGION_ID=1 (x2, anti-affinity)
   us-consumers (spot MIG, us-central1-a) ▶ consumer REGION_ID=2 (docker, standalone)
```

| Layer | Where | Character |
| --- | --- | --- |
| FE + API | Cloud Run, `asia-south1` | always-on, behind Cloudflare; domain `statusbus.byaniket.site` / `api-statusbus.byaniket.site` |
| Database | **Neon** Postgres (`ap-south-1`) | free tier; connection URL in Secret Manager as `statusbus-db-url` |
| Redis | **Upstash** (`ap-south-1`) | free tier (500 K commands/mo, currently ~160 K est.); URL in Secret Manager as `statusbus-redis-url` |
| India consumers | kubeadm cluster `asia-south1-a` | control plane (on-demand, `e2-small`) + 2 spot workers (MIG), consumer group `1` |
| US consumer | standalone spot VM `us-central1-a` (MIG) | dockerized consumer, group `2`, `CONSUMER_ID` from container hostname |
| Secrets | GCP Secret Manager | `statusbus-db-url`, `statusbus-redis-url`, `statusbus-internal-key`, `k8s-join-command` (+ SM admin on the compute SA) |
| Cost guardrail | GCP budget | INR 2500 (~$30) on billing account, thresholds 60/90/100 %, default email alerts (`gcp-infra/k8s/create-budget.sh`) |

### Worker bring-up & ops

The worker mesh is the "infrastructure" half and is documented in its own readme:

- Bring-up, image build, secrets, workload applies: [`../gcp-infra/k8s/README.md`](../gcp-infra/k8s/README.md).
- Rationale (spot + bootstrap model, second-region strategy): [`docs/ARCHITECTURE-DECISIONS.md`](./ARCHITECTURE-DECISIONS.md).
- Day-2 procedures (node loss, disk reattach, image rebuild, join-token refresh):
  [`docs/RUNBOOK.md`](./RUNBOOK.md).

Cost baseline (as of the k8s rollout, `e2-small`, asia-south1 + us-central1):

| Resource | Model | ~$/mo |
| --- | --- | --- |
| k8s-control-plane | on-demand | ~15 |
| 2 workers | spot | ~8 |
| us-consumer | spot | ~4 |
| Upstash Redis | free tier | 0 |
| Neon | free tier | 0 |
| Cloud Run api/fe | as-used | ~1–2 |
| **Total** | | **~28–30** |

## 2. Local Development — docker-compose

`docker-compose.yml` at the repo root runs the whole stack. Required environment on the
host (see `.env.example`): `POSTGRES_USER`, `POSTGRES_PASSWORD`, `DATABASE_URL`,
`JWT_SECRET`.

```
$ cp .env.example .env   # fill in values
$ docker compose up --build
```

Services (in dependency order):

| Service | Image build | Ports | Env | Notes |
| --- | --- | --- | --- | --- |
| `postgres` | `postgres:15` | `5432` | `POSTGRES_DB=statusbus`, user/pass from env | named volume `postgres_data` |
| `redis` | `redis:7-alpine` | `6379` | — | named volume `redis_data` |
| `prisma-migrate` | `packages/store/Dockerfile.migrate` | — | `DATABASE_URL` | runs `bunx --bun prisma migrate deploy` from `/app/packages/store` (config auto-discovered); `depends_on: postgres` |
| `seed-region` | `packages/store/Dockerfile.seeder` | — | `DATABASE_URL` | runs `bun seedRegion.ts` (idempotent upsert of India/US regions); waits for `prisma-migrate` success |
| `api` | `apps/api/Dockerfile` | `3001` | `DATABASE_URL`, `JWT_SECRET`, `PORT=3001`, `HOST=0.0.0.0` | waits for `prisma-migrate` success; `restart: unless-stopped` |
| `fe` | `apps/fe/Dockerfile` | `3000` | build arg `NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:3001` | `restart: unless-stopped` |
| `producer` | `apps/producer/Dockerfile` | — | `REDIS_URL=redis://redis:6379`, `API_URL=http://api:3001` | waits for migrate + redis |
| `consumer` | `apps/consumer/Dockerfile` | — | `REDIS_URL`, `API_URL`, `REGION_ID=1`, `CONSUMER_ID=india-consumer-1` | waits for migrate + seed-region + redis |

Notes:

- `prisma-migrate` runs migrations; `seed-region` then upserts the `Region` rows (`1` =
  India, `2` = US) that the consumer (`REGION_ID=1`) and ticks depend on. Both must finish
  before the consumer starts. The seeder script lives at
  `packages/store/seedRegion.ts` and can also be run ad hoc:
  `DATABASE_URL=... bun run ./packages/store/seedRegion.ts`.
- The API image no longer copies any `.env` — all runtime configuration is injected as
  environment variables by Compose/Kubernetes.
- The API is reachable at `http://localhost:3001` (health: `GET /health`), FE at
  `http://localhost:3000`.
- Cadence defaults come from the apps themselves: producer `PRODUCER_INTERVAL_SEC=300`,
  consumer `CONSUMER_POLL_SEC=60` / `CONSUMER_RECLAIM_INTERVAL_SEC=300`.

## 3. Local Kubernetes — kind

Infra lives under `kind-deploy/`.

- `kind-cluster.yml` — 1 control-plane + 2 worker nodes.
- `infra-deployments.yaml` — Postgres + Redis Deployments and ClusterIP Services
  (`postgres-service`, `redis-service`), storage via `emptyDir` (ephemeral).
- `secrets.yaml` — `statusbus-secrets` secret with `database-url`, `jwt-secret`, `redis-url`.
- `jobs/` — `db-migrate.yaml` (runs `bunx --bun prisma migrate deploy` then
  `bun run seedRegion.ts` from `/app/packages/store`), `seed-region.yaml` (seed only).
- `deployments/` — api/fe/producer/consumer Deployments + Services. Images resolve to local
  tags such as `1ek8/statusbus-api:latest` (`imagePullPolicy: IfNotPresent`).

### Bootstrap

`kind-deploy/deploy.sh` automates the whole flow:

1. `kind create cluster --name kind-cluster --config kind-cluster.yml`
2. Apply `infra-deployments.yaml` → apply `secrets.yaml` → sleep 30 s.
3. Apply `jobs/db-migrate.yaml` → sleep 120 s → dump job logs.
4. Apply the four workload deployments → sleep 180 s.
5. `kubectl get pods`, check the FE service, and open two port-forwards in new terminals:
   - `kubectl port-forward service/fe-service 3000:3000`
   - `kubectl port-forward service/api-service 3001:3001`
6. Verify: `curl http://localhost:3001/health`.

Service wiring inside the cluster: `fe-service:3000` (NodePort), `api-service:3001`
(ClusterIP, `http://api-service:3001` used by workers), `postgres-service:5432`,
`redis-service:6379`.

> The migrate/seeder images set `WORKDIR /app/packages/store`, where Prisma 7
> auto-discovers `prisma.config.ts`; the seed script is `packages/store/seedRegion.ts`
> in the repo, so the job commands resolve without any `--config` flags or repo-relative
> paths.

## 4. CI/CD

Two pipelines push images; the *edge* apps deploy themselves, the *workers* are fetched
by the VMs' startup scripts at boot.

| Image | Trigger | Pipeline |
| --- | --- | --- |
| `statusbus-api` | push to `main` | Cloud Build trigger `statusbus-api-deploy` ([`cloudbuild/statusbus-api.yaml`](../cloudbuild/statusbus-api.yaml)) → Cloud Run |
| `statusbus-fe` | push to `main` | Cloud Build trigger `statusbus-fe-deploy` ([`cloudbuild/statusbus-fe.yaml`](../cloudbuild/statusbus-fe.yaml)) → Cloud Run |
| `producer` / `consumer` | manual | `gcloud builds submit --config cloudbuild/statusbus-workers.yaml .` — pushes `:latest` to Artifact Registry; re-provisioned VMs pull at boot |

Worker image tags are set in `gcp-infra/k8s/variables.env` (`CONSUMER_IMAGE`,
`PRODUCER_IMAGE`, `US_CONSUMER_IMAGE`) and baked into the VM bootstrap at
`create-vms.sh` time; after a rebuild, roll the MIGs (see
[`docs/RUNBOOK.md`](./RUNBOOK.md) §4).

> The older GitHub Actions pipeline (`deploy.yml`, `KUBE_CONFIG_DATA` secret) deployed the
> API to the decommissioned GKE cluster and is no longer used.

## 5. Build resources

| Image | Build context | Key steps |
| --- | --- | --- |
| `apps/api/Dockerfile` | repo root `apps/api` | `bun install --frozen-lockfile` → `bunx prisma generate --config=prisma.config.ts` → `bun run build` (bundles `dist/index.js`) → `bun dist/index.js` |
| `apps/producer/Dockerfile` | repo root `apps/producer` | same pattern → `bun dist/index.js` |
| `apps/consumer/Dockerfile` | repo root `apps/consumer` | same pattern → `bun dist/index.js`; bakes `REGION_ID` / `CONSUMER_ID` defaults |
| `apps/fe/Dockerfile` | repo root `apps/fe` | `bun install` → `bun run build --filter fe` (Turbopack) → `bun run start`; `NEXT_PUBLIC_BACKEND_URL` build arg |
| `packages/store/Dockerfile.migrate` | repo root `packages/store` | `bunx prisma generate` → `prisma migrate deploy` |
| `packages/store/Dockerfile.seeder` | repo root `packages/store` | region seed runner (`bun seedRegion.ts`) |

Prisma is generated with `binaryTargets = ["native", "linux-arm64-openssl-1.1.x"]`, and
images `apt-get install openssl` because the generated client needs it at runtime.

## 6. Known Issues & Future Work

### 6.1 Current bugs / gaps in the codebase

1. **No auth hardening** — JWTs are short-lived ([`DEVELOPMENT-CHALLENGES`](./DEVELOPMENT-CHALLENGES.md) §2) and internal
   endpoints are key-protected (§3), but there is no rate limiting on auth, no token
   revocation, and no pagination on `/websites`.
2. **Probe semantics are blunt** — a probe is `Up` iff `axios.get` resolves within **10 s**;
   DNS/TLS errors and slow-but-http sites all classify `Down`. No per-site intervals (global
   5 min cadence), no uptime-% analytics, no chart history beyond the latest tick.
3. **Consumer ack semantics** — batches are processed with `Promise.all`; a hung Redis/API
   write can leave a message pending until the next `XAUTOCLAIM` pass (5 min idle), which is
   the intended at-least-once tradeoff, not a bug per se.
4. **No observability** — logging is `console.*` (Pino deps present but unused); no metrics
   exporter, tracing, or error reporting (Sentry). Dashboards fetch once per mount; no
   polling/realtime.
5. **Single point of failure, documented** — one control plane and one US consumer VM. The
   former is on-demand, the latter spot; both self-heal (boot scripts), but neither is
   redundant. A 4-nines product would add on-demand workers (~+$20/mo).
6. **Cross-ocean image pulls** — worker images live in Artifact Registry `asia-south1`;
   the US consumer pulls ~1.3 GB trans-Pacific on every fresh boot (2–4 min of downtime).

### 6.2 Roadmap themes (from `todo.txt`)

- **Error handling & observability**: Pino structured logging, Prometheus/Grafana, Sentry on
  FE+BE.
- **Security**: rate-limit auth, input sanitization on URL input beyond current SSRF guards.
- **API**: OpenAPI docs, pagination, per-user rate limits.
- **Testing**: unit + integration + E2E as CI merge blockers.
- **Frontend**: loading/error states, mobile responsiveness, state management
  (Zustand/Redux).
- **Workers**: dead-letter queue, uptime-% metrics, per-website intervals.
- **Database**: indexes on `websiteId`, `userId`, `createdAt`; move `WebsiteTick` to a
  time-series store.
- **Scalability**: promote the US spot VM to a second tiny kubeadm cluster (Option B in
  `ARCHITECTURE-DECISIONS.md` §2.2); regional Redis (Upstash) for redundancy.