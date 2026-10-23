#!/usr/bin/env bash
# Staging smoke checks. Usage: staging-smoke.sh healthz <base-url> [version]
# /healthz must answer JSON with a "version" field; when a version is given it
# must match exactly, polled until it does (SMOKE_WAIT_S, default 180 s). Checks are added here as the surface grows (see
# docs/ops/testing.md); robots and login checks return with the landing and
# the Access login (tracks B and 06).
set -euo pipefail
check="${1:?check required}"
base="${2:?base url required}"
retry=(--retry 20 --retry-delay 5 --retry-max-time 180 --retry-all-errors)

case "$check" in
  healthz)
    body=$(curl -fsS "${retry[@]}" "$base/healthz")
    echo "$body"
    if [ -n "${3:-}" ]; then
      # A deploy takes a while to reach every edge: poll until the expected
      # version is served, up to SMOKE_WAIT_S (default 180 s).
      deadline=$((SECONDS + ${SMOKE_WAIT_S:-180}))
      until grep -q "\"version\":\"$3\"" <<< "$body"; do
        if [ "$SECONDS" -ge "$deadline" ]; then
          echo "::error::/healthz reported $body, expected version $3"; exit 1
        fi
        sleep "${SMOKE_INTERVAL_S:-5}"
        body=$(curl -fsS "${retry[@]}" "$base/healthz")
        echo "$body"
      done
    else
      grep -q '"version"' <<< "$body" || { echo "::error::/healthz did not report a version"; exit 1; }
    fi
    ;;
  *) echo "unknown check: $check" >&2; exit 2 ;;
esac
