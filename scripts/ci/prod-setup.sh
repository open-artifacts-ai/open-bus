#!/usr/bin/env bash
# Instance setup via @ob/setup (`pnpm ob:setup`). Never prints an ob_machine_ token,
# OB_ACCESS_TOKEN or CLOUDFLARE_API_TOKEN (read by setup from env or ~/.openbus).
# Usage: prod-setup.sh <install|preflight|upgrade|cleanup>   (reads PROD_NAME, PROD_APP_HOST, PROD_OWNER_EMAIL)
#        prod-setup.sh <scratch-install|scratch-destroy>     (reads SCRATCH_NAME, SCRATCH_HOST, PROD_OWNER_EMAIL)
# The scratch modes run the same wrapper (token scan, status handling) and refuse the prod name and host.
set -uo pipefail

mode="${1:-}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
case "$mode" in
  install | preflight | upgrade | cleanup)
    : "${PROD_NAME:?}" "${PROD_APP_HOST:?}" "${PROD_OWNER_EMAIL:?}"
    NAME="$PROD_NAME" HOST="$PROD_APP_HOST"
    ;;
  scratch-install | scratch-destroy)
    # A scratch instance must never target the production Worker or its host.
    if [[ "${SCRATCH_NAME:-}" == "open-bus-prod" || "${SCRATCH_NAME:-}" == "${PROD_NAME:-@}" ||
      "${SCRATCH_HOST:-}" == "bus.leourbina.com" || "${SCRATCH_HOST:-}" == "${PROD_APP_HOST:-@}" ]]; then
      echo "scratch setup refuses the production name or host" >&2
      exit 2
    fi
    : "${SCRATCH_NAME:?}" "${SCRATCH_HOST:?}" "${PROD_OWNER_EMAIL:?}"
    NAME="$SCRATCH_NAME" HOST="$SCRATCH_HOST"
    ;;
  *) echo "usage: $0 <install|preflight|upgrade|cleanup|scratch-install|scratch-destroy>" >&2; exit 2 ;;
esac

case "$mode" in
  install | scratch-install) mode_args=(--ci --name "$NAME" --host "$HOST" --owner-email "$PROD_OWNER_EMAIL") ;;
  preflight) mode_args=(--check --upgrade --name "$NAME" --host "$HOST" --owner-email "$PROD_OWNER_EMAIL") ;; # read-only; exit 2 if absent or drifted
  upgrade) mode_args=(--ci --upgrade --name "$NAME" --host "$HOST" --owner-email "$PROD_OWNER_EMAIL") ;;
  scratch-destroy) mode_args=(--ci --name "$NAME" --destroy --yes-destroy "$NAME") ;;
  cleanup)
    # Setup mints no CI-scoped tokens (no revoke flag): nothing to clean up.
    echo '{"step":"cleanup","status":"skipped","message":"no CI tokens to revoke"}'
    exit 0
    ;;
esac

run_setup() {
  if pnpm -s ob:setup "${mode_args[@]}" 2>&1; then
    echo '{"step":"setup-exit","status":"ok"}'
  else
    echo '{"step":"setup-exit","status":"error"}'
  fi
}

pat='ob_machine_[1-9A-HJ-NP-Za-km-z]+'
trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  echo -n "${s%"${s##*[![:space:]]}"}"
}
# Secrets as given and trimmed: either form leaking aborts.
raws=("${OB_ACCESS_TOKEN:-}" "${CLOUDFLARE_API_TOKEN:-}")
leaks() {
  local r t
  for r in "${raws[@]}"; do
    [[ -z "${r//[[:space:]]/}" ]] && continue
    t=$(trim "$r")
    [[ "$1" == *"$t"* || "$1" == *"$r"* ]] && return 0
  done
  return 1
}
bad=0
{
  echo "| step | status |"
  echo "|---|---|"
} >>"$summary"

while IFS= read -r line; do
  if [[ "$line" =~ $pat ]] || leaks "$line"; then
    echo "token pattern found in output; aborting" >&2
    exit 1
  fi
  echo "$line"
  step=$(jq -r '.step // "?"' <<<"$line" 2>/dev/null || echo "?")
  status=$(jq -r '.status // empty' <<<"$line" 2>/dev/null || true)
  [[ -z "$status" ]] && continue
  echo "| $step | $status |" >>"$summary"
  case "$status" in error | action_required) bad=1 ;; esac
done < <(run_setup)

exit "$bad"
