# StatusBus — System Architecture

## 1. Purpose & Goals

StatusBus is a **globally-distributed website uptime monitoring service**. It orchestrates
consumers running in VMs across different world regions that ping a set of websites at
frequent intervals, measure response times, and record the results (ticks) into a central
database. Users register, add websites through a web dashboard, and see the latest
status/response time for each site.

The intended end-state is a multi-region deployment (originally rolled out on GCP, with
kind used for local Kubernetes testing) where:

- The **API and database are centralized**.
- A **single shared Redis Stream** fans monitoring jobs out to every region.
- **Each region runs its own consumers** (a consumer group named after the region) so that
  every region independently checks every website.
- All check results are aggregated into **Postgres** for the dashboard and future analytics.

## 2. High-Level System Diagram

```
                        ┌───────────────────────────────────────────────┐
                        │                    User / Browser              │
                        └──────────────────────┬────────────────────────┘
                                               │  HTTPS (browser)
                                               ▼
                        ┌──────────────────────┴────────────────────────┐
                        │              apps/fe (Next.js)                │
                        │     landing · signup/signin · dashboard       │
                        └──────────────────────┬────────────────────────┘
                                               │  CORS + JWT  (GET /websites,
                                               │              POST /website, ...)
                                               ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                              apps/api (Express 5)                            │
│   REST API · JWT auth · zod validation · Prisma (packages/store)             │
│   Public endpoints:  user/signup, user/signin, website, websites, status/:id │
│   Internal endpoints: monitoring/websites, monitoring/tick, health           │
└─────────────┬────────────────────────────────────┬───────────────────────────┘
              │                                    │   POST /monitoring/tick
              │  GET /monitoring/websites          │   {website_id, region_id, rt_ms, status}
              │  [{id, url, user_id}]              ▼
              │                          ┌───────────────────────────┐
              ▼                          │  Postgres (Prisma/store)  │
┌──────────────────────┐                 │  User → Website → Tick    │
│   apps/producer      │                 │  Region                   │
│  polls API every 60s │                 └───────────────────────────┘
│  XADD → stream       │
└──────────┬───────────┘
           │  XADD statusbus:web {url, id}  (per website, 1/min)
           ▼
   ┌─────────────────────────────────┐
   │   Redis Stream: statusbus:web   │
   │   (shared, fan-out to regions)  │
   └──────────────┬──────────────────┘
                  │  XREADGROUP GROUP=<region_id> CONSUMER=<consumer_id> COUNT 5
                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  apps/consumer — one consumer group per region               │
   │  e.g. group "1" (India): consumer india-consumer-1           │
   │       group "2" (US):    consumer us-consumer-1              │
   │  for each job: axios.get(url) → rt_ms → status Up/Down       │
   │               → POST /monitoring/tick → XACK                 │
   └──────────────────────────────────────────────────────────────┘
```

## 3. Multi-Region Design

The monitoring substrate is a single Redis Stream named `statusbus:web`. The design is
**fan-out, not partitioning**:

- The `producer` enqueues every website once per cycle, regardless of region.
- Redis **consumer groups** are keyed by the **region id** (`REGION_ID`). Each region forms
  its own group over the *same* stream.
- Because every group reads with `XREADGROUP ... >` (new messages only), **every region
  receives a full copy of every job** and therefore checks every website locally.
- Individual consumers within a group (identified by `CONSUMER_ID`) share the group's load,
  so scaling a region means adding more consumer replicas.

This gives:
- **Independence**: a check from India and a check from the US both validate a site’s
  availability; regional network issues don’t affect other regions.
- **Simplicity**: no job routing, no mapping websites to regions, no per-region queues.

### Component roles

| Component | Role in the fan-out |
| --- | --- |
| Producer | Global scheduler. Polls the API for the full website list, enqueues every site. |
| Redis Stream | Job buffer / queue + delivery ledger (via consumer-group pending list). |
| Consumer (per region) | Reads its region's copy of the queue, performs the actual probe, reports a tick. |

## 4. Component Breakdown

### 4.1 `apps/api` — Backend REST API

Express 5 (TypeScript) single-file app (`apps/api/index.ts`), run on the Bun runtime.

- **Auth**: JWT (HS256, `jsonwebtoken`). Signed payload `{ sub: user.id }`. No expiry.
  Tokens are sent in the raw `Authorization` header (no `Bearer` prefix).
- **Validation**: `zod` (`AuthInput` → `{ username, password }`).
- **Database access**: exclusively through `packages/store` (`import { prisma } from "store/client"`).
- **CORS**: allow list of the frontend origins (`https://statusbus.byaniket.online`,
  `http://localhost:3000`).
- **Endpoints** (8): see `docs/WORKFLOW.md` for the full reference table.

### 4.2 `apps/fe` — Frontend (Next.js 15)

- App Router + Tailwind v4 + shadcn/ui tokens + lucide icons.
- Marketing landing page (`/`), `/signup`, `/signin`, `/dashboard`, and a placeholder
  `/website/[websiteId]` route.
- Talks to the API cross-origin via `NEXT_PUBLIC_BACKEND_URL` (inlined at build time,
  default `https://api.statusbus.byaniket.online`).
- Stores the JWT in `localStorage["token"]` and sends it in the `Authorization` header.
- No state-management library, no realtime updates (dashboards fetch once per mount),
  no per-website detail view or charts yet.

### 4.3 `apps/producer` — Job scheduler

- Loop: every **60 s**, `GET {API_URL}/monitoring/websites` → for each site,
  `XADD statusbus:web * url <url> id <id>` (via `packages/redisq`).
