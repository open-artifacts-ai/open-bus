# Contributing

Rules for everyone working in this repo, people and agents alike.

## Git

- **Never use `git stash`.** The stash is shared by every worktree of a clone, so a
  `pop` in one worktree can apply or drop someone else's work. Commit work in progress
  to your own branch instead.
- One task per branch and PR. Branch from an up-to-date `origin/main`.
- Branch names: `<track>/<task-id>-<slug>`, with the tracks `fo`, `be`, `de`, `fe`,
  `cl`, `in` (foundation, backend, design, frontend, client, integration).
- Never force-push. Never merge with `--no-verify`.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
`docs:`, `ci:`, `test:`, `chore:`; add `!` for breaking changes). release-please uses
them to build the changelog and choose the next version.

## Pull requests

- One task, one PR. Split anything over about 400 changed lines into stacked PRs.
- **Titles** are Conventional Commits, scoped to one of `shared`, `server`, `hub`,
  `dashboard`, `ui`, `landing`, `cli`, `daemon`, `adapters`, `setup`, `ci`, `e2e`.
  Repo-level work (scaffold, docs, this file) is unscoped `chore:` or `docs:`.
- **Bodies** carry:
  - the task id and a link to the plan
  - pasted test output
  - a summary of the adversarial review
  - light and dark screenshots for UI changes
  - the attribution footer: `Attribution: <session name> (<harness>), <plan file>, task <id>`

## Merging

- `gh pr merge <number> --squash --auto`, through the merge queue. The queue re-runs
  the required checks (lint, typecheck, test, build, e2e) on top of `main` and
  squash-merges once they pass. You do not need to update your branch first.
- No admin bypass. If staging goes red after a merge, merges pause until it is green
  again. Platform watches staging and owns the pipeline.

## Contract changes

`packages/shared`, the REST routes, the wire frames and the `packages/ui` exports are
contracts. The owner messages the manager and every affected lead before merging,
saying what changed, why, and how to migrate. Nobody edits another track's package;
ask its owner.

## Releases

release-please keeps a release PR open that only bumps versions (`CHANGELOG.md`,
`.release-please-manifest.json`, and the `"version"` field of `package.json`). Such a
PR takes a fast path through CI: `scripts/ci/release-only.ts` decides, from the base
commit, that nothing needing full CI changed, and the heavy jobs skip their heavy
steps. The `release-cadence` workflow arms the release PR for auto-merge once its
checks are green and the merge queue holds no other entries, and opens a `blocker`
issue while a release is stuck. Releasing publishes the GitHub release and the
`open-bus` npm package. The deploy pipeline is in `docs/ops/staging.md`.

## Secrets

Never put a secret in an issue, a PR or a commit. Ask for `! gh secret set …`
instead. Anything that needs the user goes through `scripts/ob-blocker.sh`.
