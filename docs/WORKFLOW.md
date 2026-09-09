# StatusBus — Workflow & Data Flow

> Part of the StatusBus documentation set. Overview & quick start: [`../README.md`](../README.md)

This document walks through the end-to-end behavior of StatusBus: how a user signs up,
adds a website, and how the monitoring pipeline turns that website into per-region
uptime ticks shown on the dashboard.

## 1. User Lifecycle

1. **Sign up** — `POST /user/signup` with `{ username, password }`.
   - `AuthInput` (zod) is validated; a `User` row is created (password stored as-is — see Known Issues).
   - Success → `200 { id }`; invalid body or duplicate username → `403`.
2. **Sign in** — `POST /user/signin` with `{ username, password }`.
   - Looks up a matching user and issues a JWT signed with `process.env.JWT_SECRET`
     (HS256), payload `{ sub: user.id }`, **no expiry**.
   - Success → `200 { jwt }`. The frontend stores the token raw in
     `localStorage["token"]` and sends it as the **bare** `Authorization` header
     (no `Bearer ` prefix), which matches the API middleware expectation.
3. **Add a website** — `POST /website` (auth required), body `{ url }`.
   - Creates a `Website` row owned by the authenticated user. Success → `200 { id }`.
   - The site now appears on the user's dashboard and becomes eligible for monitoring.
4. **View status** — `GET /websites` (auth required) returns each of the user's websites
   joined with its **latest** tick:
   ```
   { websites: [{ id, url, status, responseTime, lastChecked }] }
   ```
   - `status` = `Up` / `Down` / `Unknown` (Unknown when no ticks exist yet).
   - `responseTime` = latest tick's `rt_ms`; `lastChecked` = latest tick's `createdAt`.
   - `GET /status/:websiteId` (auth required) is also available; it verifies ownership but
     currently returns only `{ url, id, user_id }`.

## 2. Monitoring Pipeline

The pipeline runs continuously and is driven by one producer and one or more consumers.

```
[every 60s]
Producer ──GET /monitoring/websites──▶ API ──▶ Postgres (Website list)
   │
   │ XADD statusbus:web * url <url> id <websiteId>    (one entry per website)
   ▼
Redis Stream "statusbus:web"
   ▲                       ▲
   │ XREADGROUP            │ XREADGROUP
   │ GROUP=1               │ GROUP=2
   │ CONSUMER=india-c-1    │ CONSUMER=us-c-1
   │ COUNT=5               │ COUNT=5
[India consumer]          [US consumer]
   │ 1. axios.get(url)      │ 1. axios.get(url)
   │ 2. rt_ms = elapsed     │ 2. rt_ms = elapsed
   │ 3. status = Up|Down    │ 3. status = Up|Down
   │ 4. POST /monitoring/tick {website_id, region_id, rt_ms, status}
   │ 5. XACK                │ 5. XACK
   ▼                       ▼
API ──▶ Postgres (WebsiteTick)   ──▶ Dashboard GET /websites
```

### Step-by-step

1. **Produce cast** — `apps/producer`:
   - On start, retries `GET {API_URL}/monitoring/websites` up to 10× (2 s backoff).
   - Runs one cycle immediately, then every **60,000 ms**.
   - Each cycle: fetch `{websites:[{id,url,user_id}]}`; if none, log "No websites to monitor"
     and skip. Otherwise call `xAddBulk` → for every site, `XADD statusbus:web *` with
     fields `url` and `id`. (Extra `user_id`/`timestamp` fields sent by the producer are
     dropped by `redisq`, so the stream stores exactly `{url, id}`.)
2. **Queue** — Redis Stream `statusbus:web` holds the jobs. `id` is the **Website row UUID**
   (not a job id); the Redis-generated stream entry id (`<ms>-<seq>`) is the job receipt
   that the consumer later acknowledges.
