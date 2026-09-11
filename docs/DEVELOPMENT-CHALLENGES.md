# StatusBus — Development Challenges & Fixes

*Interview review notes.* StatusBus went from "working demo" to "deployed, hardened system"
through a series of problems that were **discovered organically** during development,
testing, and the live deployment — not pre-planned as tasks. Most are classic distributed-
systems and security pitfalls worth being able to re-derive from first principles.

A running theme: the design starts *simple and visible* (single stream, one producer, JWT
auth, plain storage) and the bugs appear the moment it meets reality — a second region, a
deployed public URL, a website that hangs instead of erroring.

---

## 1. Passwords stored in plaintext

- **How it surfaced:** reviewing `signup`/`signin`, then confirming rows in the DB. Signals:
  a signin query that matched on `username AND password` (a tell — you cannot do that with
  hashes) and DB rows showing raw passwords.
- **Why it's bad:** a database leak (dump, careless backup, SQLi) exposes every account's
  exact password. Users reuse passwords; the blast radius extends beyond StatusBus.
- **The fix:**
  - `bcrypt.hash(password, 10)` on signup — one-way, salted, deliberately slow.
  - Signin looks up by **username only**, then `bcrypt.compare` (a hashing library's compare
    is designed to not leak *which* part failed).
  - **Legacy migration:** pre-hash accounts are detected on signin (stored value === input)
    and transparently upgraded to a hash in the same request, so no account is orphaned.
- **Interview talking points:** one-way hash vs reversible encryption; why salted; why bcrypt
  cost / why argon2; the "upgrade-on-login" pattern; never log or return the hash.

## 2. JWTs never expired; auth middleware accepted any raw string

- **How it surfaced:** reading `jwt.sign` (no `expiresIn`) and the middleware, which did
  `jwt.verify(header)` — it passed the *entire Authorization header* as the token and never
  validated a `Bearer ` prefix. The frontend therefore sent the raw token.
- **Why it's bad:** no expiry means a stolen token is a permanent backdoor. No prefix
  validation means the header format is effectively unchecked — anything a *valid* token
  looks like (e.g., lifted from logs or another app using the same secret) goes straight to
  `jwt.verify`.
- **The fix:**
  - `jwt.sign(..., { expiresIn: "7d" })` — bounded session lifetime.
  - Middleware requires `Authorization: Bearer <token>`, strips the prefix, rejects missing /
    empty / malformed headers with `401` before `jwt.verify` runs.
  - Frontend updated to send the `Bearer ` prefix (both pages were touched).
- **Interview talking points:** JWT anatomy (header/payload/signature, `exp`/`sub`/`iat`);
  stateless sessions vs server-side sessions; why `401` vs `403`; clock-safety of `exp`.

## 3. Monitoring endpoints publicly exposed + unvalidated

- **How it surfaced:** right after the Cloud Run deploy, `GET /monitoring/websites` was
  fetchable from a browser with no credentials. This is the **internal plumbing** endpoints —
  endpoints only the producer/consumer should ever call.
- **Why it's bad (on an open internet URL):**
  - **Privacy:** anyone could read every user's monitored-site list.
  - **Forgery:** `POST /monitoring/tick` accepted any body — an attacker could claim any site
    is `Up`/`Down`, corrupting every user's dashboard.
  - **Abuse/cost:** unlimited fake ticks = unbounded Neon writes.
  - **Robustness:** trusted malformed data (tick for a deleted site) crashed with a Prisma
    FK error (`P2003`) → HTTP 500 instead of a clean 4xx.
- **The fix:**
  - Shared **internal key** — workers send `x-internal-key`; the API compares it to
    `INTERNAL_KEY` with `crypto.timingSafeEqual` (constant-time, length-guarded) on both
    `/monitoring/*` routes; public callers get `401`.
  - **Strict zod schema** for ticks: UUID `website_id`, `rt_ms: number().int().min(0)`,
    `status` ∈ {`Up`,`Down`} → garbage gets `400`.
  - **Existence checks** server-side: missing region → `404 Region does not exist`;
    `P2003` caught → `404 Website does not exist` (no more 500s).
  - Key lives in local `.env` (dev) and **Secret Manager** (prod, injected via Cloud Build
    `--set-secrets`), never in git.
- **Interview talking points:** separating the *public* API surface from the *internal* one;
  constant-time comparison and why naive `===` leaks timing; input validation as a
  robustness tool, not just a security tool (500 → 4xx); secrets-in-Secret-Manager.

## 4. `POST /website` accepted arbitrary URLs (SSRF) with no rate limit

- **How it surfaced:** the "add website" endpoint validated nothing. Because the **consumer
  probes URLs server-side** (plain `axios.get`), the app is literally an SSRF engine —
  users could point it at internal infrastructure.
