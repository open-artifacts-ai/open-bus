import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { daemonStatus, type StatusReply } from "@ob/ipc";
import { type Copy, copy } from "./copy.ts";
import { type Deps, realDeps } from "./deps.ts";
import { cliSource, systemService } from "./steps/service.ts";
import { detectStyle, type Env, type Stream, type Style } from "./term.ts";

/** What doctor reports about an installed service that still runs. */
export type ServiceProblem =
  | { kind: "node-missing"; node: string }
  | { kind: "linger-off" };

/**
 * The OS service that keeps the daemon running: launchd or systemd --user
 * (steps/service.ts). Without one, `open-bus daemon` runs in a terminal.
 */
export type Service = {
  /** The installed service; undefined when none is. */
  kind?: "launchd" | "systemd";
  /** Installs and (re)starts it, or starts the daemon in the background. */
  ensure: () => Promise<void>;
  /** install could not start a service and runs the daemon itself. */
  fallback?: boolean;
  /**
   * Stops and removes the service, or stops a daemon running without one;
   * what was stopped, undefined when nothing was.
   */
  remove: () => Promise<"launchd" | "systemd" | "daemon" | undefined>;
  problems?: () => ServiceProblem[];
  /**
   * Copies the CLI to <OPENBUS_HOME>/bin; the argv that runs that copy, for
   * the service and every harness entry. Never argv[1]: under npx it is a
   * cache path that gets cleaned.
   */
  cli: () => string[];
};
export const noService: Service = {
  ensure: async () => {},
  remove: async () => undefined,
  cli: () => ["open-bus"],
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

/** The daemon detached from this process, its output appended to the logs. */
const spawnDaemon = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; out: string; err: string },
) => {
  const out = openSync(opts.out, "a", 0o600);
  const err = openSync(opts.err, "a", 0o600);
  try {
    spawn(cmd, args, {
      detached: true,
      stdio: ["ignore", out, err],
      env: { ...process.env, ...opts.env },
    }).unref();
  } finally {
    closeSync(out);
    closeSync(err);
  }
};

const userName = () => {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
};

export function realCtx(noColor: boolean): Ctx {
  const env = process.env;
  const style = detectStyle(env, process.stdout, noColor);
  const ctx: Ctx = {
    ...realDeps,
    print: (line) => process.stdout.write(`${line}\n`),
    stdout: process.stdout,
    stderr: process.stderr,
    env,
    cwd: process.cwd(),
    userHome: homedir(),
    // Absolute: the plist and unit must never carry a relative path.
    home: resolve(env.OPENBUS_HOME || join(homedir(), ".openbus")),
    which,
    service: noService,
    status: daemonStatus,
    version: VERSION,
    style,
    copy: copy(style),
    platform: `${process.platform} ${process.arch}`,
    nodeVersion: process.version,
  };
  ctx.service = systemService({
    platform: process.platform,
    userHome: ctx.userHome,
    home: () => ctx.home,
    env,
    exec: ctx.exec,
    sleep: ctx.sleep,
    execPath: process.execPath,
    uid: process.getuid?.() ?? 0,
    user: userName(),
    source: cliSource,
    daemonPid: () =>
      ctx.status({ path: join(ctx.home, "daemon.sock"), timeoutMs: 1000 }).then(
        (st) => st.pid,
        () => undefined,
      ),
    kill: (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    },
    spawnDaemon,
  });
  return ctx;
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
