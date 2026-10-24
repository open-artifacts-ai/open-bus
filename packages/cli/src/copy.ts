import { box, glyph, paint, type Style, type Tone } from "./term.ts";

/**
 * Every line the CLI prints. Install's lines are design/cli/transcript.md
 * verbatim; the ones marked DRAFT (status, doctor, uninstall, the OpenCode
 * upgrade line, install --check, logs, mcp pi) are the client track's wording
 * until Design's addendum lands: change them here, the logic never holds copy.
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
    daemonRunning: (pid: number, service?: "launchd" | "systemd") =>
      done(
        service === "launchd"
          ? "Daemon running as a launchd service"
          : service === "systemd"
            ? "Daemon running as a systemd user service"
            : // DRAFT: no service yet (C9); the daemon runs in a terminal.
              "Daemon running",
        `pid ${pid}`,
      ),
    daemonTimeout: () => [
      fail("The daemon did not start within 10 seconds."),
      next("Run npx open-bus doctor to see why."),
    ],

    rosterHeader: (namespace: string, live: number, queued: number) => {
      const n = live + queued;
      // DRAFT: with nothing queued the meta reads "N live".
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

    // DRAFT: everything below waits for Design's addendum.
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
    opencodeTooOld: (version: string, min: string) => {
      const rest = ` is older than ${min}, so OpenBus skipped it.`;
      return [
        warn(`OpenCode ${clip(version, 12 + len(rest))}${rest}`),
        next("Upgrade OpenCode, then run npx open-bus again."),
      ];
    },
    opencodeUnknown: () => [
      warn("Could not read the OpenCode version, so OpenBus skipped it."),
      next("Run opencode --version to check it, then run npx open-bus again."),
    ],
    skipped: (h: HarnessName, reason: string) => [
      warn(
        `Skipped ${HARNESS_LABEL[h]}: ${clip(reason, 14 + len(HARNESS_LABEL[h]))}`,
      ),
      next("Fix it, then run npx open-bus again."),
    ],

    // install --check
    checkLine: (name: string, ok: boolean) =>
      ok ? done(name) : warn(`${name}: not done`),
    checkNext: () => next("Run npx open-bus to set it up."),

    // status
    connectedTo: (label: string, host: string) =>
      done(
        `Connected as ${clip(label, 46)} to ${clip(host, 20 + Math.min(len(label), 34))}`,
      ),
    notConnected: () => [
      fail("This machine is not connected."),
      next("Run npx open-bus to approve it."),
    ],
    daemonDown: () => [
      fail("The daemon is not running."),
      next("Run npx open-bus doctor to see why."),
    ],
    hubConnected: () => done("Hub connected"),
    hubConnecting: () => [
      warn("The daemon cannot reach the hub yet; it keeps retrying."),
      next("Check your network, then run npx open-bus doctor."),
    ],
    noNamespace: () =>
      p(
        "muted",
        "This folder has no namespace, so there is no roster to show.",
      ),

    // doctor
    notConnectedWarn: () => [
      warn("This machine is not connected."),
      next("Run npx open-bus to approve it."),
    ],
    machineFileOpen: (path: string) => [
      warn(`${clip(path, 33)} is readable by other users.`),
      next(`Run chmod 600 ${clip(path, 18)}.`),
    ],
    machineFileBad: (path: string) => [
      warn(`${clip(path, 24)} cannot be read.`),
      next("Run npx open-bus login to approve this machine again."),
    ],
    daemonNotAnswering: (socket: string) => [
      warn(`The daemon is not answering on ${clip(socket, 36)}.`),
      next("Run npx open-bus daemon to start it in this terminal."),
    ],
    daemonRunningPlain: (pid: number) => done("Daemon running", `pid ${pid}`),
    harnessConfigured: (h: HarnessName, version?: string) =>
      done(
        version
          ? `${HARNESS_LABEL[h]} ${clip(version, 40)} configured`
          : `${HARNESS_LABEL[h]} configured`,
      ),
    harnessMissing: (h: HarnessName) => [
      warn(`${HARNESS_LABEL[h]} is installed but not configured.`),
      next("Run npx open-bus to configure it."),
    ],
    harnessAbsent: (h: HarnessName) =>
      next(p("muted", `${HARNESS_LABEL[h]} not found`)),
    allGood: () => done("No problems found."),
    footer: (version: string, node: string, platform: string, home: string) => {
      const lead = `open-bus ${version} ${g("sep")} node ${node} ${g("sep")} ${platform} ${g("sep")} `;
      return p("muted", `${lead}${clip(home, len(lead))}`);
    },

    // uninstall
    removedFrom: (names: HarnessName[]) =>
      done(
        `Removed OpenBus from ${listing(
          names.map((h) => HARNESS_LABEL[h]),
          "and",
        )}`,
      ),
    nothingToRemove: () =>
      done("Nothing to remove from Claude Code, OpenCode or Pi"),
    couldNotRemove: (h: HarnessName, reason: string) => [
      warn(
        `Could not remove OpenBus from ${HARNESS_LABEL[h]}: ${clip(reason, 37 + len(HARNESS_LABEL[h]))}`,
      ),
      next("Fix it, then run npx open-bus uninstall again."),
    ],
    serviceRemoved: () => done("Stopped and removed the daemon service"),
    kept: (home: string) => [
      done(`Kept ${clip(home, 41)}, so this machine stays approved.`),
      next(p("muted", "Run npx open-bus uninstall --purge to remove it too.")),
    ],
    purged: (home: string) => [
      done(`Removed this machine's token and files from ${clip(home, 47)}`),
      next(
        p(
          "muted",
          "The hub lists this machine until you revoke it on the dashboard.",
        ),
      ),
    ],
    purgeLeftDir: (home: string) => [
      warn(
        `Left ${clip(home, 57)} in place: it holds files OpenBus did not create.`,
      ),
    ],
    purgeDaemonRunning: (pid: number) => [
      `${fail("The daemon is still running.")}  ${p("muted", `pid ${pid}`)}`,
      next("Stop it, then run npx open-bus uninstall --purge again."),
    ],

    // logs, mcp
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
