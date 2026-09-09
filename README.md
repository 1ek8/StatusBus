# StatusBus

**Global website-uptime monitoring from a multi-region mesh of workers.**

StatusBus is an uptime monitoring service. Users add websites through a web dashboard and
StatusBus automatically checks them at frequent intervals, records the response time, and
flags each site as **Up** or **Down**. The interesting part is *how* it checks:

- A single **producer** duty-cycles through every monitored website and publishes a "check
  this URL" job onto a **Redis Stream** (`statusbus:web`) every 60 seconds.
- **Consumers** run in consumer groups, one group per **region** (India, US, ...). Because
  Redis consumer groups are separate per region, **every region receives every job** — each
  site is independently probed from multiple parts of the world.
- Each consumer performs a plain HTTP GET, times it (`rt_ms`), classifies it `Up`/`Down`,
  reports the result back to a central API, and acknowledges the stream message.
- The API persists every check as a `WebsiteTick` in **PostgreSQL**; the dashboard shows each
  site's latest status, response time, and last-checked time.

Built as a **Bun + Turborepo monorepo** — Express 5 API, Next.js 15 frontend, Redis-Stream
workers, Prisma 7 data layer — designed to run via **Docker Compose**, **kind** (local
Kubernetes), or a **GKE cluster** on production GCP.

---

## Feature Overview

- Account signup / signin (JWT-based sessions).
- Add and track any number of websites.
- Dashboard showing each site's current status (`Up` / `Down` / `Unknown`), response time
  and last-checked timestamp.
- Checks run on a **60-second global cadence**, fanning out across all configured regions.
- Automatic classification: any HTTP failure (network, DNS, TLS, non-2xx) is reported
  `Down`; successful loads report `Up` with the measured round-trip time.

