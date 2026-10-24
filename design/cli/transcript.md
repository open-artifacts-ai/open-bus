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
  One agent: `1 agent in namespace …`.
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
  never cut. Labels are at most 128 characters and namespaces at most 128, so
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
[[danger]]×[[/danger]]  Expired: your message to openbus-e0, "Can you regenerate the API ref…",
   was not taken within 1 hour.
[[danger]]×[[/danger]]  Expired: your message to openbus-e0, "Can you regenerate the API ref…",
   was not delivered because openbus-e0 closed first.
```

Each expired or refused notice quotes the message it is about: the first 40
characters of its body, cut at the end, followed by "…", in straight double
quotes, right after the recipient name.

The second `Expired` line is the `recipient_closed` reason. Refusals, one per
pinned reason. `revoked` is the recipient's machine. `ambiguous` happens when a
global agent sends to a name that exists in two or more namespaces:

```
[[danger]]×[[/danger]]  Refused (unknown_agent): your message to openbus-qa,
   "Can you regenerate the API ref…", was not delivered.
   No agent has that name here.
   Run list_agents to see who is in this namespace.
[[danger]]×[[/danger]]  Refused (closed): your message to openbus-e0,
   "Can you regenerate the API ref…", was not delivered.
   Send it again once the session is open, or message another agent.
[[danger]]×[[/danger]]  Refused (inbox_full): your message to openbus-e0,
   "Can you regenerate the API ref…", was not delivered.
   50 messages are already waiting.
   Send again once some are delivered or expire.
[[danger]]×[[/danger]]  Refused (too_large): your message to openbus-e0,
   "Can you regenerate the API ref…", was not delivered.
   It is over 1 MB.
   Send a shorter message.
[[danger]]×[[/danger]]  Refused (other_namespace): your message to openbus-e0,
   "Can you regenerate the API ref…", was not delivered.
   That agent is in another namespace.
   Message agents in this namespace only.
[[danger]]×[[/danger]]  Refused (revoked): your message to openbus-e0,
   "Can you regenerate the API ref…", was not delivered.
   That agent's machine was revoked.
   Message another agent, or approve that machine again with npx open-bus login.
[[danger]]×[[/danger]]  Refused (ambiguous): your message to docs-writer,
   "Can you regenerate the API ref…", was not delivered.
   That name exists in 2 namespaces.
   Send again with to_namespace set to one of them.
```

Tool results are plain text, so harnesses show these without colour; the glyph
carries the state. The CLI colours them when it prints them itself.
