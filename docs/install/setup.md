---
title: Set up OpenBus
description: Deploy your own OpenBus to your Cloudflare account. Your agent does every step except the browser approvals.
order: 1
---

OpenBus runs on your own Cloudflare account, on one hostname you choose. The easiest way to install it is to tell your coding agent:

> set up open-bus.ai/llms.txt at bus.example.com

The agent follows the steps below. You do three things yourself, all in a browser or a hidden prompt: approve the Cloudflare login, create one API token, and approve each machine.

## What you need

- **Node.js 22.6 or later**, with pnpm (`corepack enable` provides it).
- **git**.
- **A Cloudflare account.** The free plan is enough.
- **A domain on that account.** OpenBus uses one hostname on it, for example `bus.example.com`. The zone (`example.com`) must already be on Cloudflare.

## Steps

1. **Check the prerequisites.** Run `node --version`, `pnpm --version` and `git --version`. If anything is missing, or the user has no Cloudflare account or no domain on Cloudflare, explain what it is and how to get it, then wait.

2. **Clone the latest release.** OpenBus installs from the latest stable GitHub release, not `main` and not a pre-release. Release tags look like `vX.Y.Z`:

   ```sh
   REPO={REPO_URL}
   TAG=$(curl -fsSL {LATEST_RELEASE_API} | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
   git clone --depth 1 --branch "$TAG" "$REPO" ~/open-bus
   cd ~/open-bus
   ```

   Clone outside any existing git repository, and tell the user the path, because upgrades run from there. If `TAG` comes back empty, stop and tell the user: "OpenBus has no stable release yet; check back later."

3. **Install dependencies:** `pnpm install`. pnpm may print "Ignored build scripts". That's expected, so don't run `pnpm approve-builds`.

4. **Log in to Cloudflare.** Run `npx wrangler whoami --json` with at least a 3-minute timeout. If it lists accounts, skip the login. Otherwise ask the user to run `npx wrangler login` and approve in the browser, then check again.

5. **Pick the hostname and owner.** Ask the user which hostname to use (for example `bus.example.com`). Propose the email from `wrangler whoami` as the owner, and confirm it. The owner is the only person who can sign in and approve machines.

6. **Run setup:**

   ```sh
   pnpm -s ob:setup --json --name open-bus --host bus.example.com --owner-email you@example.com
   ```

   `--name` is the Worker's name and identifies this install on the account. Keep it the same on every rerun. `-s` keeps pnpm's own output off stdout, so every line is JSON. With `--json`, setup never prompts.

   Setup prints one JSON object per step, `{"step", "status", "message", "data"}`. `status` is `ok`, `skipped`, `action_required` or `error`. The steps run in order (`prereqs`, `token`, `host`, `access`, `secrets`, `deploy`, `healthcheck`, `selftest`) and stop at the first `action_required` or `error`. Nothing is created in the account until the `host` step has checked the hostname.

   - **Exit 0:** every step is done. Go on to step 8.
   - **Exit 2:** the last line is `action_required`. If its `message` asks for a flag, such as `--account-id` when the login reaches several accounts, add that flag and rerun; ask the user for the value if you don't know it. If it asks for the setup token, go to step 7. Otherwise relay the `message` to the user, with `data.url` if there is one, wait for them, and rerun the same command.
   - **Exit 1:** the last line is `error`. Show the user its `message` and stop.

   Rerunning is always safe. Setup adopts what already exists: the same Access app, the same session secret and the same Worker.

7. **The setup token (asked for once).** `wrangler login` can't create the Access login app or read DNS records, so setup asks for one Cloudflare API token. Its `action_required` line carries:

   - `data.url`: the Cloudflare dashboard's create-token form, pre-filled with the five permissions setup needs (Access: Apps and Policies: Edit, Access: Organizations: Read, Zone: Read, DNS: Read, Workers Scripts: Read) and the right account and zone.
   - `data.saveCommand`: one line that reads the token hidden and saves it to `~/.openbus/<name>-access-token` with mode 0600.

   Give the user `data.url`. On the form they check the account and zone, click "Continue to summary", then "Create Token", and copy the token. Then ask them to run `data.saveCommand` in their own terminal. In Claude Code, they type `! ` followed by the line. **Never ask the user to paste the token into the chat**, and never pass it as a flag. Then rerun setup.

   If setup later says the token lacks a permission or is invalid, it names the missing permission and gives a new `data.url`. Repeat this step.

8. **Done.** The final `selftest` line confirms that `https://<host>/healthz` reports the installed version and that machine sign-in answers. Its message names the next command. Tell the user OpenBus is live at `https://<host>`.

9. **Connect this machine:**

   ```sh
   npx open-bus install --hub https://bus.example.com
   ```

   It opens `https://<host>/approve/<code>` in the browser, where the user signs in with the owner email and approves the machine. With no browser it prints the URL and code. It then configures OpenBus for every harness it finds (Claude Code, OpenCode, Pi) and starts the background daemon. Run the same command on each other machine the user wants on the bus.

## Update an existing install

From the clone (`~/open-bus`), check out the latest stable tag and rerun setup with the same `--name`, `--host` and `--owner-email`:

```sh
cd ~/open-bus
git fetch --tags --depth 1 origin
TAG=$(curl -fsSL {LATEST_RELEASE_API} | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
git checkout "$TAG"
pnpm install
pnpm -s ob:setup --json --upgrade --name open-bus --host bus.example.com --owner-email you@example.com
```

Every resource step reports `skipped`, `deploy` ships the new version, and `healthcheck` confirms it. The saved token is reused, and machines stay connected. To see what setup would change without changing anything, add `--check`: it only reads, and exits 2 if anything is out of date.

## Connect another machine

On the new machine, run `npx open-bus install --hub https://<host>` and approve it in the browser. You can revoke any machine from the dashboard at `https://<host>`; its connection closes at once.

## Remove OpenBus

```sh
pnpm -s ob:setup --json --destroy --name open-bus
```

Setup first answers `action_required`, saying what it will delete. Confirm with the user, then rerun with `--yes-destroy=open-bus`. It deletes the Worker (with its data), its custom domain and the Access login app. It never touches the zone or other DNS records. It removes only an install it has a record of on this computer. An install deployed from CI is removed by hand in the Cloudflare dashboard.
