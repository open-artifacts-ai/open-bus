#!/usr/bin/env bash
# Fail if a required Worker secret is missing. Targets apps/server's
# wrangler.jsonc; WRANGLER_CONFIG and ENV_TS override for tests.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export WRANGLER_CONFIG="${WRANGLER_CONFIG:-$root/apps/server/wrangler.jsonc}"
export ENV_TS="${ENV_TS:-$root/apps/server/src/env.ts}"
pnpm exec wrangler secret list -c "$WRANGLER_CONFIG" --format json | node "$root/scripts/ops/check-staging-secrets.ts"
