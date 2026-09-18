#!/usr/bin/env bash
# StatusBus — report Upstash Redis usage via the INFO stats command.
# Shows total commands executed, uptime, and a free-tier headroom estimate
# (Upstash free tier: 500K commands / month).
#
# Requires bun (or node) with access to the `redis` npm package from the repo.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
REDIS_PKG="$REPO_ROOT/packages/redisq/node_modules/redis"

# Source variables.env for PROJECT_ID.
[ -f "$HERE/variables.env" ] || HERE="$HERE/.."
# shellcheck source=/dev/null
. "$HERE/variables.env"

log() { echo "[upstash-stats] $*"; }

log "reading REDIS_URL from Secret Manager"
REDIS_URL="$(gcloud secrets versions access latest --secret=statusbus-redis-url --project="$PROJECT_ID" 2>/dev/null)"

BUN="${BUN:-bun}"
if ! command -v "$BUN" >/dev/null 2>&1; then
  echo "[upstash-stats] bun not found; install bun or set BUN" >&2
  exit 1
fi

log "connecting to Upstash"
REDIS_URL="$REDIS_URL" "$BUN" -e "
import { createClient } from '$REDIS_PKG';

const client = createClient({ url: process.env.REDIS_URL })
  .on('error', (err) => { console.error('ERR', err.message); process.exit(1); });
await client.connect();

const statsRaw = await client.info('stats');
const memRaw   = await client.info('memory');
const srvRaw   = await client.info('server');
await client.quit();

const parse = (s) => Object.fromEntries(
  s.split(/\r?\n/).filter(l => l && !l.startsWith('#')).map(l => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1)]; })
);

const stats = parse(statsRaw);
const mem   = parse(memRaw);
const srv   = parse(srvRaw);

const cmds    = Number(stats.total_commands_processed ?? 0);
const uptimeS = Number(stats.uptime_in_seconds ?? srv.uptime_in_seconds ?? 0);
const daysUp  = Math.max(1, uptimeS / 86400);
const monthEstimate = Math.round(cmds * 30 / daysUp);

console.log(JSON.stringify({
  timestamp: new Date().toISOString(),
  total_commands_processed: cmds,
  uptime_days: Math.round(daysUp),
  used_memory: mem.used_memory_human ?? 'unknown',    
  est_commands_per_30_days: monthEstimate,
  free_budget_per_month: 500000,
  within_free_tier: monthEstimate <= 500000
}, null, 2));
process.exit(0);
" 2>&1