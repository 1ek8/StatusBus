# StatusBus — Deployment & CI/CD

> Part of the StatusBus documentation set. Overview & quick start: [`../README.md`](../README.md)

Three deployment targets exist:

1. **Local (docker-compose)** — full stack on one machine for development.
2. **Local Kubernetes (kind)** — cluster plus `deploy.sh` bootstrap for testing the k8s
   manifests locally.
3. **GCP (GKE)** — the production target: Kubernetes cluster, Artifact Registry images,
   ingress + cert-manager for TLS, CI/CD pipeline.

> **Deployment status:** the app is currently exercised locally (docker-compose and kind).
> The GCP section below describes the intended production layout and the manifests used for
> it; production provisioning is a planned step (the prior cluster has been decommissioned
> and will be re-provisioned on a fresh account when internet deployment resumes).

All apps are built with **Bun** (`oven/bun:1-slim` base images) and the images are made
from the repo root context (workspace layout is recreated inside the image so Bun's
lockfile + Prisma generation resolve correctly). The runtime `bun dist/index.js` runs the
bundled output.

## 1. Local Development — docker-compose

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
| `prisma-migrate` | `packages/store/Dockerfile.migrate` | — | `DATABASE_URL` | runs `bunx prisma migrate deploy --config=prisma.config.ts`; `depends_on: postgres` |
| `api` | `apps/api/Dockerfile` | `3001` | `DATABASE_URL`, `JWT_SECRET`, `PORT=3001`, `HOST=0.0.0.0` | waits for `prisma-migrate` success; `restart: unless-stopped` |
| `fe` | `apps/fe/Dockerfile` | `3000` | build arg `NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:3001` | `restart: unless-stopped` |
| `producer` | `apps/producer/Dockerfile` | — | `REDIS_URL=redis://redis:6379`, `API_URL=http://api:3001` | waits for migrate + redis |
| `consumer` | `apps/consumer/Dockerfile` | — | `REDIS_URL`, `API_URL`, `REGION_ID=1`, `CONSUMER_ID=india-consumer-1` | waits for migrate + redis |

Notes:

- `prisma-migrate` runs migrations but **not** the region seed. The consumer starts with
  `REGION_ID=1`; for real testing the `Region` row id `1` must exist. Run the seeder:
  `bun run ./apps/api/seedRegion.ts` (from a workspace with `DATABASE_URL` set).
- The API Dockerfile copies `apps/api/.env` into the image as env — the image embeds local
  dev values. This is only acceptable for local use (see Known Issues).
- The API is reachable at `http://localhost:3001` (health: `GET /health`), FE at
  `http://localhost:3000`.

## 2. Local Kubernetes — kind

Infra lives under `kind-deploy/`.

- `kind-cluster.yml` — 1 control-plane + 2 worker nodes.
- `infra-deployments.yaml` — Postgres + Redis Deployments and ClusterIP Services
  (`postgres-service`, `redis-service`), storage via `emptyDir` (ephemeral).
- `secrets.yaml` — `statusbus-secrets` secret with `database-url`, `jwt-secret`, `redis-url`.
- `jobs/` — `db-migrate.yaml` (runs `bunx prisma migrate deploy --config=prisma.config.ts`
  then `bun run ./packages/store/seedRegion.ts`), `seed-region.yaml` (seed only).
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

