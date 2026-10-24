import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { openbusHome } from "@ob/adapter-claude-code";
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
  /**
   * Installs and (re)starts it, or starts the daemon in the background.
   * `running`: a daemon that would not stop holds the socket, and nothing
   * was started.
   */
  ensure: () => Promise<{ running?: number }>;
  /** install could not start a service and runs the daemon itself. */
  fallback?: boolean;
  /**
   * Stops and removes the service (`unit`), or stops a daemon running
   * without one (`stopped`). `running`: a daemon still answers after.
   */
  remove: () => Promise<{
    unit?: "launchd" | "systemd";
    stopped?: boolean;
    running?: number;
  }>;
  problems?: () => ServiceProblem[];
  /**
   * Copies the CLI to <OPENBUS_HOME>/bin; the argv that runs that copy, for
   * the service and every harness entry. Never argv[1]: under npx it is a
   * cache path that gets cleaned.
   */
  cli: () => string[];
};
export const noService: Service = {
  ensure: async () => ({}),
  remove: async () => ({}),
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

/** The package's version, set by the bundler (scripts/bundle.mjs). */
declare const __OPENBUS_VERSION__: string | undefined;

export const VERSION: string =
  typeof __OPENBUS_VERSION__ === "string"
    ? __OPENBUS_VERSION__
    : (
        JSON.parse(
          readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ) as { version: string }
      ).version;

const which = (cmd: string) => {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** A process's command line: `ps`, else /proc (slim containers lack ps). */
export function processArgs(
  pid: number,
  io = {
    ps: (pid: number) =>
      execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    proc: (path: string) => readFileSync(path, "utf8"),
  },
): string | undefined {
  try {
    return io.ps(pid).trim() || undefined;
  } catch {}
  try {
    return (
      io.proc(`/proc/${pid}/cmdline`).split("\0").filter(Boolean).join(" ") ||
      undefined
    );
  } catch {
    return undefined;
  }
}

/** The daemon detached from this process, its output appended to the logs. */
const spawnDaemon = (
  cmd: string,
  args: string[],
  opts: { env: Record<string, string>; out: string; err: string },
) => {
  const out = openSync(opts.out, "a", 0o600);
  const err = openSync(opts.err, "a", 0o600);
  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: ["ignore", out, err],
      env: { ...process.env, ...opts.env },
    });
    child.unref();
    return child.pid;
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
    home: openbusHome(env),
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
    processArgs,
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