3. **Consume** — each consumer (one process = one consumer within a region's group):
   - Requires `REGION_ID` and `CONSUMER_ID`.
   - Idempotently creates its consumer group: `XGROUP CREATE statusbus:web <REGION_ID> 0 MKSTREAM`.
     The group name is the region id (seeded: `1` = India, `2` = US).
   - Loops: `XREADGROUP GROUP <REGION_ID> CONSUMER <CONSUMER_ID> COUNT 5 STREAMS statusbus:web >`.
     When the batch is empty it sleeps 1 s before polling again.
   - Because every region is a separate group over the **same** stream, **each region gets a
     full copy of every job** → every region checks every website (fan-out).
4. **Probe** — for each message, `fetchWebsite`:
   - `startTime = Date.now()` → `await axios.get(url)`.
   - Resolved (2xx) → `status: "Up"`; any rejection (HTTP error, DNS/TLS/network failure) →
     `status: "Down"`. There is currently **no request timeout**.
   - `rt_ms = Date.now() - startTime`.
   - `POST {API_URL}/monitoring/tick` with
     `{ website_id, region_id: REGION_ID, rt_ms, status }`.
   - Up to `COUNT` (5) messages processed concurrently via `Promise.all`.
5. **Report** — API validates `website_id`, `region_id`, numeric `rt_ms`, truthy `status`,
   then creates a `WebsiteTick` row (integrity enforced by the `WebsiteStatus` enum and FKs).
   A batch of 5 probes is acknowledged only as each individual probe finishes.
6. **Acknowledge** — in `.finally`, `XACK statusbus:web <REGION_ID> <stream-entry-id>` removes
   the message from the group's pending list. On ack failure the job remains pending (no
   `XAUTOCLAIM`/dead-lettering today).

### Cadence & sizing

| Parameter | Value | Where |
| --- | --- | --- |
| Producer cadence | 1 cycle immediately + every 60 s | `apps/producer/index.ts` |
| Queue batch size | 5 (`COUNT`) | `packages/redisq/index.ts` |
| Consumer idle poll | 1 s between empty reads | `apps/consumer/index.ts` |
| Probe concurrency | up to 5 in flight per batch | `apps/consumer/index.ts` |
| Tick retention | `rt_ms` Int ms; `status` enum | `packages/store/prisma/schema.prisma` |

## 3. Queue Contract (`packages/redisq`)

| Item | Value |
| --- | --- |
| Stream | `statusbus:web` |
| Message fields | `url` (string), `id` (string = Website UUID) |
| Producer helpers | `xAdd`, `xAddBulk` |
| Consumer-group helpers | `xGroupCreate`, `xReadGroup`, `xAck`, `xAckBulk` |
| Group naming | group = `REGION_ID` |
| Consumer naming | consumer = `CONSUMER_ID` |
| Deliveries | at-least-once via Redis consumer groups |

## 4. API Endpoint Reference

Base: `http://localhost:3001` (local) or `https://api.statusbus.byaniket.online` (prod).

| # | Method & Path | Auth | Request | Success | Errors |
| --- | --- | --- | --- | --- | --- |
| 1 | `POST /user/signup` | — | `{username, password}` | `200 {id}` | `403` (invalid body / dup user) |
| 2 | `POST /user/signin` | — | `{username, password}` | `200 {jwt}` | `403` |
| 3 | `POST /website` | yes | `{url}` | `200 {id}` | `411 {}` (no url) |
| 4 | `GET /websites` | yes | — | `200 {websites:[{id,url,status,responseTime,lastChecked}]}` | — |
| 5 | `GET /status/:websiteId` | yes | path param | `200 {url,id,user_id}` | `409 {message:"Not Found"}` |
| 6 | `GET /monitoring/websites` | internal | — | `200 {websites:[{id,url,user_id}]}` | `500 {error}` |
| 7 | `POST /monitoring/tick` | internal | `{website_id, region_id, rt_ms, status}` | `200 {tick}` | `400`/`500 {error}` |
| 8 | `GET /health` | — | — | `200 "ok"` | — |

- **Auth entitlement**: raw JWT in `Authorization` header; sets `req.user_id` from `sub`.
- **Internal endpoints** (`/monitoring/websites`, `/monitoring/tick`) are unauthenticated —
  they're the only bridge between the worker pipeline and the DB.

## 5. Failure Modes & Behavior

- **Website down** → consumer posts a `"Down"` tick; dashboard shows red status dot. The site
  keeps being retried every 60 s.
- **Probe hangs** (no timeout) → axios promise stays pending; message is never acked and stays
  in the group's pending list; no tick is recorded for that cycle.
- **Consumer or Redis down** → unacked entries remain pending; on restart, new messages are read
  via `>`. Pending (delivered-but-unacked) entries are **not** reclaimed (no `XAUTOCLAIM`).
- **Producer API unreachable** → retries 10× then stops scheduling until manually restarted.
- **No new websites** → producer logs and skips the cycle; consumers idle-sleep.
- **Deleted website** → ticks cascade-delete via the `ON DELETE CASCADE` FK; the next producer
  cycle won't enqueue it. Messages already in-flight may still produce a tick against a deleted
  website id, which the API rejects with `500` (caught and logged by the consumer).