> The db-migrate job reference to `./packages/store/seedRegion.ts` relies on the image
> layout produced by `packages/store/Dockerfile.seeder`; today the seed source actually
> lives at `apps/api/seedRegion.ts` (see Known Issues #8).

## 3. GCP Deployment (production target)

Cluster topology (as used for the original rollout):

- **Region / zone**: `asia-south2` / `asia-south2-a`.
- **Compute**: 3 GCE VMs — `k8s-control-plane`, `k8s-worker-1`, `k8s-worker-2` — running GKE
  (kubeadm/self-managed-style; kubectl is tunneled through IAP rather than a managed
  endpoint).
- **Database**: Cloud SQL Postgres instance `statusbus-postgres`, accessed via
  `cloud-sql-proxy` **sidecars** on `127.0.0.1:5432` inside each workload pod.
- **Redis**: external Redis at an internal IP (`10.5.54.3:6379` in the last known config).
- **Artifact Registry**: image repo `asia-south2-docker.pkg.dev/<project>/statusbus-repo`,
  auth via the `gcp-artifact-registry-key` imagePullSecret.
- **Ingress**: nginx ingress controller + cert-manager (Let's Encrypt prod, HTTP-01) issuing
  `statusbus-tls-cert` for `statusbus.byaniket.online` and `api.statusbus.byaniket.online`.
- **IAP**: SSH to the control plane is restricted to Google's IAP ranges (`35.235.240.0/20`)
  and GCP health-checkers (Calico `GlobalNetworkPolicy` in `allow-iap-ssh.yaml`).

### 3.1 Reference configuration

`gcp-infra/gcp-config.env.example` is the sanitized template:

```
PROJECT_ID=statusbus-prod-123456
PROJECT_NUMBER=987654321234
REGION=us-central1
CONNECTION_NAME=statusbus-prod-123456:us-central1:statusbus-postgres
DB_INSTANCE=statusbus-postgres
DB_NAME=statusbus
DB_PASSWORD=<your-secure-password>
REDIS_HOST=<your-redis-ip>
REDIS_PORT=6379
JWT_SECRET=<your-jwt-secret>
ARTIFACT_REGISTRY=us-central1-docker.pkg.dev/statusbus-prod-123456/statusbus-repo
```

> The real `gcp-infra/gcp-config.env` (with live `DATABASE_URL` / `JWT_SECRET` values) is
> **gitignored** — only the sanitized `.example` is tracked. Keep it that way: never commit
> real credentials; in production source secrets from a secrets manager / Kubernetes
> Secrets instead.

### 3.2 Workload manifests

- `api-deployment.yaml` — API Deployment (1 replica, port 3001) + `cloud-sql-proxy`
  sidecar; liveness/readiness probes on `/health` (15 s/20 s and 5 s/10 s).
  `DATABASE_URL` uses env substitution:
  `postgresql://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@127.0.0.1:5432/statusbus?schema=public`.
  Proxy auth from `/secrets/key.json` mounted from the `gcp-cloudsql-key` secret.
- `consumer-deployment.yaml` — 2 replicas; secrets `statusbus-postgres-credentials` +
  `statusbus-redis-connection` via `envFrom`; `REGION_ID=1`, `CONSUMER_ID=india-consumer-1`;
  cloud-sql-proxy sidecar.
- `producer-deployment.yaml` — 1 replica; same secret wiring (no region vars); sidecar.
- `fe-deployment.yaml` — 1 replica, port 3000; `NEXT_PUBLIC_BACKEND_URL=https://api.statusbus.byaniket.online`.
- `internal-service.yaml` — `api-service` (ClusterIP 3001) and `fe-service` (ClusterIP 3000).
- `external-service.yaml` — `fe-external-service` NodePort (nodePort 30080) for direct access.
- `ingress-rules.yaml` — `statusbus-ingress` (nginx class): TLS via `statusbus-tls-cert`,
  `statusbus.byaniket.online` → `fe-service:3000`, `api.statusbus.byaniket.online` →
  `api-service:3001`; CORS annotations. `ingress-resource.yaml` is an earlier draft for the
  root domain `byaniket.online`.
- `cert-manager.yaml` — `letsencrypt-prod` ClusterIssuer (ACME HTTP-01, nginx class).
- `allow-iap-ssh.yaml` — Calico policy (SSH-in only from IAP + health checkers; allow all egress).

### 3.3 Manual setup steps (one-time)

1. **GCP project & auth** — enable required APIs; create the Cloud SQL instance
   (`statusbus-postgres`) and an external Redis instance; note `CONNECTION_NAME` and
   `REDIS_HOST`.
2. **Artifact Registry** — create repo `statusbus-repo`; store the service-account key that
   can push (e.g. `artifact-reader-key.json`).
3. **Cluster + tunnel** — boot the VMs (`gcloud compute instances start`), then tunnel to
   the API server through IAP:
   ```bash
   gcloud compute ssh k8s-control-plane --zone asia-south2-a --tunnel-through-iap \
       -- -N -L 8443:127.0.0.1:6443
   ```
   Point kubectl at `https://127.0.0.1:8443`.
4. **Kubernetes secrets** (must exist before deployments):
   - `statusbus-secrets` / env secrets: `database-url`, `jwt-secret`, `redis-url`
     (kind: `kind-deploy/secrets.yaml`; GCP: `statusbus-postgres-credentials`,
     `statusbus-redis-connection`).
   - `gcp-cloudsql-key` — service-account key for Cloud SQL proxy (`cloudsql-key.json`),
     mounted at `/secrets/key.json`.
   - `gcp-artifact-registry-key` — docker-registry imagePullSecret for `gcp-artifact-registry-key`.
   - `statusbus-tls-cert` — created automatically by cert-manager once the Ingress is applied.
5. **Ingress controller** — install nginx ingress; apply `ingress-service.yaml`
   (LoadBalancer on 80/443); cert-manager via `cert-manager.yaml`, then `ingress-rules.yaml`.
6. **Deploy** — apply internal services → deployments → ingress.
7. **DNS** — point `statusbus.byaniket.online` and `api.statusbus.byaniket.online` at the
   ingress LoadBalancer IP (or use external DNS provider records).

### 3.4 Day-2 operations

- **Start / stop** (cost control) — `gcp-infra/gcloud-start.sh` resumes the 3 VMs and sets
  Cloud SQL `--activation-policy=ALWAYS`; `gcloud-stop.sh` suspends them and sets
  `--activation-policy=NEVER`.
- **Access** — `kubectl_script.sh` re-opens the IAP SSH tunnel when needed.
- **Redeploy a new API image** — see CI/CD below.

## 4. CI/CD

`.github/workflows/deploy.yml` runs on push to `main`/`master` and on `workflow_dispatch`.

| Job | Purpose |
| --- | --- |
| `detect-change` | Compares `HEAD` vs `HEAD^`; sets output `api=true` if `apps/api/` or `packages/` changed. |
| `checkout-and-list` | Reference job (log output for debugging). |
| `build-and-push-api` | Runs only if `detect-change.api == 'true'`. Auth to GCP (`GCP_SA_KEY`), `gcloud auth configure-docker`, `docker buildx build --platform=linux/amd64` from `apps/api/Dockerfile`, pushes `:<sha>` + `:latest` to Artifact Registry. Then writes the kubeconfig from `KUBE_CONFIG_DATA` and runs `kubectl set image deployment/api-deployment api=<image>:<sha>` + `kubectl rollout status`. |

Required GitHub secrets: `GCP_PROJECT_ID`, `ARTIFACT_REGISTRY_LOCATION`,
`GCP_SA_KEY`, `KUBE_CONFIG_DATA`. Env (`deploy.yml`): `REPOSITORY=statusbus-repo`,
`SERVICE_NAME=api`.

Notes:
- Only the **api** image is currently built/deployed by CI. The fe/producer/consumer images
  are expected to keep coming from the `:latest` tags pinned in GCP manifests.
- `detect-change` keys off `apps/api/` and `packages/` (any package change rebuilds api), so
  a `packages/store` schema change triggers an API rebuild.

## 5. Build resources

| Image | Build context | Key steps |
| --- | --- | --- |
| `apps/api/Dockerfile` | repo root `apps/api` | `bun install --frozen-lockfile` → `bunx prisma generate --config=prisma.config.ts` → `bun run build` (bundles `dist/index.js`) → `bun dist/index.js` |
| `apps/producer/Dockerfile` | repo root `apps/producer` | same pattern → `bun dist/index.js` |
| `apps/consumer/Dockerfile` | repo root `apps/consumer` | same pattern → `bun dist/index.js`; bakes `REGION_ID` / `CONSUMER_ID` defaults |
| `apps/fe/Dockerfile` | repo root `apps/fe` | `bun install` → `bun run build --filter fe` (Turbopack) → `bun run start`; `NEXT_PUBLIC_BACKEND_URL` build arg |
| `packages/store/Dockerfile.migrate` | repo root `packages/store` | `bunx prisma generate` → `prisma migrate deploy` |
| `packages/store/Dockerfile.seeder` | repo root `packages/store` | region seed runner (see Known Issues #8) |

Prisma is generated with `binaryTargets = ["native", "linux-arm64-openssl-1.1.x"]`, and
images `apt-get install openssl` because the generated client needs it at runtime.

## 6. Known Issues & Future Work

### 6.1 Current bugs / gaps in the codebase

1. **Passwords stored in plaintext** — signup stores the password verbatim; signin compares
   plaintext. Must use `bcrypt`/`argon2`.
2. **Credential-less sign-in** — `POST /user/signin` does `findFirst` and signs a JWT with
   `user?.id`. A username/password that matches nothing still gets a `200 { jwt }` (with
   `sub: undefined`), so sign-in effectively never fails. (todo.txt)
3. **No auth hardening** — JWT has no expiry; `Authorization` header is parsed verbatim with
   no `Bearer` prefix support; internal endpoints `/monitoring/websites` and
   `/monitoring/tick` are unauthenticated (any caller can push ticks); no SQL-injection
   sanitization on website URLs (todo.txt).
4. **Worker gaps** — probe has **no HTTP timeout** (hung sites wedge & stay unacked forever);
   Redis stream is **never trimmed** (unbounded growth); dropped producer fields
   (`user_id`, `timestamp`); no `XAUTOCLAIM`/dead-letter queue for stuck/failing sites; no
   per-website monitor intervals (global 60 s only); consumer error loop has no backoff
   (todo.txt).
5. **No observability** — `pino`/`pino-pretty` installed but unused; logging is `console.*`;
   no Prometheus/Grafana probes, no Sentry, no OpenAPI/Swagger docs, no pagination on
   `/websites` / `/status/:websiteId` (todo.txt).
6. **Missing testing/UI** — no unit/integration/E2E gates in CI; no loading states, error
   boundaries, mobile responsiveness, or global state management; per-website page is a
   placeholder; edit/delete are stubs; dashboard has no polling/charts (todo.txt + FE review).
7. **Not-implemented product features** — notifications (email/push/Slack/Discord), SLA /
   uptime-% analytics & export, pro/free plans with per-site intervals (as low as 1 m),
   team access, audit logs, Redis cluster, synthetic browser checks (todo.txt).
8. **Infra footguns** —
   - `packages/store/Dockerfile.seeder` copies `packages/store/seedRegion.ts`, but the real
     seed script is `apps/api/seedRegion.ts`; the k8s jobs run `./packages/store/seedRegion.ts`.
   - `gcp-infra/gcp-config.env` holds live credentials — it and the service-account keys
     (`cloudsql-key.json`, `artifact-reader-key.json`, `github-actions-key.json`) are
     **gitignored**; never commit them. Only the sanitized `.example` is tracked.
   - `api-deployment.yaml` (GCP) lacks the `imagePullSecrets`/volumes that the other GCP
     manifests carry; `fe-deployment.yaml` declares but never mounts its cloudsql volume.
   - Root `generated/client/` is a stale leftover of an earlier `prisma generate` cwd.
9. **Time-series DB not implemented** — `WebsiteTick` lives in Postgres; no Timescale/Influx
   layer yet.

### 6.2 Roadmap themes (from `todo.txt`)

- **Error handling & observability**: Pino structured logging, Prometheus/Grafana,
  Sentry on FE+BE.
- **Security**: secrets manager, bcrypt/argon2, rate-limit auth, input sanitization.
- **API**: OpenAPI docs, pagination, per-user rate limits.
- **Testing**: unit + integration + E2E as CI merge blockers.
- **Frontend**: loading/error states, mobile responsiveness, state management
  (Zustand/Redux).
- **Workers**: dead-letter queue, uptime-% metrics, per-website intervals.
- **Database**: migration scripts (done via Prisma already), indexes on `websiteId`,
  `userId`, `createdAt`.
- **Scalability**: Redis cluster for redundancy, per-user rate limits, synthetic/browser
  checks.