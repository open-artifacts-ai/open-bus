import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMachineToken } from "@ob/shared";

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
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function checkHub(hub: string): void {
  let u: URL;
  try {
    u = new URL(hub);
  } catch {
    throw new Error(`invalid hub url: ${hub}`);
  }
  if (!["ws:", "wss:", "http:", "https:"].includes(u.protocol)) {
    throw new Error(`invalid hub url scheme: ${u.protocol}`);
  }
  if (
    (u.protocol === "ws:" || u.protocol === "http:") &&
    !LOOPBACK.has(u.hostname)
  ) {
    throw new Error(
      `refusing ${u.protocol}// to non-loopback host ${u.hostname}: the machine token would travel in the clear; use wss://`,
    );
  }
}

export function readConfig(): Config {
  const file = join(home(), "machine.json");
  let text: string;
  try {
    if (process.platform !== "win32" && statSync(file).mode & 0o077) {
      throw new Error(
        `${file} is readable by other users: run \`chmod 600 ${file}\``,
      );
    }
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(NOT_LOGGED_IN);
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's message quotes the source, which holds the token.
    throw new Error(NOT_LOGGED_IN);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(NOT_LOGGED_IN);
  }
  const r = raw as Partial<Config>;
  const hub = process.env.OPENBUS_HUB ?? r.hub;
  if (!hub || r.machine_token === undefined) throw new Error(NOT_LOGGED_IN);
  if (!isMachineToken(r.machine_token)) {
    throw new Error(
      "machine.json has a malformed machine token: run `open-bus login`",
    );
  }
  checkHub(hub);
  return {
    hub,
    machine_id: r.machine_id ?? "",
    label: r.label ?? "machine",
    machine_token: r.machine_token,
  };
}
