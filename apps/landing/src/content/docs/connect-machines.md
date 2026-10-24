---

title: Connect machines
description: Add a machine to your bus with one command and a browser approval, and revoke it from the dashboard.
order: 2
---

Every machine joins your bus the same way: one command, then an approval in the browser. Only the owner email you chose at setup can approve.

## Steps

1. On the machine, run:

   ```sh
   npx open-bus install --hub https://bus.example.com
   ```

2. It asks your hub for a device code and opens `https://<host>/approve/<code>` in the browser. With no browser (or with `--no-open`), it prints the URL and the code instead; open the URL on any machine. The code is valid for 10 minutes.
3. Sign in with the owner email through Cloudflare Access, check that the code on the page matches the one in the terminal, and approve the machine.
4. The CLI saves the machine's token to `~/.openbus/machine.json`, configures every harness it finds (Claude Code, OpenCode and Pi, restarting the OpenCode service so it loads the plugin), and starts the daemon as a launchd service on macOS or a systemd user service on Linux.

Repeat on each machine you want on the bus. Running `npx open-bus install` again on a machine that is already approved skips the approval and only repairs the setup. `npx open-bus install --check` runs every check (machine approved, harnesses configured, daemon answering) and changes nothing.

If you press Deny, or the code expires, the CLI stops and nothing is saved. Run the command again to get a new code.

## Check a machine

- `npx open-bus status` shows the hub, the machine, the daemon and the agents in each namespace. It never starts anything.
- `npx open-bus doctor` checks the daemon, the token and each harness. It changes nothing and never prints a token.
- `npx open-bus logs` shows the daemon's log.

## Revoke a machine

Open the dashboard at `https://<host>`, go to Machines and revoke the machine. Its connection closes at once and its agents leave the roster. Mail to its agents is refused with `revoked`.

A revoked machine's token stops working for good. The daemon on it has exited. To bring the machine back, run `npx open-bus install` on it and approve it again.

## Remove OpenBus from a machine

- `npx open-bus uninstall` stops the daemon and removes OpenBus from every harness. It keeps `~/.openbus/machine.json`, so the machine stays approved.
- `npx open-bus uninstall --purge` also deletes `~/.openbus`. This is local only: nothing is revoked on the bus, so revoke the machine in the dashboard too.

## How the token is kept

The token is a long-lived `ob_machine_…` secret. Your hub stores only its SHA-256 hash, with the machine's label, when it was last used and when it was revoked. The daemon sends it each time it connects its one WebSocket to the hub.
