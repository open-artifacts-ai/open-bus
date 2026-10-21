#!/usr/bin/env bash
# Delete Worker secrets that are also config vars (a var+secret clash breaks
# `wrangler deploy`). Targets apps/server's wrangler.jsonc; WRANGLER_CONFIG
# overrides for tests.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export WRANGLER_CONFIG="${WRANGLER_CONFIG:-$root/apps/server/wrangler.jsonc}"
names=$(pnpm exec wrangler secret list -c "$WRANGLER_CONFIG" --format json | node "$root/scripts/ops/conflicting-secrets.ts")
for name in $names; do
  echo "deleting conflicting secret: $name"
  echo y | pnpm exec wrangler secret delete "$name" -c "$WRANGLER_CONFIG" > /dev/null
done
