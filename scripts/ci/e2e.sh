#!/usr/bin/env bash
# The CI e2e job (no secrets; the real suite runs a local `wrangler dev` only).
#   e2e.sh version  -> playwright=<version of @ob/dashboard's @playwright/test> to $GITHUB_OUTPUT
#   e2e.sh install  -> Chromium and WebKit with their OS deps
#   e2e.sh hosts    -> app.localhost and content.localhost resolve to 127.0.0.1
#   e2e.sh mock|real -> one suite, html report in playwright-report/<suite>
#   e2e.sh ui       -> @ob/ui real-browser checks (axe contrast, focus outlines)
#   e2e.sh landing  -> landing real-browser checks (no horizontal overflow)
# A suite whose package is not on disk yet exits 0 with "skip:" — the e2e check
# passes while tracks land their suites (01-foundation F3a). E2E_DASHBOARD,
# E2E_UI and E2E_LANDING override the package dirs (used by tests).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
hosts_file="${HOSTS_FILE:-/etc/hosts}"
dashboard="${E2E_DASHBOARD:-$root/apps/dashboard}"
ui="${E2E_UI:-$root/packages/ui}"
landing="${E2E_LANDING:-$root/apps/landing}"

have() { [ -f "$1/package.json" ] || { echo "skip: $2 not present yet" >&2; exit 0; }; }

case "${1:-}" in
  version)
    have "$dashboard" apps/dashboard
    v="$(node -p "require('$dashboard/node_modules/@playwright/test/package.json').version")"
    echo "playwright=$v" >> "$GITHUB_OUTPUT"
    ;;
  install)
    have "$dashboard" apps/dashboard
    pnpm --filter @ob/dashboard exec playwright install --with-deps chromium webkit
    ;;
  hosts)
    # systemd-resolved already maps *.localhost; this makes it independent of the resolver.
    grep -q "app.localhost content.localhost" "$hosts_file" ||
      echo "127.0.0.1 app.localhost content.localhost" | sudo tee -a "$hosts_file" > /dev/null
    ;;
  mock)
    have "$dashboard" apps/dashboard
    PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/mock \
      pnpm --filter @ob/dashboard exec playwright test --reporter=list,html
    ;;
  real)
    have "$dashboard" apps/dashboard
    PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/real \
      pnpm --filter @ob/dashboard exec playwright test -c playwright.real.config.ts
    ;;
  ui)
    have "$ui" packages/ui
    pnpm --filter @ob/ui test:browser
    ;;
  landing)
    have "$landing" apps/landing
    pnpm --filter @ob/landing test:browser
    ;;
  *)
    echo "usage: e2e.sh version|install|hosts|mock|real|ui|landing" >&2
    exit 2
    ;;
esac
