import { box, glyph, paint, type Style, type Tone } from "./term.ts";

/**
 * Every line the CLI prints: design/cli/transcript.md states 1 to 10,
 * verbatim. The few lines it does not name are marked DRAFT. Change wording
 * here; the logic never holds copy.
 */

export const WIDTH = 80;
const MIN = 10 * 60_000;

export type HarnessName = "claude" | "opencode" | "pi";
export const HARNESS_LABEL: Record<HarnessName, string> = {
  claude: "Claude Code",
  opencode: "OpenCode",
  pi: "Pi",
};
/** The dashboard's labels for AGENT_KINDS. */
export const KIND_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  pi: "Pi",
};

export type RosterAgent = {
  name: string;
  kind: string;
  machine: string;
  state: "live" | "queued";
};

const len = (s: string) => [...s].length;

/**
 * Cuts the middle out of `value` so it is at most `max` long. The end is
 * kept whole when it fits in half: the last path segment (the repo name) or
 * the last two host labels (the domain).
 */
export function cutMiddle(value: string, max: number, more = "…"): string {
  const chars = [...value];
  if (chars.length <= max) return value;
  const keep = Math.max(0, max - len(more));
  const slash = value.lastIndexOf("/");
  const dot = value.lastIndexOf(".", value.lastIndexOf(".") - 1);
  const end =
    slash >= 0 ? value.slice(slash) : dot >= 0 ? value.slice(dot) : "";
  const tail =
    len(end) > 0 && len(end) <= keep / 2 ? len(end) : Math.ceil(keep / 2);
  return (
    chars.slice(0, keep - tail).join("") +
    more +
    chars.slice(chars.length - tail).join("")
  );
}

/** A roster cell: cut to width minus 2 plus "…", then padded, so columns keep a space. */
export function cell(value: string, width: number, more = "…"): string {
  const chars = [...value];
  const v =
    chars.length > width - 2
      ? chars.slice(0, width - 2).join("") + more
      : value;
  return v + " ".repeat(Math.max(0, width - len(v)));
}

/** `ob_machine_…7f3a`: never more of a token than its prefix and 4 characters. */
export const tokenTail = (token: string, more = "…") =>
  `ob_machine_${more}${token.slice(-4)}`;