> The product is a work-in-progress proof-of-concept. Per-website detail pages, uptime
> analytics, alerts, and edit/delete are not fully implemented yet — see
> [Roadmap & Limitations](#roadmap--limitations).

## Architecture at a glance

```
Browser ──▶ apps/fe (Next.js, :3000)
                 │  JWT + CORS
                 ▼
      apps/api (Express + Prisma, :3001) ──▶ PostgreSQL
      public:   /user/signup, /user/signin,   (User, Website, Region, WebsiteTick)
      internal: /website, /websites, /status/:id, /health,
                /monitoring/websites, /monitoring/tick
                 ▲                     │
                 │  POST /monitoring/tick │  GET /monitoring/websites (every 60s)
                 │  {website_id, region_id│  by the producer
                 │   rt_ms, status}       ▼
                 │              ┌────────────────────┐
                 │              │ Redis Stream       │
                 │              │ statusbus:web      │
                 │              └─────────┬──────────┘
                 │                        │ XREADGROUP (group = REGION_ID)
                 │                        ▼
                 │          apps/consumer × per region
                 └──────   HTTP GET the URL → report tick → XACK
```

Full detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Repository layout

| Path | Role |
|---|---|
| `apps/api` | Express 5 REST API, JWT auth, zod validation |
| `apps/fe` | Next.js 15 frontend (landing, auth, dashboard) |
| `apps/producer` | Scheduler: publishes every website to the Redis stream each 60 s |
| `apps/consumer` | Region worker: probes URLs and reports `WebsiteTick`s |
| `apps/tests` | Bunny integration tests against a live API |
| `packages/store` | Prisma 7 schema + generated client (`store/client`) |
| `packages/redisq` | Redis Streams wrapper (xAdd / consumer groups / ack) |
| `packages/shared-types` | Shared queue types (`MessageType`, `StreamEntry`) |
| `kind-deploy` | Local Kubernetes manifests + `deploy.sh` bootstrap |
| `gcp-infra` | Production Kubernetes manifests (GKE, ingress, cert-manager) |

The whole design rationale (why Redis Streams, why fan-out, why central Postgres) is
documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Getting Started

### Prerequisites

- **Bun** `>= 1.2.18` and **Node** `>= 18`
- **Docker** + Docker Compose v2 (for the one-command stack)
- `gcloud` + `kubectl` + `kind` (only for the Kubernetes flows)

### Quick start with Docker Compose

```bash
cp .env.example .env        # then fill in POSTGRES_USER, POSTGRES_PASSWORD, DATABASE_URL, JWT_SECRET
docker compose up --build
```

This brings up Postgres + Redis, runs `prisma migrate deploy`, then starts the API
(`:3001`), frontend (`:3000`), producer, and consumer.

**One-time prerequisite — seed the regions.** Consumers group by `REGION_ID` (1 = India,
2 = US); those rows must exist. `docker compose up` runs this automatically via the
`seed-region` service, but for ad-hoc runs from the repo root (with `bun install` already
run and `DATABASE_URL` reachable):

```bash
DATABASE_URL=postgresql://<user>:<pass>@localhost:5432/statusbus bun run ./packages/store/seedRegion.ts
```

Then:

- Frontend: <http://localhost:3000>
- API health: <http://localhost:3001/health>
- API list of monitored sites: <http://localhost:3001/monitoring/websites>

### Running services individually (dev)

```bash
bun install              # install workspace deps
bun run dev              # turbo dev → runs every app/package
```

Per-app scripts (each app has `build`; the API also has `start`). The API reads
`apps/api/.env` for `DATABASE_URL`, `JWT_SECRET`, `PORT`, `HOST`; the consumer reads
`REGION_ID` / `CONSUMER_ID`; workers use `REDIS_URL` and `API_URL`.

### Local Kubernetes (kind)

```bash
cd kind-deploy
./deploy.sh              # creates cluster, applies infra + secrets, migrates + seeds, deploys, port-forwards
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Tests

Requires a running API on `:3001`:

```bash
cd apps/tests
bun test
```

## Environment Variables

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | API, store, migration jobs | PostgreSQL connection string |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | docker-compose | Local Postgres service credentials |
| `JWT_SECRET` | API | HS256 secret for signing/verifying JWTs |
| `REDIS_URL` | producer, consumer, redisq | Redis connection string |
| `API_URL` | producer, consumer | Where to reach the backend (`http://api:3001` in Docker) |
| `REGION_ID` / `CONSUMER_ID` | consumer | Region group name + consumer identity |
| `NEXT_PUBLIC_BACKEND_URL` | frontend (build-time) | Base URL of the API, inlined into the client bundle |

`PORT` / `HOST` are also respected by the API (defaults `3001` / `0.0.0.0`).

## How the monitoring pipeline works

1. **Producer** polls `GET /monitoring/websites` every 60 s and `XADD`s one entry per
   website (`{url, id}`) to the Redis stream `statusbus:web`.
2. **Consumer(s)** each own a Redis consumer group named after their `REGION_ID`. Every
   group independently reads the full stream, so every region checks every website.
3. For each job, the consumer `GET`s the URL, times it, and POSTs
   `{website_id, region_id, rt_ms, status}` to `POST /monitoring/tick` on the API.
4. The API writes a `WebsiteTick` row; the dashboard's `GET /websites` joins the latest
   tick per site for display.

Step-by-step detail, failure modes, and the full API reference live in
[docs/WORKFLOW.md](docs/WORKFLOW.md).

## Deployment

Three targets are supported — see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for full details:

1. **Docker Compose** — full stack locally (fastest iteration).
2. **kind** — the same stack on a local Kubernetes cluster (`kind-deploy/deploy.sh`).
3. **GKE (GCP)** — the production layout: Kubernetes cluster, Artifact Registry images,
   ingress + cert-manager TLS, CI/CD pipeline in `.github/workflows/deploy.yml`.

## Documentation

| File | Covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, components, data model, decisions |
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | End-to-end flows, queue contract, API reference, failure modes |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Compose + kind + GCP deployment, CI/CD, known issues |

## Roadmap & Limitations

- Password hashing (bcrypt/argon2) and hardened sign-in are on the short list.
- Per-website detail pages, charts, uptime analytics, and edit/delete UI are not yet built.
- The monitoring interval is a single global 60 s cadence (no per-site intervals yet).
- Time-series analytics and alerting are future work — results currently live in Postgres.
- See the "Known Issues & Future Work" appendix of
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full catalogue.