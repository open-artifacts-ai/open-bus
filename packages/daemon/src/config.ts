import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  daemonSocketPath,
  MAX_SOCKET_PATH,
  openbusHome,
  shortSocketDir,
  unsafeSocketDir,
} from "@ob/adapter-claude-code";
import { isMachineToken, newMachineLabel } from "@ob/shared";

export type Config = {
  hub: string;
  machine_id: string;
  label: string;
  machine_token: string;
};

export const home = () => openbusHome();
export const socketPath = () => daemonSocketPath(home());

/** Claude's return sockets (`<8 hex>.sock`): under the home, or the short folder when they would not fit. */
export const claudeReturnDir = (h = home()): string => {
  const dir = join(h, "claude-return");
  return Buffer.byteLength(join(dir, "00000000.sock")) <= MAX_SOCKET_PATH
    ? dir
    : join(shortSocketDir(h), "claude-return");
};

/**
 * Creates the short socket folder when the daemon socket or the Claude return
 * folder is in it. A folder that another user made, or one open to them, is
 * never used, and neither is a socket path too long to bind: a lasting failure.
 */
export function prepareSocketDir(
  listenPath: string,
  returnDir: string,
  h = home(),
): void {
  if (Buffer.byteLength(listenPath) > MAX_SOCKET_PATH)
    throw new StartError(
      "SOCKET_PATH",
      `socket path is too long for a unix socket (${Buffer.byteLength(listenPath)} > ${MAX_SOCKET_PATH} bytes): ${listenPath}`,
    );
  const dir = shortSocketDir(h);
  if (![listenPath, returnDir].some((p) => p.startsWith(`${dir}/`))) return;
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST")
      throw new StartError(
        "SOCKET_PATH",
        `cannot create the socket folder ${dir}: ${e instanceof Error ? e.message : String(e)}`,
      );
  }
  const problem = unsafeSocketDir(dir);
  if (problem)
    throw new StartError(
      "SOCKET_PATH",
      `${dir} ${problem}; refusing to use it`,
    );
}

const NOT_LOGGED_IN = "not logged in: run `open-bus login`";

/** Start failures no restart fixes; the service matches on `code`, never the message. */
export const START_ERROR_CODES = [
  "NOT_LOGGED_IN",
  "HUB_MISMATCH",
  "BAD_HUB",
  "CREDENTIALS_OPEN",
  "CREDENTIALS_UNREADABLE",
  "REVOKED",
  "SOCKET_IN_USE",
  "SOCKET_PATH",
] as const;
export type StartErrorCode = (typeof START_ERROR_CODES)[number];

export class StartError extends Error {
  readonly code: StartErrorCode;
  constructor(code: StartErrorCode, message: string) {
    super(message);
    this.name = "StartError";
    this.code = code;
  }
}

const notLoggedIn = () => new StartError("NOT_LOGGED_IN", NOT_LOGGED_IN);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function checkHub(hub: string): void {
  let u: URL;
  try {
    u = new URL(hub);
  } catch {
    throw new StartError("BAD_HUB", `invalid hub url: ${hub}`);
  }
  if (!["ws:", "wss:", "http:", "https:"].includes(u.protocol)) {
    throw new StartError("BAD_HUB", `invalid hub url scheme: ${u.protocol}`);
  }
  if (
    (u.protocol === "ws:" || u.protocol === "http:") &&
    !LOOPBACK.has(u.hostname)
  ) {
    throw new StartError(
      "BAD_HUB",
      `refusing ${u.protocol}// to non-loopback host ${u.hostname}: the machine token would travel in the clear; use wss://`,
    );
  }
}

/** ws and http name the same server: compare as http(s) origins. */
function originOf(url: string): string | undefined {
  try {
    const u = new URL(url.replace(/^ws(s?):/, "http$1:"));
    return u.origin;
  } catch {
    return undefined;
  }
}

// An old or hand-edited label must not make the hub reject every hello.
const cleanLabel = (raw: unknown): string =>
  typeof raw === "string" ? newMachineLabel(raw) : "machine";

export function readConfig(): Config {
  // The hub refused this token; only `open-bus login` clears the marker.
  if (existsSync(join(home(), "revoked")))
    throw new StartError(
      "REVOKED",
      "this machine was revoked; run `open-bus login`",
    );
  const file = join(home(), "machine.json");
  let text: string;
  try {
    if (process.platform !== "win32" && statSync(file).mode & 0o077) {
      throw new StartError(
        "CREDENTIALS_OPEN",
        `${file} is readable by other users: run \`chmod 600 ${file}\``,
      );
    }
    text = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw notLoggedIn();
    // Owned by another user (a `sudo npx open-bus`): no restart fixes it.
    if (code === "EACCES" || code === "EPERM")
      throw new StartError(
        "CREDENTIALS_UNREADABLE",
        `cannot read ${file} (${code}): it must belong to you`,
      );
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's message quotes the source, which holds the token.
    throw notLoggedIn();
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw notLoggedIn();
  }
  const r = raw as Partial<Config>;
  const hub = process.env.OPENBUS_HUB ?? r.hub;
  if (!hub || r.machine_token === undefined) throw notLoggedIn();
  // The token goes only to the hub that issued it.
  if (r.hub && hub !== r.hub && originOf(hub) !== originOf(r.hub))
    throw new StartError(
      "HUB_MISMATCH",
      `the hub ${hub} is not the one this machine was approved for (${r.hub}); run \`open-bus login --hub ${hub}\` to approve it there`,
    );
  if (!isMachineToken(r.machine_token)) {
    throw new StartError(
      "NOT_LOGGED_IN",
      "machine.json has a malformed machine token: run `open-bus login`",
    );
  }
  checkHub(hub);
  return {
    hub,
    machine_id: r.machine_id ?? "",
    label: cleanLabel(r.label),
    machine_token: r.machine_token,
  };
}