- **Why it's bad:** `http://localhost:xxxx`, `http://127.0.0.1`, `http://169.254.169.254/…`
  (cloud metadata), or a public hostname that **resolves** to a private IP (e.g.,
  `127.0.0.1.nip.io`) would be probed by our own worker — and the result even persisted as a
  tick. Unbounded adds also let one user flood the system.
- **The fix (defense in depth):**
  - Protocol/literal checks: `http`/`https` only, no URL-embedded credentials, reject IP
    literals that are private/reserved (IPv4 + IPv6, incl. `::ffff:`-mapped IPv4).
  - Reject `localhost`, `.local`, `.internal`, `.localhost`.
  - **DNS-resolution check:** look up the hostname, and if *any* resolved address is
    private/loopback → reject. This catches the `nip.io`/NAT/CNAME bypasses.
  - Per-user rate limit (20 adds/hour, in-memory sliding window) + hard cap of 25 sites/user.
- **Interview talking points:** what SSRF is and the "probe as an SSRF oracle" angle; why you
  must validate *resolved* addresses, not just the hostname string; rate limiting vs. caps;
  in-memory limiter caveats on multi-instance deployments.

## 5. Consumer probe had no timeout; down sites probed every 60 s forever

- **How it surfaced:** "down" isn't always a fast error. A firewall that **silently drops**
  packets makes a request hang indefinitely — with axios `timeout: 0` (the default), the
  consumer sat on one job forever, stuck. Meanwhile the producer queued **every** site every
  60 s regardless of state, so a site down for a week got hammered 1440 times/day.
- **Why it's bad:** one hanging site stalls a whole region's consumer; constant polling of
  dead services wastes bandwidth/CPU/queue and hammers whoever owns the down site.
- **The fix:**
  - **Probe deadline:** `axios.get(url, { timeout: 10_000 })` → gives up after 10 s, classifies
    `Down`, moves on.
  - **Exponential backoff** in the producer: the monitoring feed now returns each site's
    `lastStatus` + `lastCheckedAt`; the producer tracks a `consecutiveDown` counter per site
    and skips Down sites until `min(5min × 2ⁿ, 20min)` since their last check has elapsed.
    Recheck cadence ≈ 5 min → 10 min → 20 min → 20 min-capped. The counter increments only
    on an actual re-probe, so the schedule stays 5/10/20 instead of drifting.
- **Interview talking points:** *fail fast* — external calls need deadlines; `timeout: 0`
    default; why backoff (exponential, capped) is preferable to fixed-rate re-checking;
    feeding monitoring state back into the scheduler.

## 6. Redis stream grew unbounded; orphaned jobs never retried; duplicate setup

- **How it surfaced:** a Redis stream is append-only; messages accumulate even after being
  acked (ack ≠ delete). Additionally, `XREADGROUP ... >` only hands out *never-read*
  messages, so if a consumer died mid-job, its read-but-unacked message was **permanently
  locked** to it — that website silently stopped being monitored. Also, the consumer's
  group-init code called `xGroupCreate` twice.
- **The fix:**
  - **`XTRIM statusbus:web MAXLEN ~ 100000`** after each batch (`~` = lazy/approximate trim)
    bounds memory forever.
  - **`XAUTOCLAIM`** at the top of every consumer loop: reassigns pending messages idle for
    > 5 min to the calling consumer (they're definitely abandoned — normal probes take ≤10 s),
    then processes them like new jobs and acks. Dead-worker work is recovered.
  - Removed the duplicate `xGroupCreate` (the first call already handles `BUSYGROUP`).
- **Interview talking points:** stream vs list semantics; PEL (pending entries list) vs the
  log; why "at-least-once" needs idempotent consumers + ack-based progress; `XAUTOCLAIM`
  min-idle choice; `XGROUP ... MKSTREAM`.

---

## Patterns you can extract (one-liners)

1. External inputs need **validation, rate limits, and deadlines** — always.
2. Separate **public** API surface from **internal** control-plane endpoints.
3. **Fail with clean 4xx/5xx**, never a raw DB/Prisma error.
4. Shared secrets get **constant-time comparison** and live in Secret Manager, not git.
5. **At-least-once** processing demands idempotent handlers, acks, and a re-claim mechanism.
6. Bounded queues (stream trim) and **exponential, capped backoff** keep a system stable
   under sustained failure.
7. Bug fixes discovered organically → also a checklist for the *system-design* round:
   every one of these is a "what happens when X breaks?" question.

## Repo pointers

- `apps/api/index.ts`, `apps/api/middleware.ts`, `apps/api/types.ts`,
  `apps/api/lib/validateUrl.ts`
- `apps/producer/index.ts`, `apps/consumer/index.ts`, `packages/redisq/index.ts`
- `SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOW.md`