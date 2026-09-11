# Security

StatusBus treats authentication, secrets, and its internal monitoring pipeline as
first-class security surfaces. The following measures are implemented to keep the
application secure and robust.

## Authentication

- **Password hashing (bcrypt)** — user passwords are never stored in plaintext.
  Signup hashes with bcrypt (cost 10). Signin verifies with a constant-time `bcrypt.compare`.
- **Legacy plaintext migration** — pre-existing plaintext accounts are automatically
  upgraded to bcrypt hashes on their next successful sign-in, so no accounts are orphaned.
- **Short-lived JWTs** — tokens expire after **7 days** (`expiresIn: "7d"`); expired or
  tampered tokens are rejected with `401`.
- **Strict `Bearer` token parsing** — the auth middleware only accepts a properly formed
  `Authorization: Bearer <token>` header. Raw or malformed tokens are rejected with `401`
  instead of being silently verified.

## Internal monitoring endpoints

The worker pipeline (producer + consumer) talks to two endpoints the public never needs:

- `GET /monitoring/websites` — the full list of monitored websites
- `POST /monitoring/tick` — recording probe results

These are protected by the **`x-internal-key` shared-secret header**:

- The API compares the header against `INTERNAL_KEY` using a constant-time comparison
  (`crypto.timingSafeEqual`) to resist timing attacks.
- Any request without a valid key is rejected with `401`, so the site list cannot be
  scraped and no external caller can forge or spam monitoring results.
- Tick payloads are strictly validated (zod): `website_id` must be a UUID, `rt_ms` a
  non-negative integer, and `status` one of `Up`/`Down`. Invalid payloads are rejected
  with `400`.
- Referential integrity is checked server-side: ticks for a missing region or a stale
  (deleted) website return `404` with a clear error instead of a `500` database error.

### Where the key lives

- **Local dev / workers:** `INTERNAL_KEY` in the repo-local `.env` (gitignored); wired into
  `docker-compose.yml` and `docker-compose.cloudworkers.yml`.
- **Cloud Run (production):** stored as the `statusbus-internal-key` secret in Secret
  Manager and injected via `--set-secrets` in `cloudbuild/statusbus-api.yaml`. The API
  service account holds `roles/secretmanager.secretAccessor` on it.
- Applies to **secrets in general**: production `DATABASE_URL` and `JWT_SECRET` are also in
  Secret Manager; nothing production-related is committed to the repository.

## General posture

- Strict CORS allowlist (only the StatusBus domain and `localhost:3000`).
- The Redis queue and local database are only reachable on the local network; the public
  API exposes a minimal surface (auth, website CRUD, status, health).
- **Website URL validation + rate limiting** — new sites must be public `http(s)`; IPs and
  hostnames that are private, loopback, or resolve to private addresses are rejected, and
  per-user add rate limits plus a hard site cap prevent abuse. This closes the SSRF hole a
  monitoring system's probes could otherwise be. See
  [docs/DEVELOPMENT-CHALLENGES.md](docs/DEVELOPMENT-CHALLENGES.md).