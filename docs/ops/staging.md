# Staging

Public (no Access gate). Worker `open-bus-staging`; host `https://open-bus-staging.<subdomain>.workers.dev`, where `<subdomain>` is the account's workers.dev subdomain (read from the Workers API at deploy time, never hardcoded). `ENVIRONMENT=production` — staging never runs dev mode.

## Resources (no secrets)

| Resource | Name | Notes |
|---|---|---|
| Worker | `open-bus-staging` | name pinned in `apps/server/wrangler.jsonc` (02-backend.md) |
| Durable Object | `Hub` | created by the migrations in `wrangler.jsonc` at deploy |

No D1, R2 or KV (spec §Architecture: not used). Config: `apps/server/wrangler.jsonc` —
single-env, top-level `vars`, Durable Object migrations applied by `wrangler deploy`
itself. There is no `--env staging` anywhere.

## GitHub secrets

| Secret | Used by | Needed for |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | deploy-staging | Account \| Workers Scripts: Edit |
| `CLOUDFLARE_ACCOUNT_ID` | deploy-staging | the account owning the Worker |
| `RELEASE_APP_ID` | release-please, release-cadence | the release GitHub App |
| `RELEASE_APP_PRIVATE_KEY` | release-please, release-cadence | same |

The first two are tracked as blocker issue #4. Never put a secret in an issue or a PR:
ask for `! gh secret set …` instead (`scripts/ob-blocker.sh` files the request).

## Deploy

`deploy-staging.yml` on every push to `main`: install, build, `scripts/ci/ensure-dashboard-dist.sh`,
preflight (required Worker secrets, `scripts/ci/staging-preflight.sh`), clear secrets
that clash with config vars (`scripts/ci/staging-clear-conflicts.sh`), then

```sh
pnpm --filter @ob/server exec wrangler deploy -c wrangler.jsonc \
  --var "APP_HOST:<host>" --var "VERSION:<version>-<sha>"
```

`APP_HOST` and `VERSION` are written at deploy time (they are account-specific and
release-specific; see the comment in `wrangler.jsonc`). Both jobs gate on
`apps/server/wrangler.jsonc` existing and skip cleanly before Backend's first task
lands — a red staging pauses merges for everyone (00-overview §Delivery).

Manual deploy:

```sh
cd apps/server
pnpm exec wrangler deploy -c wrangler.jsonc
```

## Smoke

`deploy-staging.yml`'s `smoke` job runs after every deploy:

```sh
bash scripts/ci/staging-smoke.sh healthz "<host>" "<version>"
```

`/healthz` must answer JSON with a `"version"` field matching the deployed version.
The `robots` and `login` checks return when the landing and the Access login exist
(tracks B and 06). There is no analytics step: deployed instances send no telemetry
(spec §Anti-goals).

## Repo settings

Applied by task F4d (01-foundation.md step 4) once the workflows are on `main`:

- **Branch protection / ruleset `main`** (target: `branch`, `refs/heads/main`): require
  a pull request, the merge queue (`min_entries_to_merge: 1`, `max_entries_to_merge: 5`,
  `build_concurrency: 1`, `min/max_entries_to_merge_wait_minutes: 5/10`), and strict
  required status checks `lint`, `typecheck`, `test`, `build`, `e2e`. `bypass_actors: []`
  — admins are held to the same rules (00-overview §Delivery).
- **Settings → Actions → General:** "Allow GitHub Actions to create and approve pull
  requests" must be ON — release-please opens the release PR with the App token.
- **Auto-merge** (`allow_auto_merge`) must be ON for `gh pr merge --squash --auto`.
  The API refused it at F1 time (likely an org-level default); set it in the console
  if `gh api -X PATCH … -F allow_auto_merge=true` still answers `false`.
- **Label `blocker`** exists (created on first use by `scripts/ob-blocker.sh`).

## Releases

`release-please.yml` keeps a release PR open (release App token — `GITHUB_TOKEN` PRs
never trigger CI). `release-cadence.yml` arms it for auto-merge once its checks are
green and the queue holds no other entries, and opens one `blocker` issue while a
release is stuck. Release-only PRs take the CI fast path: `scripts/ci/release-only.ts`
is copied from the **base** commit and the heavy jobs skip their heavy steps.

`deploy-prod` and `verify-release` stay skipped until 06-integration sets
`vars.PROD_ENABLED`, `vars.PROD_APP_HOST` and friends (the user's own instance at M3,
with `scripts/ci/prod-setup.sh` next to them). Pre-release tags never deploy.

**If staging goes red after a merge, merges pause until it is green again.** Platform
watches staging and owns the pipeline.