const listing = (names: string[], last: "and" | "or") =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} ${last} ${names.at(-1)}`;

export function copy(style: Style) {
  const p = (tone: Tone, s: string) => paint(style, tone, s);
  const g = (n: Parameters<typeof glyph>[1]) => glyph(style, n);
  const more = g("more");
  const done = (s: string, meta?: string) =>
    `${p("success", g("done"))}  ${s}${meta ? `  ${p("muted", meta)}` : ""}`;
  const warn = (s: string) => `${p("warning", g("retry"))}  ${s}`;
  const fail = (s: string) => `${p("danger", g("fail"))}  ${s}`;
  const step = (s: string) => `${g("step")}  ${s}`;
  const next = (s: string) => `   ${s}`;
  /** Cuts `value` so the whole line, glyph and meta included, fits in 80. */
  const clip = (value: string, rest: number) =>
    cutMiddle(value, WIDTH - rest, more);
  const b = box(style);

  const all = {
    header: (version: string) => `open-bus ${version}`,

    // 1. First run
    opening: () => step("Opening your browser to approve this machine"),
    ifNotOpened: (url: string) =>
      next(`If it did not open: ${p("accent", url)}`),
    noBrowser: () => step("No browser found. Open this URL on any machine:"),
    openThisUrl: () => step("Open this URL on any machine:"),
    url: (url: string) => next(p("accent", url)),
    codeBox: (code: string) => {
      const rule = b.h.repeat(len(code) + 4);
      return [
        next(p("hairline", `${b.tl}${rule}${b.tr}`)),
        next(
          `${p("hairline", b.v)}  ${p("accent", code)}  ${p("hairline", b.v)}  Check this code on the approval page.`,
        ),
        next(
          `${p("hairline", `${b.bl}${rule}${b.br}`)}  ${p("muted", "Valid 10 minutes.")}`,
        ),
      ];
    },
    waiting: (frame: string, leftMs: number, failing: boolean) => {
      const s = Math.max(0, Math.floor(Math.min(leftMs, MIN) / 1000));
      const left = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} left`;
      return `${p("warning", frame)}  Waiting for approval  ${p("muted", left)}${
        failing ? `  ${p("warning", "hub unreachable, retrying")}` : ""
      }`;
    },
    waitingPlain: () => `Waiting for approval (up to 10 minutes)${more}`,
    approved: (label: string) => done(`Approved as ${clip(label, 15)}`),
    tokenSaved: (path: string, token: string) =>
      done(`Token saved to ${path}`, tokenTail(token, more)),
    alreadyConnected: (label: string) =>
      done(`Already connected as ${clip(label, 24)}`),

    configured: (names: HarnessName[]) =>
      done(
        `Configured ${listing(
          names.map((h) => HARNESS_LABEL[h]),
          "and",
        )}`,
      ),
    noHarness: () => [
      warn("No Claude Code, OpenCode or Pi found"),
      next("Install one, then run npx open-bus again."),
    ],
    restarted: () => done("Restarted the OpenCode service to load the plugin"),
    opencodeNotRunning: () =>
      done("OpenCode service not running; it loads the plugin when it starts"),
    daemonRunning: (
      pid: number,
      service?: "launchd" | "systemd",
      fallback?: boolean,
    ) =>
      fallback && !service
        ? // The service manager cannot run it: install again won't help.
          [
            warn(
              "Daemon running without a service, so it won't restart after a reboot.",
            ),
            next("After a reboot, start it again with npx open-bus daemon."),
          ]
        : service
          ? [
              done(
                service === "launchd"
                  ? "Daemon running as a launchd service"
                  : "Daemon running as a systemd user service",
                `pid ${pid}`,
              ),
            ]
          : // Running in a terminal: nothing brings it back after a reboot.
            [
              warn(
                "Daemon running, but no service will restart it after a reboot.",
              ),
              next("Run npx open-bus install."),
            ],
    // doctor, after the daemon line.
    serviceNodeMissing: (node: string) => [
      fail(`The service runs a Node that is gone: ${clip(node, 42)}.`),
      next("Run npx open-bus install to point it at your current Node."),
    ],
    lingerOff: () => [
      warn("The daemon stops when you log out (systemd lingering is off)."),
      next("Run loginctl enable-linger $USER to keep it running."),
    ],
    // DRAFT until Design names them.
    daemonInTheWay: (socket: string, pid: number) => [
      fail(`Another daemon still answers on ${clip(socket, 50)}`),
      next(`Stop it (pid ${pid}), then run npx open-bus install again.`),
    ],
    daemonStillRunning: (pid: number) => [
      warn(`The daemon is still running  ${p("muted", `pid ${pid}`)}`),
      next(`Stop it with kill ${pid}.`),
    ],
    daemonTimeout: () => [
      fail("The daemon did not start within 10 seconds."),
      next("Run npx open-bus doctor to see why."),
    ],

    rosterHeader: (namespace: string, live: number, queued: number) => {
      const n = live + queued;
      const meta = queued
        ? `${live} live ${g("sep")} ${queued} queued`
        : `${live} live`;
      const lead = `${n} agent${n === 1 ? "" : "s"} in namespace `;
      return `${lead}${p("accent", clip(namespace, len(lead) + 2 + len(meta)))}  ${p("muted", meta)}`;
    },
    rosterRow: (a: RosterAgent) =>
      `  ${cell(a.name, 20, more)}${cell(KIND_LABEL[a.kind] ?? a.kind, 13, more)}${cell(a.machine, 22, more)}${
        a.state === "live"
          ? p("success", `${g("live")} live`)
          : p("warning", `${g("queued")} queued`)
      }`,
    rosterMore: (n: number) =>
      `  ${p("muted", `and ${n} more ${g("sep")} npx open-bus status`)}`,
    queuedFootnote: () => [
      p(
        "muted",
        "Mail to a queued agent waits up to 1 hour for its machine to reconnect;",
      ),
      p("muted", "then the sender is told."),
    ],
    noAgents: (namespace: string) => {
      const lead = "No agents in namespace ";
      return [
        `${lead}${p("accent", clip(namespace, len(lead) + 5))} yet.`,
        "Start Claude Code, OpenCode or Pi in this folder and it joins.",
      ];
    },
    statusHint: () =>
      p("muted", "Check this machine anytime with npx open-bus status."),

    // 3, 4, 6
    denied: () => [
      fail("This machine was not approved."),
      next("Run npx open-bus again to get a new code."),
    ],
    expired: (code: string) => [
      fail(`Code ${code} expired after 10 minutes.`),
      next("Run npx open-bus again to get a new code."),
    ],
    unreachable: (
      host: string,
      waitS: number,
      attempt: number,
      total: number,
    ) => [
      warn(`Couldn't reach ${clip(host, 18)}`),
      next(
        p(
          "muted",
          `Retrying in ${waitS} s${more} attempt ${attempt} of ${total}`,
        ),
      ),
    ],
    unreachableFinal: (host: string, attempts: number, error: string) => {
      const tail = `after ${attempts} attempts.`;
      return [
        `${fail(`Couldn't reach ${clip(host, 21 + len(tail) + len(error))} ${tail}`)}  ${p("muted", error)}`,
        next(
          "Check your network or the --hub URL, then run npx open-bus again.",
        ),
      ];
    },

    // Not in the transcript (DRAFT until Design names them).
    /** Any failure the transcript does not name. */
    failed: (message: string) => [
      fail(clip(message.split("\n")[0] ?? "", 3)),
      next("Run npx open-bus doctor to see why."),
    ],
    usage: (message: string) => [
      fail(clip(message, 3)),
      next(
        "Run npx open-bus with install, login, daemon, status, logs, doctor,",
      ),
      next("uninstall, mcp <claude|opencode|pi> or version."),
    ],
    skipped: (h: HarnessName, reason: string) => [
      warn(
        `Skipped ${HARNESS_LABEL[h]}: ${clip(reason, 14 + len(HARNESS_LABEL[h]))}`,
      ),
      next("Fix it, then run npx open-bus again."),
    ],
    noHub: () => [
      fail("No hub to connect to."),
      next(
        "Run npx open-bus --hub https://bus.example.com, or set OPENBUS_HUB.",
      ),
    ],
    hubMismatch: (approved: string, asked: string, askedUrl: string) => {
      // Both hosts share the line: each keeps at least 20 columns.
      const a = clip(approved, 39 + Math.min(len(asked), 20));
      const b = clip(asked, 39 + len(a));
      return [
        fail(`This machine is approved for ${a}, not ${b}.`),
        next("Run npx open-bus uninstall --purge first, then"),
        next(`npx open-bus --hub ${clip(askedUrl, 23)}.`),
      ];
    },
    checkOk: (label: string) => done(label),
    checkFailed: (label: string, action: string) => [fail(label), next(action)],
    noNamespace: () =>
      p(
        "muted",
        "This folder has no namespace, so there is no roster to show.",
      ),
    couldNotRemove: (h: HarnessName, reason: string) => [
      warn(
        `Could not remove OpenBus from ${HARNESS_LABEL[h]}: ${clip(reason, 37 + len(HARNESS_LABEL[h]))}`,
      ),
      next("Fix it, then run npx open-bus uninstall again."),
    ],
    purgeLeftDir: (home: string) => [
      warn(
        `Left ${clip(home, 57)} in place: it holds files OpenBus did not create.`,
      ),
    ],
    purgeRefused: (home: string) => [
      fail(
        `${clip(home, 64)} does not look like an OpenBus folder, so it was not deleted.`,
      ),
      next("Remove the OpenBus files in it yourself, or unset OPENBUS_HOME."),
    ],
    purgeDaemonRunning: (home: string) => [
      fail(
        `The daemon is still running, so ${clip(home, 52)} was not deleted.`,
      ),
      next("Wait a few seconds and run npx open-bus uninstall --purge again."),
      next("If it keeps running, run npx open-bus doctor to see why."),
    ],

    // 7. status
    hubRow: (host: string) => `Hub      ${clip(host, 9)}`,
    machineRow: (label: string) => `Machine  ${clip(label, 9)}`,
    statusDaemonDown: () => [
      fail("Daemon not running"),
      next(
        "Run npx open-bus to restart it, or npx open-bus doctor to see why.",
      ),
    ],
    hubNotReachable: (
      host: string,
      error: string | undefined,
      again: string,
    ) => [
      `${fail(`Hub not reachable at ${clip(host, 26 + (error ? len(error) + 2 : 0))}`)}${
        error ? `  ${p("muted", error)}` : ""
      }`,
      next(
        `Check your network or the hub URL, then run npx open-bus ${again} again.`,
      ),
    ],
    notRegistered: () => [
      fail("This computer is not connected to a bus."),
      next("Run npx open-bus to approve it."),
    ],
    revoked: () => [
      fail("This machine was revoked."),
      next("Run npx open-bus login to approve it again."),
    ],

    // 8. doctor
    nodeOk: (version: string) => done(`Node ${version}`),
    nodeOld: (version: string) => [
      fail(`Node ${clip(version, 39)} is too old (needs 22 or newer)`),
      next("Install Node 22 or newer, then run npx open-bus doctor again."),
    ],
    credentials: (path: string, token: string) =>
      done(`Credentials at ${clip(path, 37)}`, tokenTail(token, more)),
    noCredentials: (path: string) => [
      fail(`No credentials at ${clip(path, 21)}`),
      next("Run npx open-bus to approve this machine."),
    ],
    revokedCheck: () => [
      fail("This machine was revoked"),
      next("Run npx open-bus login to approve it again."),
    ],
    daemonNotRunning: () => [
      fail("Daemon is not running"),
      next("Run npx open-bus to restart it."),
    ],
    hubReachable: (host: string) => done(`Hub reachable at ${clip(host, 20)}`),
    wired: (h: HarnessName, version?: string) =>
      done(
        version
          ? `${HARNESS_LABEL[h]} ${clip(version, 40)} wired`
          : `${HARNESS_LABEL[h]} wired`,
      ),
    notWired: (h: HarnessName) => [
      fail(`${HARNESS_LABEL[h]} is not wired`),
      next("Run npx open-bus to wire it."),
    ],
    claudeAccepts: () =>
      done("Claude Code accepts messages from other machines"),
    claudeIsolates: (settings: string) => [
      warn("Claude Code ignores messages from other machines"),
      next(`Set isolatePeerMachines to false in ${clip(settings, 40)}.`),
    ],
    opencodeTooOld: (version: string, min: string) => {
      const rest = ` is too old for the plugin (needs ${min} or newer)`;
      return [
        warn(`OpenCode ${clip(version, 12 + len(rest))}${rest}`),
        next("Run opencode upgrade, then npx open-bus install again."),
      ];
    },
    opencodeUnknown: () => [
      warn("OpenCode version unknown"),
      next(
        "Run opencode --version to check it, then npx open-bus install again.",
      ),
    ],
    summary: (failed: number, warnings: number, passed: number) =>
      p(
        "muted",
        failed + warnings === 0
          ? `All ${passed} checks passed.`
          : `${[
              failed ? `${failed} failed` : "",
              warnings ? `${warnings} warning${warnings > 1 ? "s" : ""}` : "",
              passed ? `${passed} passed` : "",
            ]
              .filter(Boolean)
              .join(", ")}.`,
      ),

    // 9, 10. uninstall
    serviceRemoved: (kind: "launchd" | "systemd") =>
      done(
        kind === "launchd"
          ? "Stopped and removed the launchd service"
          : "Stopped and removed the systemd user service",
      ),
    noService: () => done("No service to remove"),
    daemonStopped: () => done("Stopped the daemon"),
    removedFrom: (names: HarnessName[]) =>
      done(
        `Removed OpenBus from ${listing(
          names.map((h) => HARNESS_LABEL[h]),
          "and",
        )}`,
      ),
    noneWired: () => done("No harness had OpenBus wired"),
    removedPluginFolder: () => done("Removed the OpenCode plugin folder"),
    restartedUnload: () =>
      done("Restarted the OpenCode service to unload the plugin"),
    opencodeNotRunningUnload: () =>
      done("OpenCode service not running; nothing to restart"),
    kept: (machineFile: string) => [
      `Kept ${clip(machineFile, 46)}. This machine stays approved on the bus;`,
      "run npx open-bus to reconnect it.",
      p("muted", "To remove everything, run npx open-bus uninstall --purge."),
    ],
    deleted: (home: string) =>
      done(`Deleted ${clip(home, 35)}, including machine.json`),
    stillListed: (label: string, host: string) => [
      warn(`${clip(label, 30)} is still listed on the bus`),
      next(
        `Revoke it in the dashboard at ${clip(host, 56)} to remove it for good.`,
      ),
      next("To use this computer again, run npx open-bus."),
    ],

    // logs, mcp (DRAFT)
    noLog: (path: string) => [
      warn(`No daemon log yet at ${clip(path, 24)}`),
      next("Run npx open-bus daemon to see its output in this terminal."),
    ],
    mcpPi: () => [
      warn("Pi uses the OpenBus extension, not an MCP server."),
      next("Run npx open-bus to install the extension."),
    ],
  };
  return all;
}

export type Copy = ReturnType<typeof copy>;
