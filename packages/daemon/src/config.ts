import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMachineToken, newMachineLabel } from "@ob/shared";

export type Config = {
  hub: string;
  machine_id: string;
  label: string;
  machine_token: string;
};

export const home = () =>
  process.env.OPENBUS_HOME ?? join(homedir(), ".openbus");
export const socketPath = () => join(home(), "daemon.sock");

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
