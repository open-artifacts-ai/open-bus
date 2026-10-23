#!/usr/bin/env bash
# Fail if a required Worker secret is missing. Required = the non-optional
# string fields of apps/server's Env that are not vars (wrangler.jsonc vars or
# deploy-time --var). None required: pass without listing, so the first deploy
# of a Worker that has no secrets yet works. WRANGLER_CONFIG and ENV_TS
# override for tests.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export WRANGLER_CONFIG="${WRANGLER_CONFIG:-$root/apps/server/wrangler.jsonc}"
export ENV_TS="${ENV_TS:-$root/apps/server/src/env.ts}"
check="$root/scripts/ops/check-staging-secrets.ts"
required=$(node "$check" --required)
if [ -z "$required" ]; then
  echo "ok: the Worker declares no required secrets"
  exit 0
fi
err=$(mktemp)
trap 'rm -f "$err"' EXIT
if ! listed=$(pnpm exec wrangler secret list -c "$WRANGLER_CONFIG" --format json 2> "$err"); then
  if grep -q "code: 10007" "$err" || grep -q "code: 10007" <<< "$listed"; then
    echo "::error::missing Worker secrets (no Worker yet): $(tr '\n' ' ' <<< "$required")"
    exit 1
  fi
  cat "$err" >&2
  exit 1
fi
node "$check" <<< "$listed"
