#!/usr/bin/env bash
# Instance setup via @ob/setup (`pnpm ob:setup`). Never prints an ob_machine_ token,
# OB_ACCESS_TOKEN or CLOUDFLARE_API_TOKEN (read by setup from env or ~/.openbus).
# Usage: prod-setup.sh <install|preflight|upgrade|cleanup>   (reads PROD_NAME, PROD_APP_HOST, PROD_OWNER_EMAIL)
#        prod-setup.sh <scratch-install|scratch-destroy>     (reads SCRATCH_NAME, SCRATCH_HOST, PROD_OWNER_EMAIL)
# scratch-install and scratch-destroy keep setup's state file in ~/.openbus, so they
# must run in the same job, on the same runner and HOME (otherwise destroy finds no state).
# The scratch modes run the same wrapper (token scan, status handling) and refuse the prod name and host.
set -uo pipefail

command -v jq > /dev/null || { echo "jq is required" >&2; exit 1; }
# Lowercased and trimmed, so a guard compares what DNS would.
norm() {
  local s
  s=$(printf %s "$1" | tr "[:upper:]" "[:lower:]")
  s="${s#"${s%%[![:space:]]*}"}"
  echo -n "${s%"${s##*[![:space:]]}"}"
}

mode="${1:-}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
case "$mode" in
  install | preflight | upgrade | cleanup)
    : "${PROD_NAME:?}" "${PROD_APP_HOST:?}" "${PROD_OWNER_EMAIL:?}"
    NAME="$PROD_NAME" HOST="$PROD_APP_HOST"
    ;;
  scratch-install | scratch-destroy)
    # A scratch instance must never target the production or staging Worker or
    # their hosts (I8-11).
    sn=$(norm "${SCRATCH_NAME:-}") sh=$(norm "${SCRATCH_HOST:-}")
    pn=$(norm "${PROD_NAME:-@}") ph=$(norm "${PROD_APP_HOST:-@}")
    if [[ "$sn" == "open-bus-prod" || "$sn" == "$pn" || "$sh" == "bus.leourbina.com" || "$sh" == "$ph" ]]; then
      echo "scratch setup refuses the production name or host" >&2
      exit 2
    fi
    if [[ "$sn" == "open-bus-staging" || "$sh" == "staging.open-bus.ai" ]]; then
      echo "scratch setup refuses the staging name or host" >&2
      exit 2
    fi
    : "${SCRATCH_NAME:?}" "${SCRATCH_HOST:?}" "${PROD_OWNER_EMAIL:?}"
    NAME="$SCRATCH_NAME" HOST="$SCRATCH_HOST"
    ;;
  *) echo "usage: $0 <install|preflight|upgrade|cleanup|scratch-install|scratch-destroy>" >&2; exit 2 ;;
esac

case "$mode" in
  install) mode_args=(--ci --name "$NAME" --host "$HOST" --owner-email "$PROD_OWNER_EMAIL") ;;
  # Scratch keeps its state file (--ci skips it), so scratch-destroy finds the instance.
  scratch-install) mode_args=(--json --name "$NAME" --host "$HOST" --owner-email "$PROD_OWNER_EMAIL") ;;
  preflight) mode_args=(--check --json --name "$NAME" --host "$HOST" --owner-email "$PROD_OWNER_EMAIL") ;; # read-only; exit 2 if absent or drifted
  upgrade) mode_args=(--ci --upgrade --name "$NAME" --host "$HOST" --owner-email "$PROD_OWNER_EMAIL") ;;
  scratch-destroy) mode_args=(--json --name "$NAME" --destroy --yes-destroy "$NAME") ;;
  cleanup)
    # Setup mints no CI-scoped tokens (no revoke flag): nothing to clean up.
    echo '{"step":"cleanup","status":"skipped","message":"no CI tokens to revoke"}'
    exit 0
    ;;
esac

run_setup() {
  local rc=0
  pnpm -s ob:setup "${mode_args[@]}" 2>&1 || rc=$?
  echo "{\"step\":\"setup-exit\",\"status\":\"$([ $rc = 0 ] && echo ok || echo error)\",\"code\":$rc}"
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
rc=0
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
  if [[ "$step" == setup-exit ]]; then
    rc=$(jq -r '.code // 0' <<<"$line" 2>/dev/null || echo 0)
    # Exit 2 (todo or action required) is judged by the step lines and rc below.
    [[ "$rc" != 0 && "$rc" != 2 ]] && bad=1
    continue
  fi
  case "$status" in
    error | action_required) bad=1 ;;
    todo)
      # In preflight, a newer tag than the one deployed makes the version steps
      # todo: that is the upgrade about to run, not drift (#260). Any other todo
      # is drift: not ready.
      case "$mode:$step" in
        preflight:deploy | preflight:healthcheck | preflight:selftest) version_todo=1 ;;
        *) bad=1 ;;
      esac
      ;;
  esac
done < <(run_setup)

# setup --check exits 2 on any todo; when the only todos are the version steps,
# preflight passes.
[[ "$mode" == preflight && "$rc" == 2 && "$bad" == 0 && "${version_todo:-0}" == 1 ]] && exit 0
# Setup exit 2 (action required, drift) is passed through as 2.
[[ "$rc" == 2 ]] && exit 2
exit "$bad"
