# Releases

release-please keeps one release PR open on `main`. The `release-cadence`
workflow (`scripts/ci/release-cadence.ts`) arms it with auto-merge once its
checks are green and the merge queue holds nothing but release PRs, or once it
has been green for 30 minutes. The merge publishes `@open-bus/cli` to npm and
upgrades prod from CI (`deploy-prod`, then `verify-release`).

## Holding a release

To keep a release from shipping, such as while a fix for a just-merged bug is
still in review, put the `release-hold` label on the release PR:

    gh pr edit <release PR> --add-label release-hold

While the label is on:

- `plan` does not arm the PR.
- `arm` re-reads the labels right before it enqueues, so a hold set during a
  run still wins.
- If the cadence already armed the PR and it is not yet in the queue, the next
  run disables auto-merge. It never touches an arm a person set.
- Once the PR is in the merge queue, the label no longer stops it. Remove it
  from the queue in GitHub instead.

Remove the label to release. The next cadence run (every 15 minutes, or after
CI) arms the PR as usual:

    gh pr edit <release PR> --remove-label release-hold

A held release PR that stays open for over 24 hours still gets a `blocker`
issue, as a reminder that the hold is on.