- Runs one cycle immediately on start, then `setInterval` every 60 s.
- Retries API connectivity 10× with 2 s backoff before giving up.
- Region-agnostic; only enqueues. Note: extra fields (`user_id`, `timestamp`) passed to
  `xAddBulk` are dropped by `redisq` — the stream carries only `{url, id}`.

### 4.4 `apps/consumer` — Region worker

- Requires `REGION_ID` (string) and `CONSUMER_ID`.
- **Consumer group name = `REGION_ID`**; consumer name = `CONSUMER_ID`.
- Creates the group idempotently (`XGROUP CREATE ... MKSTREAM`, swallows `BUSYGROUP`).
- Loop: `XREADGROUP` with `COUNT 5`, `id: '>'`; idle-sleep 1 s when no jobs.
- For each job: `axios.get(url)`; on resolve → `status: "Up"`, on reject → `status: "Down"` —
  where `rt_ms = Date.now() - startTime`; then `POST /monitoring/tick` and `XACK` the event.
- Up to 5 probes run concurrently per batch (`Promise.all`).

### 4.5 `packages/store` — Prisma data layer

- Prisma 7 + `@prisma/adapter-pg` PostgreSQL driver adapter.
- Singleton Prisma client cached on `globalThis` in dev.
- Schema below; migrations in `packages/store/prisma/migrations/`.
- Generated client under `packages/store/generated/prisma/` (git-ignored, regenerated in
  Docker builds with `bunx prisma generate --config=prisma.config.ts`).

### 4.6 `packages/redisq` — Redis Streams wrapper

Hard-coded to the single stream `statusbus:web` with message shape `{ url, id }`.
Exports: `xAdd`, `xAddBulk`, `xGroupCreate`, `xReadGroup`, `xAck`, `xAckBulk`.
Connection: one module-level `createClient({ url: process.env.REDIS_URL })`.

### 4.7 `packages/shared-types`

Shared types used by the queue: `MessageType` (`{url, id}`), `StreamEntry<T>`,
`RawRedisMessage`.

### 4.8 `apps/tests`

Bun test runner integration tests (`user.test.ts`, `website.test.ts`) that hit a live API
at `http://127.0.0.1:3001`.

## 5. Data Model

Authoritative schema: `packages/store/prisma/schema.prisma`.

```
User
  id          String  @id @default(uuid())
  username    String  @unique
  password    String                      ← currently stored in plaintext
  websites    Website[]

Website
  id          String  @id @default(uuid())
  url         String
  createdAt   DateTime @default(now())
  user_id     String                       → User.id
  ticks       WebsiteTick[]

Region
  id          String  @id @default(uuid())  ← seeded as '1' = India, '2' = US
  name        String
  ticks       WebsiteTick[]

WebsiteTick
  id          String  @id @default(uuid())
  rt_ms       Int
  status      WebsiteStatus    (enum: Up | Down | Unknown)
  region_id   String                       → Region.id (ON DELETE RESTRICT)
  website_id  String                       → Website.id (ON DELETE CASCADE)
  createdAt   DateTime @default(now())

enum WebsiteStatus { Up  Down  Unknown }
```

Migration history:

| Migration | Purpose |
| --- | --- |
| `20250722191418_init` | Initial `Website`, `Region`, `WebsiteTick`, `WebsiteStatus` enum |
| `20250722204455_web_model_update` | Drop `Website.timeAdded`, add `createdAt` |
| `20250724014954_add_user` | Add `User`, `Website.user_id`, `WebsiteTick.createdAt` |
| `20250725183020_make_username_unique` | Unique index on `User.username` |
| `20250821180444_website_tick_on_delete_cascading` | Ticks cascade-delete with their website |

**Storage note:** Postgres is currently the single source of truth for both entities and
monitoring results (`WebsiteTick`). A dedicated **time-series database** is planned but
**not yet implemented** — the current docs and code treat `WebsiteTick` in Postgres as the
store. The Region id is used as the Redis consumer-group name, so seeding the `Region`
rows (India=1, US=2) is a prerequisite for consumers.

## 6. Tech Stack

| Layer | Technology |
| --- | --- |
| Monorepo | Turborepo + Bun workspaces (`bun@1.2.18`) |
| API | Express 5, TypeScript, JWT, zod |
| Frontend | Next.js 15 (App Router, Turbopack), Tailwind v4, shadcn/ui |
| Workers | Plain Bun/Node processes (producer, consumer) |
| Queue | Redis 7 Streams (`packages/redisq`) |
| Database | PostgreSQL 15 via Prisma 7 (`@prisma/adapter-pg`) |
| Tests | Bun test runner + axios integration tests |
| Deployment | Docker / docker-compose, kind (local k8s), GKE on GCE VMs, GitHub Actions |

## 7. Design Decisions & Tradeoffs

- **Redis Streams over a plain queue**: consumer groups give per-region fan-out, at-least-once
  delivery semantics and a pending-entry list for recovery, all built in.
- **Fan-out to all regions** (vs partitioning): every region maintains a complete, independent
  view of every website, which is the point of global monitoring. Current util is capped by
  the same number of probe jobs every region performs, but with one or a few consumers per
  region that scales linearly by region count.
- **Central API + Postgres**: all writes funnel through the API; workers never touch the DB
  directly (recently refactored from direct Prisma calls). This keeps the DB ACL simple
  (only the API or its Cloud SQL proxy connects) and gives a natural choke point for auth.
- **Region id doubles as the consumer-group name**: keeps worker config to two env vars
  (`REGION_ID`, `CONSUMER_ID`) at the cost of coupling region identity to the queue machinery.
- **Probe = plain HTTP GET**: `Up` iff axios resolves (HTTP 2xx), otherwise `Down`. Simple,
  but it conflates DNS/TLS/status-code failures and lacks a timeout today (see Known Issues).