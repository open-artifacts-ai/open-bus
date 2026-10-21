# Testing

How OpenBus is tested and where each kind of test lives. The CI side of this is
`.github/workflows/ci.yml` (jobs `test`, `e2e`); the CPU bar is
`docs/ops/cpu-budget.md`.

## Layout

| Kind | Where | Runner | Naming |
|---|---|---|---|
| Unit and integration | every package's `test/` | vitest (`*.test.ts`), each package its own `vitest.config.ts` | `*.test.ts` |
| Worker + Durable Object | `apps/server/test/` | `@cloudflare/vitest-plugin` (miniflare, in-process bindings) | `*.test.ts` |
| Repo and pipeline invariants | `scripts/**/*.test.ts`, `scripts/ops/*.test.ts`, `scripts/ci/*.test.ts` | root `vitest.config.ts` | `*.test.ts` |
| Real-browser | `apps/dashboard/e2e/`, `apps/landing/test-browser/` | Playwright | `*.spec.ts` |
| CPU budgets | `apps/server/test/code-cpu/` | `pnpm --filter @ob/server test:cpu` (serial) | `*.test.ts` |

`pnpm test` runs the root suite (scripts) and then every package's suite through
`pnpm -r test`. `pnpm typecheck` and `pnpm lint` (biome) run over everything.

## Rules

- **No secrets, no network.** The Worker suite runs a local `wrangler dev` or the
  vitest plugin's in-process bindings (ENVIRONMENT=dev in a generated temp
  config) — never staging (00-overview). Playwright drives a local server only.
- **Hermetic by construction.** A suite that needs files another track owns gets
  fixtures, not real paths: the CI scripts take env overrides
  (`WRANGLER_CONFIG`, `ENV_TS`, `E2E_DASHBOARD`, `E2E_UI`, `E2E_LANDING`,
  `DASHBOARD_DIST`, `HOSTS_FILE`) and their tests point those at fixtures. No
  suite reads another track's working files at import time. See
  `scripts/ci/staging-deploy.test.ts` and `scripts/ci/e2e.test.ts`.
- **Stubs over mocks for shell.** `scripts/ci/stubs.ts` puts fake `pnpm`,
  `sudo`, `curl`, `gh` on PATH and logs argv; assertions are made on the log,
  so a wrong command line fails the test.
- **Secrets never appear in output.** Token-shaped strings in captured output
  fail the suite (`scripts/ci/prod-setup.test.ts` when 06 lands it).
- **The review-focus tests are permanent.** Each failure mode in 00-overview
  §Review Focus has a pinned test in the track that owns the code (identity
  spoofing, namespace leak, reconnect mid-delivery, revoke-while-live, waking a
  closed session). Those tests document intent: rename them, never delete them.

## CPU budgets

`test:cpu` runs **serially** in CI (its own step, outside the parallel suite):
wall-clock CPU cannot be measured under parallel load. The bar and the
measurement method live in `docs/ops/cpu-budget.md`.

## E2E harness

`scripts/ci/e2e.sh` orchestrates the Playwright suites (`version`, `install`,
`hosts`, `mock`, `real`, `ui`, `landing`). A suite whose package is not on disk
yet exits 0 with `skip:` — the `e2e` check passes while tracks land their
suites, and starts reporting for real the moment the package exists. Reports
land in `playwright-report/<suite>` and are uploaded on failure.
