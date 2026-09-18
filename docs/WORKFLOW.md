# StatusBus — Workflow & Data Flow

> Part of the StatusBus documentation set. Overview & quick start: [`../README.md`](../README.md)

This document walks through the end-to-end behavior of StatusBus: how a user signs up,
adds a website, and how the monitoring pipeline turns that website into per-region
uptime ticks shown on the dashboard.

## 1. User Lifecycle

1. **Sign up** — `POST /user/signup` with `{ username, password }`.
   - `AuthInput` (zod) is validated; a `User` row is created with a **bcrypt-hashed**
     password (never the raw value).
   - Success → `200 { id }`; invalid body or duplicate username → `403`.
2. **Sign in** — `POST /user/signin` with `{ username, password }`.
   - Looks up the user by **username**, `bcrypt.compare`s the password, and issues a JWT
     signed with `process.env.JWT_SECRET` (HS256), payload `{ sub: user.id }`,
     **`expiresIn: "7d"`**. Pre-bcrypt accounts are transparently upgraded on next login.
   - Success → `200 { jwt }`. The frontend stores the token raw in
     `localStorage["token"]` and sends it as `Authorization: Bearer <token>`, matching the
     API middleware expectation.
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
[every 5 min]
Producer ──GET /monitoring/websites (x-internal-key)──▶ API ──▶ Postgres (Website list)
   │
   │ XADD statusbus:web * url <url> id <websiteId>    (one entry per website)
   ▼
Redis Stream "statusbus:web"  (~capped at 100K entries)
   ▲                       ▲
   │ XREADGROUP            │ XREADGROUP
   │ GROUP=1               │ GROUP=2
   │ CONSUMER=india-c-1    │ CONSUMER=us-c-1
   │ COUNT=5               │ COUNT=5
[India consumer]          [US consumer]
   │ 1. axios.get(url, 10s timeout)
   │ 2. rt_ms = elapsed     │
   │ 3. status = Up|Down    │
   │ 4. POST /monitoring/tick {website_id, region_id, rt_ms, status}
   │ 5. XACK                │  + XAUTOCLAIM every 5 min (stalled messages)
   ▼                       ▼
