#!/usr/bin/env bash
# Records staging's non-secret instance values as repo variables, from the state
# file `pnpm -s ob:setup --name open-bus-staging` wrote. Prints only names.
# Usage: staging-vars.sh   (needs gh authenticated with write access to variables)
set -euo pipefail
state="${HOME}/.openbus/setup-open-bus-staging.json"
[ -f "$state" ] || { echo "no $state; run: pnpm -s ob:setup --json --name open-bus-staging --host staging.open-bus.ai --owner-email <owner>" >&2; exit 1; }

# var name -> state key
pairs=(
  STAGING_OWNER_EMAIL:ownerEmail
  STAGING_ACCESS_TEAM_DOMAIN:teamDomain
  STAGING_ACCESS_CLIENT_ID:accessClientId
)
values=()
for p in "${pairs[@]}"; do
  key="${p#*:}"
  v=$(jq -r --arg k "$key" '.[$k] // empty' "$state")
  [ -n "$v" ] || { echo "state file has no $key; finish setup first" >&2; exit 1; }
  values+=("$v")
done
i=0
for p in "${pairs[@]}"; do
  name="${p%%:*}"
  # gh output is discarded: it can echo the value.
  gh variable set "$name" --body "${values[$i]}" > /dev/null 2>&1 || { echo "gh variable set $name failed" >&2; exit 1; }
  echo "set $name"
  i=$((i + 1))
done
