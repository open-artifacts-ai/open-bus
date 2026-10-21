#!/usr/bin/env bash
# File a blocker for the repo owner: an issue labeled "blocker", assigned to
# leourbina. The label is created if the repo does not have it yet.
#
# Usage: scripts/ob-blocker.sh "<session name>" "<short title>" "<what you need and why>"
#   e.g. scripts/ob-blocker.sh "OpenBus Platform" "Cloudflare token for staging" "F4 needs …"
# Never put a secret in the body: ask for `! gh secret set …` instead.
set -euo pipefail

REPO="open-artifacts-ai/open-bus"
OWNER="leourbina"

if [[ $# -ne 3 ]]; then
  echo "usage: $0 \"<session name>\" \"<short title>\" \"<body>\"" >&2
  exit 64
fi
session="$1" title="$2" body="$3"

gh label create blocker --color D93F0B \
  --description "A human action is blocking work" >/dev/null 2>&1 || true

gh issue create -R "$REPO" \
  --title "[$session] $title" \
  --label blocker \
  --assignee "$OWNER" \
  --body "$(printf '**Raised by:** %s\n\n%s\n\n---\nClose this issue (or comment) when unblocked; the raising session watches it.' "$session" "$body")"