API ──▶ Postgres (WebsiteTick)   ──▶ Dashboard GET /websites
```

### Step-by-step

1. **Produce cast** — `apps/producer`:
   - On start, retries `GET {API_URL}/monitoring/websites` up to 10× (2 s backoff).
   - Runs one cycle immediately, then every `PRODUCER_INTERVAL_SEC` (default **300 s**).
   - Each cycle: fetch `{websites:[{id,url,user_id}]}` with the `x-internal-key` header; if
     none, log "No websites to monitor" and skip. Otherwise `xAdd` every site to
     `statusbus:web` with fields `url` and `id`, then `capStream()` trims the stream to
     ~100 K entries.
2. **Queue** — Redis Stream `statusbus:web` holds the jobs. `id` is the **Website row UUID**
   (not a job id); the Redis-generated stream entry id (`<ms>-<seq>`) is the job receipt
   that the consumer later acknowledges.
3. **Consume** — each consumer (one process = one consumer within a region's group):
   - Requires `REGION_ID` and `CONSUMER_ID`.
   - Idempotently creates its consumer group: `XGROUP CREATE statusbus:web <REGION_ID> 0 MKSTREAM`.
     The group name is the region id (seeded: `1` = India, `2` = US).
   - Loops: `XREADGROUP GROUP <REGION_ID> CONSUMER <CONSUMER_ID> COUNT 5 STREAMS statusbus:web >`.
     When the batch is empty it sleeps `CONSUMER_POLL_SEC` (default 60 s) before polling again.
   - Because every region is a separate group over the **same** stream, **each region gets a
     full copy of every job** → every region checks every website (fan-out).
4. **Probe** — for each message, `fetchWebsite`:
   - `startTime = Date.now()` → `await axios.get(url, { timeout: 10_000 })`.
   - Resolved (2xx) → `status: "Up"`; any rejection (HTTP error, DNS/TLS/network failure,
     timeout) → `status: "Down"`. `rt_ms = Date.now() - startTime`.
   - `POST {API_URL}/monitoring/tick` (with `x-internal-key`) carrying
     `{ website_id, region_id: REGION_ID, rt_ms, status }`.
   - Up to `COUNT` (5) messages processed concurrently via `Promise.all`.
5. **Report** — API validates `website_id`, `region_id`, numeric `rt_ms`, status ∈
   `{Up, Down}`, and the internal key (constant-time compare); it creates a `WebsiteTick`
   row (integrity enforced by the `WebsiteStatus` enum and FKs). Missing region / deleted
   website → clean `404`, otherwise `400` for malformed input.
6. **Acknowledge** — in `.finally`, `XACK statusbus:web <REGION_ID> <stream-entry-id>` removes
   the message from the group's pending list. **Stalled recovery:** every
   `CONSUMER_RECLAIM_INTERVAL_SEC` (default 300 s) each consumer runs `XAUTOCLAIM`
   (min idle 5 min) to reclaim pending messages whose owning consumer disappeared — this is
   how spot-evicted consumers hand their in-flight probes back to a peer.

### Cadence & sizing

| Parameter | Value | Where |
| --- | --- | --- |
| Producer cadence | 1 cycle immediately + every 300 s (`PRODUCER_INTERVAL_SEC`) | `apps/producer/index.ts` |
| Queue batch size | 5 (`COUNT`) | `packages/redisq/index.ts` |
| Consumer idle poll | 60 s between empty reads (`CONSUMER_POLL_SEC`) | `apps/consumer/index.ts` |
| Stalled-message reclaim | `XAUTOCLAIM` every 300 s, min idle 5 min, count 10 | `packages/redisq/index.ts` |
| Stream cap | `XTRIM ... MAXLEN ~ 100_000` per producer cycle | `packages/redisq/index.ts` |
| Probe timeout | 10 s (`axios` `timeout`) | `apps/consumer/index.ts` |
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

Base: `http://localhost:3001` (local) or `https://api-statusbus.byaniket.site` (live).

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

- **Auth entitlement**: `Authorization: Bearer <jwt>`; sets `req.user_id` from the verified
  `sub`. Sessions expire after 7 days.
- **Internal endpoints** (`/monitoring/websites`, `/monitoring/tick`) are not public —
  they require the `x-internal-key` header, compared constant-time against
  `process.env.INTERNAL_KEY`. They are the only bridge between the worker pipeline and
  the DB.

## 5. Failure Modes & Behavior

- **Website down** → consumer posts a `"Down"` tick; dashboard shows red status dot. The site
  keeps being retried every producer cycle.
- **Probe hangs** → `axios` timeout (10 s) fires → posted as `"Down"`, message acked. No
  permanent wedge.
- **Consumer or Redis down** → unacked entries remain in the group's pending list. On the
  next idle pass, a surviving consumer runs `XAUTOCLAIM` (min idle 5 min) and reprocesses
  them; this is how a spot-evicted consumer's in-flight probes are recovered.
- **Whole region down** (e.g. US VM gone) → that region's `XAUTOCLAIM` has no peer, so its
  pending messages wait in the PEL until the region's consumer returns (consumer groups
  only reclaim to *active* consumers in the same group). Ticks for that region pause and
  resume after the replacement VM boots — the accepted trade for spot pricing.
- **Producer API unreachable** → retries 10× with 2 s backoff then stops scheduling until
  manually restarted (or the container is restarted).
- **No new websites** → producer logs and skips the cycle; consumers idle-sleep.
- **Deleted website** → ticks cascade-delete via the `ON DELETE CASCADE` FK; the next producer
  cycle won't enqueue it. Messages already in-flight may still produce a tick against a
  deleted website id, which the API rejects with `404 Website does not exist` (caught and
  logged by the consumer).