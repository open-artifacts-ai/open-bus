#!/usr/bin/env bash
# The CI e2e job (no secrets; the real suite runs a local `wrangler dev` only).
#   e2e.sh version  -> playwright=<version of @ob/dashboard's @playwright/test> to $GITHUB_OUTPUT
#   e2e.sh install  -> Chromium and WebKit with their OS deps
#   e2e.sh hosts    -> app.localhost and content.localhost resolve to 127.0.0.1
#   e2e.sh mock|real -> one suite, html report in playwright-report/<suite>
#   e2e.sh ui       -> @ob/ui real-browser checks (axe contrast, focus outlines)
#   e2e.sh landing  -> landing real-browser checks (no horizontal overflow)
# A suite whose package, Playwright install or test:browser script is not there
# yet exits 0 with "skip:" — the e2e check passes while tracks land their suites
# (01-foundation F3a). E2E_DASHBOARD,
# E2E_UI and E2E_LANDING override the package dirs (used by tests).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
hosts_file="${HOSTS_FILE:-/etc/hosts}"
dashboard="${E2E_DASHBOARD:-$root/apps/dashboard}"
ui="${E2E_UI:-$root/packages/ui}"
landing="${E2E_LANDING:-$root/apps/landing}"

skip() { echo "skip: $1" >&2; exit 0; }
have() { [ -f "$1/package.json" ] || skip "$2 not present yet"; }
# The dashboard suites need @playwright/test installed in apps/dashboard.
have_pw() {
  have "$dashboard" apps/dashboard
  [ -f "$dashboard/node_modules/@playwright/test/package.json" ] ||
    skip "apps/dashboard has no @playwright/test yet"
}
# ui and landing need a test:browser script in their package.json.
have_browser() {
  have "$1" "$2"
  node -e 'process.exit(require(process.argv[1]).scripts?.["test:browser"] ? 0 : 1)' "$1/package.json" ||
    skip "$2 has no test:browser script yet"
}

case "${1:-}" in
  version)
    have_pw
    v="$(node -p "require('$dashboard/node_modules/@playwright/test/package.json').version")"
    echo "playwright=$v" >> "$GITHUB_OUTPUT"
    ;;
  install)
    have_pw
    # Playwright's --with-deps installs ~190 apt packages for WebKit. The
    # runner's Azure mirror sometimes trickles or stalls (no apt timeout
    # catches a trickle), so: bound fetches and lock waits, reuse cached
    # .debs, and on a failed attempt kill the stuck apt, repair dpkg and
    # retry from archive.ubuntu.com. APT_* overrides are for tests;
    # APT_CONF_DIR="" skips touching the system's apt entirely.
    apt_dir="${APT_CONF_DIR-/etc/apt/apt.conf.d}"
    archives="${APT_ARCHIVES:-/var/cache/apt/archives}"
    sources="${APT_SOURCES:-/etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list}"
    debs="${APT_DEBS_DIR:-$HOME/.cache/ob-apt-debs}"
    if [ -n "$apt_dir" ] && [ -d "$apt_dir" ]; then
      printf '%s\n' 'Acquire::Retries "5";' 'Acquire::http::Timeout "30";' \
        'Acquire::https::Timeout "30";' 'DPkg::Lock::Timeout "60";' \
        'Binary::apt::APT::Keep-Downloaded-Packages "true";' |
        sudo tee "$apt_dir/99openbus-timeouts" > /dev/null
      # Seed apt's cache from the debs a previous green run saved.
      if compgen -G "$debs/*.deb" > /dev/null; then
        sudo cp "$debs"/*.deb "$archives"/
        echo "seeded $(ls "$debs"/*.deb | wc -l | tr -d ' ') cached .debs"
      fi
    fi
    for attempt in 1 2 3; do
      if [ "$attempt" -gt 1 ] && [ -n "$apt_dir" ]; then
        # The timed-out attempt's root apt-get may still hold the dpkg lock.
        sudo pkill -x apt-get || true
        sudo pkill -x apt || true
        sleep 2
        sudo dpkg --configure -a || true
        for f in $sources; do
          [ -f "$f" ] || continue
          sudo sed -i -E \
            -e 's#mirror\+file:/etc/apt/apt-mirrors\.txt#http://archive.ubuntu.com/ubuntu/#g' \
            -e 's#https?://azure\.archive\.ubuntu\.com/ubuntu/?#http://archive.ubuntu.com/ubuntu/#g' "$f"
        done
        echo "attempt $attempt: retrying from archive.ubuntu.com"
      fi
      if timeout "${INSTALL_TIMEOUT_S:-420}" pnpm --filter @ob/dashboard exec playwright install --with-deps chromium webkit; then
        if [ -n "$apt_dir" ] && compgen -G "$archives/*.deb" > /dev/null; then
          mkdir -p "$debs" && cp "$archives"/*.deb "$debs"/ 2> /dev/null || true
        fi
        exit 0
      fi
      echo "::warning::playwright install attempt $attempt failed or timed out"
    done
    echo "::error::playwright install failed 3 times"
    exit 1
    ;;
  hosts)
    # systemd-resolved already maps *.localhost; this makes it independent of the resolver.
    grep -q "app.localhost content.localhost" "$hosts_file" ||
      echo "127.0.0.1 app.localhost content.localhost" | sudo tee -a "$hosts_file" > /dev/null
    ;;
  mock)
    have_pw
    PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/mock \
      pnpm --filter @ob/dashboard exec playwright test --reporter=list,html
    ;;
  real)
    have_pw
    [ -f "$dashboard/playwright.real.config.ts" ] || skip "apps/dashboard has no playwright.real.config.ts yet (FE9)"
    PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/real \
      pnpm --filter @ob/dashboard exec playwright test -c playwright.real.config.ts
    ;;
  ui)
    have_browser "$ui" packages/ui
    pnpm --filter @ob/ui test:browser
    ;;
  landing)
    have_browser "$landing" apps/landing
    pnpm --filter @ob/landing test:browser
    ;;
  *)
    echo "usage: e2e.sh version|install|hosts|mock|real|ui|landing" >&2
    exit 2
    ;;
esac
