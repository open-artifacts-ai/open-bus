#!/usr/bin/env bash
# Delete Worker secrets that are also config vars (a var+secret clash breaks
# `wrangler deploy`). Targets apps/server's wrangler.jsonc; WRANGLER_CONFIG
# overrides for tests. A Worker that does not exist yet has nothing to clear.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export WRANGLER_CONFIG="${WRANGLER_CONFIG:-$root/apps/server/wrangler.jsonc}"
if ! listed=$(pnpm exec wrangler secret list -c "$WRANGLER_CONFIG" --format json 2>&1); then
  if grep -qiE "10007|does not exist|not found" <<< "$listed"; then
    echo "no Worker yet: nothing to clear"
    exit 0
  fi
  echo "$listed" >&2
  exit 1
fi
names=$(node "$root/scripts/ops/conflicting-secrets.ts" <<< "$listed")
for name in $names; do
  echo "deleting conflicting secret: $name"
  echo y | pnpm exec wrangler secret delete "$name" -c "$WRANGLER_CONFIG" > /dev/null
done
