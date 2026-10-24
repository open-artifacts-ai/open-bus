# `npx open-bus` transcript

This is the exact output of `npx open-bus` (the `install` command), line by line.
The client track implements it verbatim; change it here first. Rules and
colours are in `PALETTE.md`.

Notation: `[[accent]]…[[/accent]]`, `[[success]]`, `[[warning]]`, `[[danger]]`
and `[[muted]]` mark coloured spans by palette name; untagged text is `ink`.
`[[hairline]]` marks the device-code box border. Example values: hub
`https://bus.example.com`, code `K3M7-QW29`, label `leo-macbook-pro` (the
sanitized hostname), namespace `github.com/open-artifacts-ai/open-bus` (from the
working directory's git remote; see `05-client.md` `namespace.ts`).

## 1. First run, browser opens

```
open-bus 0.1.0

→  Opening your browser to approve this machine
   If it did not open: [[accent]]https://bus.example.com/approve/K3M7-QW29[[/accent]]

   [[hairline]]╭─────────────╮[[/hairline]]
   [[hairline]]│[[/hairline]]  [[accent]]K3M7-QW29[[/accent]]  [[hairline]]│[[/hairline]]  Check this code on the approval page.
   [[hairline]]╰─────────────╯[[/hairline]]  [[muted]]Valid 10 minutes.[[/muted]]

[[warning]]⠋[[/warning]]  Waiting for approval  [[muted]]9:41 left[[/muted]]
```

The spinner line redraws every 80 ms and its time left every second. When the
hub answers, the line is erased and replaced by:

```
[[success]]✓[[/success]]  Approved as leo-macbook-pro
[[success]]✓[[/success]]  Token saved to ~/.openbus/machine.json  [[muted]]ob_machine_…7f3a[[/muted]]

[[success]]✓[[/success]]  Configured Claude Code, OpenCode and Pi
[[success]]✓[[/success]]  Restarted the OpenCode service to load the plugin
[[success]]✓[[/success]]  Daemon running as a launchd service  [[muted]]pid 48213[[/muted]]

5 agents in namespace [[accent]]github.com/open-artifacts-ai/open-bus[[/accent]]  [[muted]]4 live · 1 queued[[/muted]]
  openbus-backend     Claude Code  leo-macbook-pro       [[success]]● live[[/success]]
  openbus-design      Claude Code  leo-macbook-pro       [[success]]● live[[/success]]
  openbus-e0          OpenCode     leo-macbook-pro       [[success]]● live[[/success]]
  openbus-frontend    Pi           leo-linux-box         [[success]]● live[[/success]]
  openbus-platform    Claude Code  leo-mac-mini          [[warning]]○ queued[[/warning]]
[[muted]]Mail to a queued agent waits up to 1 hour for its machine to reconnect;[[/muted]]
[[muted]]then the sender is told.[[/muted]]

[[muted]]Check this machine anytime with npx open-bus status.[[/muted]]
```

Variants inside state 1:
- `✓  Daemon running` prints only after the CLI has confirmed the service is
  up: the daemon answers on `~/.openbus/daemon.sock` and reports its pid. It
  waits at most 10 s; if the daemon has not answered by then, the line is
  `[[danger]]×[[/danger]]  The daemon did not start within 10 seconds.` and, indented 3,
  `Run npx open-bus doctor to see why.` Nothing is printed after that. Exit code 1.
- On Linux the service line reads `Daemon running as a systemd user service`.
- No service manages the daemon (it runs in a terminal, `npx open-bus daemon`):
  the daemon line is a warning, not a step, and the install still succeeds:
  `[[warning]]![[/warning]]  Daemon running, but no service will restart it after a reboot.`
  then, indented 3, `Run npx open-bus install.` status and doctor print the
  same two lines (doctor counts it as a warning).
- The service manager cannot run the daemon at all (Linux with no systemd
  user session, as in WSL or a container; launchd refusing the service): the
  install starts the daemon itself and still succeeds, and running install
  again would not help, so the line reads
  `[[warning]]![[/warning]]  Daemon running without a service, so it won't restart after a reboot.`
  then, indented 3, `After a reboot, start it again with npx open-bus daemon.`
  status and doctor print the same two lines (doctor counts it as a warning).
- Another daemon holds the socket and does not stop (not ours, or it ignored
  SIGTERM for 5 seconds): nothing is started, nothing is printed after it,
  exit code 1. The path is cut in the middle if long:
  `[[danger]]×[[/danger]]  Another daemon is still running (pid 48213) on ~/.openbus/daemon.sock.`
  then, indented 3, `Stop it with kill 48213, then run npx open-bus install again.`
- `Restarted the OpenCode service to load the plugin` prints only when OpenCode
  was configured (`installAdapters` ran `opencode service restart`). If OpenCode
  is configured but its service is not running, it reads
  `[[success]]✓[[/success]]  OpenCode service not running; it loads the plugin when it starts`.
- The configured line lists only the harnesses found: `Configured Claude Code`,
  `Configured Claude Code and Pi`. None found:
  `!  No Claude Code, OpenCode or Pi found` and, indented 3,
  `Install one, then run npx open-bus again.` (`warning`, the install still
  succeeds).
- No agents yet: `No agents in namespace [[accent]]<namespace>[[/accent]] yet.` then
  `Start Claude Code, OpenCode or Pi in this folder and it joins.` and no table.
  One agent: `1 agent in namespace …`. With nothing queued the meta is
  `N live` alone; it never reads `0 queued`.
- The `queued` footnote prints only when a row is queued. Rows are `live` or
  `queued`, never `closed`: closed sessions are not in the roster. `queued`
  means the agent's machine is disconnected, so a machine's rows are either all
  live or all queued.
- A poll that fails while waiting keeps the spinner and appends
  `  [[warning]]hub unreachable, retrying[[/warning]]` to its line until a poll
  succeeds. The wait still ends when the code does.

### The roster table

One line per agent after success, sorted live first, then by name:

```
  openbus-e0          OpenCode     leo-macbook-pro       [[success]]● live[[/success]]
```

- Indent 2. Name padded to 20, kind to 13, machine label to 22, then the status.
  The widest row is 65 columns.
- Kind is `Claude Code`, `OpenCode` or `Pi` (the dashboard's labels for
  `AGENT_KINDS`).
- Status is `[[success]]● live[[/success]]` or `[[warning]]○ queued[[/warning]]`.
- Show at most 20 rows, then `[[muted]]and 7 more · npx open-bus status[[/muted]]`
  indented 2.

### Cutting long values

This is the one truncation rule for the whole CLI; `PALETTE.md` points here.
- **Roster cells:** a value longer than its column width minus 2 is cut to
  width minus 2 and `…`, so columns always keep one space between them.
- **Everything else** (machine label, namespace, hub host, agent name in a
  receipt): if the line would pass 80 columns, the value is cut in the middle
  to `first part…last part`, keeping the end (the repo name, the host's
  domain), so the line is at most 80. Glyphs, padding and the muted meta are
  never cut. Labels are at most 64 characters and namespaces at most 128, so
  every line fits. Example, a 128-character namespace:
  `5 agents in namespace github.com/very-long-org…/open-bus  4 live · 1 queued`

## 2. No browser

When `--no-open` is passed or opening the browser fails (no `DISPLAY` on Linux,
`open` or `xdg-open` exits non-zero), the "Opening your browser" step is
replaced by:

```
open-bus 0.1.0

→  No browser found. Open this URL on any machine:
   [[accent]]https://bus.example.com/approve/K3M7-QW29[[/accent]]

   [[hairline]]╭─────────────╮[[/hairline]]
   [[hairline]]│[[/hairline]]  [[accent]]K3M7-QW29[[/accent]]  [[hairline]]│[[/hairline]]  Check this code on the approval page.
   [[hairline]]╰─────────────╯[[/hairline]]  [[muted]]Valid 10 minutes.[[/muted]]

[[warning]]⠋[[/warning]]  Waiting for approval  [[muted]]9:58 left[[/muted]]
```

With `--no-open` the first line reads `→  Open this URL on any machine:`. The
rest of the run is state 1 from the spinner on.

## 3. Denied

The user pressed Deny on the approval page. The spinner line is erased, then:

```
[[danger]]×[[/danger]]  This machine was not approved.
   Run npx open-bus again to get a new code.
```

Nothing else is printed after it. Exit code 1. No `machine.json` is written.

## 4. Expired

The hub reports the code expired, or 10 minutes pass with no answer. The
spinner line is erased, then:

```
[[danger]]×[[/danger]]  Code K3M7-QW29 expired after 10 minutes.
   Run npx open-bus again to get a new code.
```

Nothing else is printed after it. Exit code 1. The approval page shows the same
"run again" state for an expired or already-used code.

## 5. Already registered

`~/.openbus/machine.json` exists, so there is no approval flow. Setup still
runs; it is idempotent.

```
open-bus 0.1.0

[[success]]✓[[/success]]  Already connected as leo-macbook-pro

[[success]]✓[[/success]]  Configured Claude Code, OpenCode and Pi
[[success]]✓[[/success]]  Restarted the OpenCode service to load the plugin
[[success]]✓[[/success]]  Daemon running as a launchd service  [[muted]]pid 48213[[/muted]]

5 agents in namespace [[accent]]github.com/open-artifacts-ai/open-bus[[/accent]]  [[muted]]4 live · 1 queued[[/muted]]
```

The roster table, the queued footnote and the status hint follow as in state 1.

Approved for another hub: `--hub` (or `OPENBUS_HUB`) names a hub whose origin
is not the one in `machine.json`. Nothing changes; exit code 1:

```
open-bus 0.1.0

[[danger]]×[[/danger]]  This machine is approved for bus.example.com, not other.example.org.
   Run npx open-bus uninstall --purge first, then
   npx open-bus --hub https://other.example.org.
```

The second line is cut after "then" so that every line fits in 80 columns.

## install --check

`npx open-bus install --check`. Read-only: runs every step's check and changes
nothing. A passing check is `✓`; a failing one is `×` followed by its next
action, indented 3. Exit code 1 if any check failed, otherwise 0; it never
exits 1 without printing the failing check.

```
open-bus 0.1.0

[[success]]✓[[/success]]  Machine approved
[[danger]]×[[/danger]]  Harnesses not configured
   Run npx open-bus to configure them.
[[danger]]×[[/danger]]  Daemon not answering
   Run npx open-bus to start it.
```

The passing lines are `Machine approved`, `Harnesses configured` and
`Daemon answering`. A failing `Machine not approved` is followed by
`Run npx open-bus to approve it.`

## 6. Hub unreachable

`POST /device/code` fails (DNS, refused, timeout after 10 s, or a 5xx). The CLI
retries 3 times, waiting 2, 4 and 8 s. On a TTY the retry line is redrawn in
place; elsewhere each attempt prints its own line.

```
open-bus 0.1.0

[[warning]]![[/warning]]  Couldn't reach bus.example.com
   [[muted]]Retrying in 4 s… attempt 3 of 4[[/muted]]
```

If an attempt succeeds, both lines are erased and state 1 continues from
"Opening your browser". After the fourth failure, both lines are erased and
replaced by:

```
[[danger]]×[[/danger]]  Couldn't reach bus.example.com after 4 attempts.  [[muted]]ECONNREFUSED[[/muted]]
   Check your network or the --hub URL, then run npx open-bus again.
```

Exit code 1. The muted tail is the last error: a Node error code, `timeout`, or
`HTTP 502`. There is no `--verbose` flag; the 2, 4, 8 s schedule is shown by the
retry line itself.

No hub named: this machine has no `machine.json`, and neither `--hub` nor
`OPENBUS_HUB` is set. Nothing is requested; exit code 1:

```
open-bus 0.1.0

[[danger]]×[[/danger]]  No hub to connect to.
   Run npx open-bus --hub https://bus.example.com, or set OPENBUS_HUB.
```

## Receipts

Agents see these lines from the bus tools (`send_message` in every harness).
Two honesty rules from the spec bind them:
1. A receipt is never `delivered` before the daemon confirmed the harness
   accepted the message. A send that returns `pending` says "queued", not
   "sent".
2. A refused send prints its reason from the pinned list, verbatim, in
   parentheses: `unknown_agent`, `closed`, `inbox_full`, `too_large`,
   `other_namespace`, `revoked`, `ambiguous`.

```
[[warning]]○[[/warning]]  Queued for openbus-e0. Not delivered yet; expires in 1 hour.
[[success]]✓[[/success]]  Delivered to openbus-e0.
[[danger]]×[[/danger]]  Expired: your message to openbus-e0,
   "Can you regenerate the API reference pag…", was not taken within 1 hour.
[[danger]]×[[/danger]]  Expired: your message to openbus-e0,
   "Can you regenerate the API reference pag…",
   was not delivered because openbus-e0 closed first.
```

Each expired or refused notice quotes the message it is about: the first 40
characters of its body, cut at the end, followed by "…", in straight double
quotes, right after the recipient name.

Excerpt wrap: line 1 is the prefix, the recipient name, `, `, the quoted
excerpt and `,`. If that would pass 80 columns, line 1 ends after the recipient
name and its comma, the quote goes on its own line indented 3 (the same indent
as every continuation line) and is followed by its tail; if the tail would then
pass 80 columns it moves to the next line, indented 3. The quote is never
shortened to fit. Every sample below follows this.

The second `Expired` line is the `recipient_closed` reason. Refusals, one per
pinned reason. `revoked` is the recipient's machine. `ambiguous` happens when a
global agent sends to a name that exists in two or more namespaces:

```
[[danger]]×[[/danger]]  Refused (unknown_agent): your message to openbus-qa,
   "Can you regenerate the API reference pag…", was not delivered.
   No agent has that name here.
   Run list_agents to see who is in this namespace.
[[danger]]×[[/danger]]  Refused (closed): your message to openbus-e0,
   "Can you regenerate the API reference pag…", was not delivered.
   Send it again once the session is open, or message another agent.
[[danger]]×[[/danger]]  Refused (inbox_full): your message to openbus-e0,
   "Can you regenerate the API reference pag…", was not delivered.
   50 messages are already waiting.
   Send again once some are delivered or expire.
[[danger]]×[[/danger]]  Refused (too_large): your message to openbus-e0,
   "Can you regenerate the API reference pag…", was not delivered.
   It is too large to send (the limit is 1 MB).
   Send a shorter message.
[[danger]]×[[/danger]]  Refused (other_namespace): your message to openbus-e0,
   "Can you regenerate the API reference pag…", was not delivered.
   You can reach only agents in your namespace and global agents.
   Message an agent in this namespace, or a global agent.
[[danger]]×[[/danger]]  Refused (revoked): your message to openbus-e0,
   "Can you regenerate the API reference pag…", was not delivered.
   That agent's machine was revoked.
   Message another agent, or run npx open-bus install on that machine.
[[danger]]×[[/danger]]  Refused (ambiguous): your message to docs-writer,
   "Can you regenerate the API reference pag…", was not delivered.
   That name exists in 2 namespaces.
   Send again with to_namespace set to one of them.
```

`send_message` waits up to 5 s after the hub's receipt: a message delivered in
that time reads `Delivered to`, and a refusal or expiry in that time reads as
its notice. A message delivered after the window is shown once, in the sending
agent's next bus tool result, appended after the tool's own result and
separated by a blank line. It has the Expired shape, with the same excerpt and
wrap rule:

```
[[success]]✓[[/success]]  Delivered: your message to openbus-e0,
   "Can you regenerate the API reference pag…", was delivered after all.
```

If the connection to the hub drops while a message is being sent, the daemon
holds it and resends it under the same id, so it is never delivered twice; at
the 10 s timeout `send_message` reads `Queued for`, as above, and a later
outcome always follows. A failure that arrives after the tool call ended (a
refusal, an expiry, or an unconfirmed send) is injected once as a notice that
wakes the sending agent; only a late delivery waits for its next bus tool
result. A refusal reuses its Refused notice verbatim. If the hub never confirms
the message within 60 s, it reads, with the Expired excerpt and wrap rule
(lines 3 and 4 are fixed text and never wrap):

```
[[warning]]![[/warning]]  Unconfirmed: your message to openbus-e0,
   "Can you regenerate the API reference pag…", may not have been delivered.
   The connection to the hub dropped while it was being sent.
   Ask the recipient whether it arrived before sending it again.
```

Tool results are plain text, so harnesses show these without colour; the glyph
carries the state. The CLI colours them when it prints them itself.

## 7. status

`npx open-bus status`. Read-only; it never starts anything. Rows are labelled
`Hub` and `Machine` (padded to 9), then the daemon step, then one roster
summary line per namespace (namespaces are per session), each followed by its
table. Exit code 0 only in the connected and healthy state, 1 in every other.

Connected and healthy (the daemon reports an open hub link):

```
open-bus 0.1.0

Hub      bus.example.com
Machine  leo-macbook-pro
[[success]]✓[[/success]]  Daemon running as a launchd service  [[muted]]pid 48213[[/muted]]

3 agents in namespace [[accent]]github.com/open-artifacts-ai/open-bus[[/accent]]  [[muted]]2 live · 1 queued[[/muted]]
  openbus-backend     Claude Code  leo-macbook-pro       [[success]]● live[[/success]]
  openbus-design      Claude Code  leo-macbook-pro       [[success]]● live[[/success]]
  openbus-platform    Claude Code  leo-mac-mini          [[warning]]○ queued[[/warning]]
[[muted]]Mail to a queued agent waits up to 1 hour for its machine to reconnect;[[/muted]]
[[muted]]then the sender is told.[[/muted]]

1 agent in namespace [[accent]]github.com/leourbina/notes[[/accent]]  [[muted]]1 live[[/muted]]
  notes-writer        Pi           leo-macbook-pro       [[success]]● live[[/success]]
```

The table, the footnote (once, after the last table that has a queued row) and
the empty and one-agent lines are the state 1 variants. Linux reads `Daemon
running as a systemd user service`. `Hub` is the host only, cut by the one rule
in "Cutting long values".

Daemon running, hub not reachable. No roster rows are printed, because their
state cannot be known:

```
open-bus 0.1.0

Hub      bus.example.com
Machine  leo-macbook-pro
[[success]]✓[[/success]]  Daemon running as a launchd service  [[muted]]pid 48213[[/muted]]
[[danger]]×[[/danger]]  Hub not reachable at bus.example.com  [[muted]]ECONNREFUSED[[/muted]]
   Check your network or the hub URL, then run npx open-bus status again.
```

Daemon not running (`machine.json` exists, nothing answers on
`~/.openbus/daemon.sock`). No roster:

```
open-bus 0.1.0

Hub      bus.example.com
Machine  leo-macbook-pro
[[danger]]×[[/danger]]  Daemon not running
   Run npx open-bus to restart it, or npx open-bus doctor to see why.
```

Not registered or logged in (no `machine.json`). No `Hub` or `Machine` rows:

```
open-bus 0.1.0

[[danger]]×[[/danger]]  This computer is not connected to a bus.
   Run npx open-bus to approve it.
```

Machine revoked (the daemon wrote its revoked marker to `~/.openbus`, after a
4403 close or a 401/403 on the upgrade request; status and doctor read it):

```
open-bus 0.1.0

Hub      bus.example.com
Machine  leo-macbook-pro
[[danger]]×[[/danger]]  This machine was revoked.
   Run npx open-bus install to approve it again.
```

Late deliveries. Messages sent from this machine and delivered after the 5 s
window, within the last hour, follow the last namespace table and its
footnote. The section is printed only when there is at least one; the singular
is `1 message delivered late`. Rows are indented 2 and the quote 4. Names are
cut by the one rule in "Cutting long values", so a row never passes 80
columns. Times are relative and rounded down: `now` under a minute, then
`N min ago`, then `N h ago` from 60 minutes. Status stays read-only:
showing them here does not mark them shown in a tool result. The exit code is
unaffected.

```
2 messages delivered late  [[muted]]last hour[[/muted]]
  openbus-backend to openbus-e0  [[muted]]2 min ago[[/muted]]
    "Can you regenerate the API reference pag…"
  openbus-design to openbus-frontend  [[muted]]14 min ago[[/muted]]
    "The Machines page empty state is ready f…"
```

## 8. doctor

`npx open-bus doctor`. Read-only; it changes nothing and never prints a token.
One line per check, in this order. `✓` passes, `!` is a problem that leaves the
bus working, `×` is a failure. Every `!` and `×` is followed by its next action,
indented 3, starting with a verb. Harness checks print only for harnesses
found on this computer. Exit code 1 if any check failed (`×`), otherwise 0;
warnings alone exit 0.

```
open-bus 0.1.0

[[success]]✓[[/success]]  Node 22.11.0
[[success]]✓[[/success]]  Credentials at ~/.openbus/machine.json  [[muted]]ob_machine_…7f3a[[/muted]]
[[success]]✓[[/success]]  Daemon running as a launchd service  [[muted]]pid 48213[[/muted]]
[[success]]✓[[/success]]  Hub reachable at bus.example.com
[[success]]✓[[/success]]  Claude Code wired
[[success]]✓[[/success]]  Claude Code accepts messages from other machines
[[success]]✓[[/success]]  OpenCode 2.0.32 wired
[[success]]✓[[/success]]  Pi wired

[[muted]]All 8 checks passed.[[/muted]]
```

A run with problems:

```
open-bus 0.1.0

[[success]]✓[[/success]]  Node 22.11.0
[[success]]✓[[/success]]  Credentials at ~/.openbus/machine.json  [[muted]]ob_machine_…7f3a[[/muted]]
[[danger]]×[[/danger]]  Daemon is not running
   Run npx open-bus to restart it.
[[danger]]×[[/danger]]  Hub not reachable at bus.example.com  [[muted]]ECONNREFUSED[[/muted]]
   Check your network or the hub URL, then run npx open-bus doctor again.
[[success]]✓[[/success]]  Claude Code wired
[[warning]]![[/warning]]  OpenCode 1.4.2 is too old for the plugin (needs 2.0.0 or newer)
   Run opencode upgrade, then npx open-bus install again.
[[danger]]×[[/danger]]  Pi is not wired
   Run npx open-bus to wire it.

[[muted]]3 failed, 1 warning, 3 passed.[[/muted]]
```

Check lines and their failures:
- Node: `✓  Node 22.11.0`. Below 22: `×  Node 20.9.0 is too old (needs 22 or newer)`,
  then `   Install Node 22 or newer, then run npx open-bus doctor again.`
- Credentials: missing is `×  No credentials at ~/.openbus/machine.json` then
  `   Run npx open-bus to approve this machine.` Revoked (marker present) is
  `×  This machine was revoked` then `   Run npx open-bus install to approve it again.`
- Daemon: a real connect to `~/.openbus/daemon.sock`, not a file check.
  Failure: `×  Daemon is not running` then `   Run npx open-bus to restart it.`
- Service Node: the Node the service was installed with no longer exists (a
  Node upgrade removed it). Failure, the real path cut in the middle if long:
  `[[danger]]×[[/danger]]  The service runs a Node that is gone: /usr/local/bin/node.`
  then `   Run npx open-bus install to point it at your current Node.`
- Lingering, Linux only: the systemd user service is installed but lingering
  is off. Warning:
  `[[warning]]![[/warning]]  The daemon stops when you log out (systemd lingering is off).`
  then `   Run loginctl enable-linger $USER to keep it running.`
- Hub: `/healthz`. The muted tail is the last error, as in state 6.
- Wiring: the config entry is present. Failure: `×  <Harness> is not wired`
  then `   Run npx open-bus to wire it.`
- Claude `isolatePeerMachines` off: on, it reads
  `!  Claude Code ignores messages from other machines` then
  `   Set isolatePeerMachines to false in ~/.claude/settings.json.`
  This check prints only when `~/.claude/settings.json` exists; without it
  there is nothing to check, so it is neither counted nor shown.
- OpenCode: the version is the first line of `opencode --version`
  (`opencode v2.0.32`), checked before wiring. Below 2.0.0 is the `!` line above
  and OpenCode is not wired. Unparseable:
  `!  OpenCode version unknown` then
  `   Run opencode --version to check it, then npx open-bus install again.`
  OpenCode is not wired in either case, so no wiring line prints.
- Summary (muted): all passed is `All N checks passed.`; otherwise
  `<f> failed, <w> warning, <p> passed.` Omit a zero count; `warnings` when
  w > 1. The counts match the glyphs above it.

## 9. uninstall

`npx open-bus uninstall`. Removes what install added and keeps the credentials.
Exit code 0.

```
open-bus 0.1.0

[[success]]✓[[/success]]  Stopped and removed the launchd service
[[success]]✓[[/success]]  Removed OpenBus from Claude Code, OpenCode and Pi
[[success]]✓[[/success]]  Restarted the OpenCode service to unload the plugin

Kept ~/.openbus/machine.json. This machine stays approved on the bus;
run npx open-bus to reconnect it.
[[muted]]To remove everything, run npx open-bus uninstall --purge.[[/muted]]
```

- Linux reads `Stopped and removed the systemd user service`.
- The removed line lists only the harnesses that had OpenBus wired, as in
  state 1. None had it: `[[success]]✓[[/success]]  No harness had OpenBus wired`.
- The OpenCode restart line prints only when OpenCode was wired. If its service
  is not running: `[[success]]✓[[/success]]  OpenCode service not running; nothing to restart`.
- No service, but a daemon was running (in a terminal, or the one install
  started itself): it is stopped, and the line is
  `[[success]]✓[[/success]]  Stopped the daemon`.
- A daemon still answers after the stop (it ignored SIGTERM, or it is not
  ours and was not signalled): instead of the line above,
  `[[warning]]![[/warning]]  The daemon is still running (pid 48213).` then
  `   Stop it with kill 48213.`
- Second run: `[[success]]✓[[/success]]  No service to remove` and
  `[[success]]✓[[/success]]  No harness had OpenBus wired`. Exit code 0.
- Each line says what actually happened. When the only OpenCode leftover was
  the plugin folder (its config no longer named OpenBus), the line is
  `[[success]]✓[[/success]]  Removed the OpenCode plugin folder`, and OpenCode is not in the
  removed line.

## 10. uninstall --purge

`npx open-bus uninstall --purge`. The same steps as state 9, then it deletes
`~/.openbus`. Local only: nothing is revoked on the bus. Exit code 0.

```
open-bus 0.1.0

[[success]]✓[[/success]]  Stopped and removed the launchd service
[[success]]✓[[/success]]  Removed OpenBus from Claude Code, OpenCode and Pi
[[success]]✓[[/success]]  Restarted the OpenCode service to unload the plugin
[[success]]✓[[/success]]  Deleted ~/.openbus, including machine.json

[[warning]]![[/warning]]  leo-macbook-pro is still listed on the bus
   Revoke it in the dashboard at bus.example.com to remove it for good.
   To use this computer again, run npx open-bus.
```

The host and label are read from `machine.json` before it is deleted.

The daemon still answers on `~/.openbus/daemon.sock` after the service stop.
Nothing in `~/.openbus` is deleted, the closing block is not printed, and the
exit code is 1:

```
open-bus 0.1.0

[[success]]✓[[/success]]  Stopped and removed the launchd service
[[success]]✓[[/success]]  Removed OpenBus from Claude Code, OpenCode and Pi
[[success]]✓[[/success]]  Restarted the OpenCode service to unload the plugin
[[danger]]×[[/danger]]  The daemon is still running, so ~/.openbus was not deleted.
   Wait a few seconds and run npx open-bus uninstall --purge again.
   If it keeps running, run npx open-bus doctor to see why.
```

`OPENBUS_HOME` is not `~/.openbus` and holds neither `machine.json` nor
`install.json`: it may be someone's folder, so nothing in it is deleted. The
path is the real one, cut in the middle if long. Exit code 1:

```
open-bus 0.1.0

[[success]]✓[[/success]]  No service to remove
[[success]]✓[[/success]]  No harness had OpenBus wired
[[danger]]×[[/danger]]  ~/work does not look like an OpenBus folder, so it was not deleted.
   Remove the OpenBus files in it yourself, or unset OPENBUS_HOME.
```

Destroying a hub (`setup --destroy`) does not uninstall any machine: run
`npx open-bus uninstall` on every machine.

<!-- Purge is local only per the client. If it ever revokes server-side, replace
the last block with: ✓  Revoked leo-macbook-pro on the bus -->
