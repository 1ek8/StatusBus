#!/usr/bin/env bash
# StatusBus — create a GCP budget alert for the worker infrastructure.
# Idempotent. Requires `billingbudgets.googleapis.com` (enabled here) and
# permission to create budgets on the billing account.
#
# The budget is expressed in the *billing account's* currency (this account is
# billed in INR). Default 2500 INR ≈ $30/month; override with --amount=NNNN.
#
#   --amount=2500   budget amount in account currency (default 2500)
#   --email=...     additional email recipient (optional; billing admins get
#                   the default notifications automatically)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

AMOUNT="${1:-2500}"
EXTRA_EMAIL=""
for arg in "$@"; do case "$arg" in
  --amount=*) AMOUNT="${arg#*=}" ;;
  --email=*) EXTRA_EMAIL="${arg#*=}" ;;
esac; done

BILLING_ACCOUNT="$(gcloud billing accounts list --filter=open:true --format='value(name)' 2>/dev/null | head -1)"
if [ -z "$BILLING_ACCOUNT" ]; then
  echo "[create-budget] no open billing account" >&2
  exit 1
fi

CURRENCY="$(gcloud billing accounts describe "$BILLING_ACCOUNT" --format='value(currencyCode)' 2>/dev/null || true)"
CURRENCY="${CURRENCY:-USD}"

# shellcheck source=/dev/null
. "$HERE/variables.env"

BUDGET_NAME="StatusBus-k8s-${AMOUNT}${CURRENCY}"

log() { echo "[create-budget] $*"; }

log "1/3 enabling billingbudgets API"
gcloud services enable billingbudgets.googleapis.com --project="$PROJECT_ID" >/dev/null 2>&1 || true

log "2/3 checking for existing budget"
EXISTING="$(gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" --format='value(displayName)' 2>/dev/null | grep -F "$BUDGET_NAME" || true)"
if [ -n "$EXISTING" ]; then
  log "budget '$BUDGET_NAME' already exists; nothing to do"
else
  log "3/3 creating budget '$BUDGET_NAME' (${AMOUNT} ${CURRENCY}, project $PROJECT_ID)"
  ARGS=(
    --billing-account="$BILLING_ACCOUNT"
    --display-name="$BUDGET_NAME"
    --budget-amount="${AMOUNT}${CURRENCY}"
    --filter-projects="projects/$PROJECT_ID"
    --threshold-rule=percent=0.60
    --threshold-rule=percent=0.90
    --threshold-rule=percent=1.00
  )
  if [ -n "$EXTRA_EMAIL" ]; then
    ARGS+=(--notifications-rule-email-addresses="$EXTRA_EMAIL")
  fi
  gcloud billing budgets create "${ARGS[@]}"
  log "created"
fi