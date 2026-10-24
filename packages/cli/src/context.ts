import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { daemonStatus, type StatusReply } from "@ob/ipc";
import { type Copy, copy } from "./copy.ts";
import { type Deps, realDeps } from "./deps.ts";
import { detectStyle, type Env, type Stream, type Style } from "./term.ts";

/**
 * The OS service that keeps the daemon running (C9: launchd, systemd). Until
 * C9 lands nothing is installed and `open-bus daemon` runs in a terminal.
 */
export type Service = {
  kind?: "launchd" | "systemd";
  ensure: () => Promise<void>;
  remove: () => Promise<void>;
};
export const noService: Service = {
  ensure: async () => {},
  remove: async () => {},
};

export type Out = Stream & { write: (s: string) => unknown };

/** Everything a command touches outside its own logic. */
export type Ctx = Deps & {
  stdout: Out;
  stderr: Out;
  env: Env;
  cwd: string;
  /** The user's home: harness configs live under it. */
  userHome: string;
  /** OPENBUS_HOME. */
  home: string;
  which: (cmd: string) => boolean;
  service: Service;
  status: (opts: {
    path: string;
    cwd?: string;
    timeoutMs?: number;
  }) => Promise<StatusReply>;
  version: string;
  /** This executable, for the MCP entries; OPENBUS_BIN overrides it. */
  bin: string;
  style: Style;
  copy: Copy;
  platform: string;
  nodeVersion: string;
};

export const VERSION: string = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    version: string;
  }
).version;

const which = (cmd: string) => {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

export function realCtx(noColor: boolean): Ctx {
  const env = process.env;
  const style = detectStyle(env, process.stdout, noColor);
  return {
    ...realDeps,
    print: (line) => process.stdout.write(`${line}\n`),
    stdout: process.stdout,
    stderr: process.stderr,
    env,
    cwd: process.cwd(),
    userHome: homedir(),
    home: env.OPENBUS_HOME ?? join(homedir(), ".openbus"),
    which,
    service: noService,
    status: daemonStatus,
    version: VERSION,
    bin: process.argv[1] ?? "open-bus",
    style,
    copy: copy(style),
    platform: `${process.platform} ${process.arch}`,
    nodeVersion: process.version,
  };
}

/** Writes lines to stdout, or to stderr for a failure block. */
export const say = (ctx: Ctx, ...lines: (string | string[])[]) => {
  for (const l of lines.flat()) ctx.stdout.write(`${l}\n`);
};
export const sayErr = (ctx: Ctx, ...lines: (string | string[])[]) => {
  for (const l of lines.flat()) ctx.stderr.write(`${l}\n`);
};

/** `~/.openbus/machine.json` for paths under the user's home. */
export const tilde = (ctx: Pick<Ctx, "userHome">, path: string) =>
  path === ctx.userHome
    ? "~"
    : path.startsWith(`${ctx.userHome}/`)
      ? `~${path.slice(ctx.userHome.length)}`
      : path;
