import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Service, ServiceProblem } from "../context.ts";
import type { Deps } from "../deps.ts";
import type { Env } from "../term.ts";
import { readInstallFile, updateInstallFile } from "./step.ts";

export const LAUNCHD_LABEL = "ai.open-bus.daemon";
export const SYSTEMD_UNIT = "open-bus.service";
/** EX_CONFIG: the daemon's exit on revoke. systemd never restarts it. */
export const REVOKED_EXIT = 78;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const STOP_WAIT_MS = 5000;
const POLL_MS = 250;

/** What the service runs: `<node> <entry> daemon`, with `env`, logging to `out` and `err`. */
export type Unit = {
  node: string;
  entry: string;
  env: Record<string, string>;
  out: string;
  err: string;
};

/** A line break would end the value and start a key or directive of its own. */
const oneLine = (v: string) => {
  if (/[\r\n\0]/.test(v))
    throw new Error(
      `refusing a service value with a line break: ${JSON.stringify(v)}`,
    );
  return v;
};

const xml = (v: string) =>
  oneLine(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export function renderPlist(u: Unit): string {
  const str = (v: string) => `<string>${xml(v)}</string>`;
  const env = Object.entries(u.env)
    .map(([k, v]) => `<key>${xml(k)}</key>${str(v)}`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${str(u.node)}${str(u.entry)}${str("daemon")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key>${str(u.out)}
  <key>StandardErrorPath</key>${str(u.err)}
  <key>EnvironmentVariables</key>
  <dict>${env}</dict>
</dict>
</plist>
`;
}

/** systemd expands `%` specifiers everywhere. */
const specifiers = (v: string) => oneLine(v).replaceAll("%", "%%");
/** A double-quoted word: C escapes for `\` and `"`. */
const quoted = (v: string) =>
  `"${specifiers(v).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
/** ExecStart also expands `$VAR`. */
const execWord = (v: string) => quoted(v.replaceAll("$", "$$$$"));

export function renderSystemd(u: Unit): string {
  const env = Object.entries(u.env)
    .map(([k, v]) => `Environment=${quoted(`${k}=${v}`)}\n`)
    .join("");
  return `[Unit]
Description=OpenBus daemon
After=network-online.target

[Service]
Type=simple
ExecStart=${execWord(u.node)} ${execWord(u.entry)} daemon
Restart=on-failure
RestartSec=10
RestartPreventExitStatus=${REVOKED_EXIT}
${env}StandardOutput=append:${specifiers(u.out)}
StandardError=append:${specifiers(u.err)}

[Install]
WantedBy=default.target
`;
}

/**
 * The CLI the service runs. Under npx the running copy lives in a cache that
 * is cleaned, so install copies it to `<OPENBUS_HOME>/bin` first.
 */
export type CliSource =
  /** The bundle, with its assets beside it. */
  | { kind: "bundle"; file: string }
  /** The TypeScript sources through jiti, until C10 ships the bundle. */
  | { kind: "dev"; main: string; jiti: string };

export function cliSource(): CliSource {
  const here = fileURLToPath(import.meta.url);
  return here.endsWith(".ts")
    ? {
        kind: "dev",
        main: fileURLToPath(new URL("../main.ts", import.meta.url)),
        jiti: import.meta.resolve("jiti"),
      }
    : { kind: "bundle", file: here };
}

const entryName = (src: CliSource) =>
  src.kind === "bundle" ? basename(src.file) : "open-bus.js";

const shim = (src: { main: string; jiti: string }) =>
  `// Written by open-bus install: runs the sources it was installed from.
import { createJiti } from ${JSON.stringify(src.jiti)};

const jiti = createJiti(${JSON.stringify(src.main)});
const { main } = await jiti.import(${JSON.stringify(src.main)});
const code = await main(process.argv.slice(2));
if (code !== undefined) process.exit(code);
`;

/**
 * Replaces `<home>/bin` with a copy of `src`; returns the entry to run. The
 * home and bin are 0700: whoever can write them picks what launchd runs.
 */
export function installCli(home: string, src: CliSource): string {
  const bin = join(home, "bin");
  const tmp = `${bin}.${process.pid}.tmp`;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  rmSync(tmp, { recursive: true, force: true });
  if (src.kind === "bundle")
    cpSync(dirname(src.file), tmp, { recursive: true });
  else {
    mkdirSync(tmp);
    writeFileSync(join(tmp, entryName(src)), shim(src));
  }
  chmodSync(tmp, 0o700);
  if (!existsSync(join(tmp, "package.json")))
    writeFileSync(join(tmp, "package.json"), '{ "type": "module" }\n');
  rmSync(bin, { recursive: true, force: true });
  renameSync(tmp, bin);
  return join(bin, entryName(src));
}

/** The file itself, a symlink included (existsSync follows the link). */
const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Temp file and rename: a symlink at `path` is replaced, never written through. */
function writeReplacing(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
}

export type ServiceDeps = {
  platform: NodeJS.Platform;
  userHome: string;
  /** OPENBUS_HOME, read on each call: `--home` sets it after the ctx is made. */
  home: () => string;
  env: Env;
  exec: Deps["exec"];
  sleep: Deps["sleep"];
  /** The node the service runs the CLI with. */
  execPath: string;
  uid: number;
  user: string;
  /** systemd-logind's linger flags; default /var/lib/systemd/linger. */
  lingerDir?: string;
  source: () => CliSource;
  /** The pid of the daemon answering on the socket; undefined when none does. */
  daemonPid: () => Promise<number | undefined>;
  /** SIGTERM to that daemon. */
  kill: (pid: number) => void;
  /** Starts the daemon detached, when no service manager will. */
  spawnDaemon: (
    cmd: string,
    args: string[],
    opts: { env: Record<string, string>; out: string; err: string },
  ) => void;
};

type Record_ = {
  kind?: "launchd" | "systemd";
  node?: string;
  entry?: string;
  unit?: string;
  /** install could not start a service and ran the daemon itself. */
  fallback?: boolean;
};

/** launchd on macOS, systemd --user on Linux, else a background daemon. */
export function systemService(d: ServiceDeps): Service {
  const manager =
    d.platform === "darwin"
      ? "launchd"
      : d.platform === "linux"
        ? "systemd"
        : undefined;
  const home = () => resolve(d.home());
  const installFile = () => join(home(), "install.json");
  const record = (): Record_ => {
    const r = readInstallFile(installFile()).service;
    return typeof r === "object" && r !== null ? (r as Record_) : {};
  };
  // systemd ignores an empty or relative XDG_CONFIG_HOME.
  const xdg = d.env.XDG_CONFIG_HOME;
  const configHome = xdg && isAbsolute(xdg) ? xdg : join(d.userHome, ".config");
  const fresh =
    manager === "launchd"
      ? join(d.userHome, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`)
      : join(configHome, "systemd/user", SYSTEMD_UNIT);
  /** Where install wrote the unit; the env may differ at uninstall. */
  const file = () => {
    const r = record().unit;
    return typeof r === "string" && present(r) ? r : fresh;
  };
  const installed = () => manager !== undefined && present(file());
  const domain = `gui/${d.uid}`;
  const systemctl = (...args: string[]) =>
    d.exec("systemctl", ["--user", ...args]);

  /** SIGTERMs `pid` (if given) and waits, bounded, for the socket to go quiet. */
  async function stopped(pid?: number): Promise<boolean> {
    if (pid !== undefined) d.kill(pid);
    for (let waited = 0; ; waited += POLL_MS) {
      if ((await d.daemonPid()) === undefined) return true;
      if (waited >= STOP_WAIT_MS) return false;
      await d.sleep(POLL_MS);
    }
  }

  async function startLaunchd(f: string, u: Unit): Promise<boolean> {
    writeReplacing(f, renderPlist(u));
    await d.exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
    // bootstrap can race the bootout's teardown: one retry.
    for (let i = 0; i < 2; i++) {
      if ((await d.exec("launchctl", ["bootstrap", domain, f])).code === 0)
        return true;
      await d.sleep(1000);
    }
    rmSync(f, { force: true });
    return false;
  }

  async function startSystemd(f: string, u: Unit): Promise<boolean> {
    writeReplacing(f, renderSystemd(u));
    for (const args of [
      ["daemon-reload"],
      ["enable", SYSTEMD_UNIT],
      ["restart", SYSTEMD_UNIT],
    ]) {
      if ((await systemctl(...args)).code === 0) continue;
      // No user session (WSL, a container): undo, and run it ourselves.
      if (args[0] !== "daemon-reload") await systemctl("disable", SYSTEMD_UNIT);
      rmSync(f, { force: true });
      if (args[0] !== "daemon-reload") await systemctl("daemon-reload");
      return false;
    }
    return true;
  }

  return {
    get kind() {
      return installed() ? manager : undefined;
    },

    get fallback() {
      return !installed() && record().fallback === true;
    },

    async ensure() {
      const h = home();
      const src = d.source();
      const logs = join(h, "logs");
      const u: Unit = {
        node: d.execPath,
        entry: join(h, "bin", entryName(src)),
        env: {
          PATH: d.env.PATH ?? DEFAULT_PATH,
          ...(h === join(d.userHome, ".openbus") ? {} : { OPENBUS_HOME: h }),
        },
        // One file: the daemon logs to stderr, and `open-bus logs` tails it.
        out: join(logs, "daemon.log"),
        err: join(logs, "daemon.log"),
      };
      // A service's daemon exits 0 on a lasting failure: no restart loop.
      const unit: Unit = { ...u, env: { ...u.env, OPENBUS_SERVICE: "1" } };
      // Refuse a line break before anything is written.
      renderPlist(unit);
      installCli(h, src);
      mkdirSync(logs, { recursive: true, mode: 0o700 });
      // A daemon in a terminal or from a fallback holds the socket: stop it,
      // or the service's daemon finds the socket taken.
      if (!installed()) {
        const pid = await d.daemonPid();
        if (pid !== undefined) await stopped(pid);
      }
      const f = fresh;
      const started =
        manager === "launchd"
          ? await startLaunchd(f, unit)
          : manager === "systemd"
            ? await startSystemd(f, unit)
            : false;
      if (started) {
        updateInstallFile(installFile(), {
          service: {
            kind: manager,
            node: u.node,
            entry: u.entry,
            unit: f,
          } satisfies Record_,
        });
        return;
      }
      updateInstallFile(installFile(), {
        service: { fallback: true } satisfies Record_,
      });
      // A booted-out daemon can answer a moment longer: wait it out.
      if (await stopped())
        d.spawnDaemon(u.node, [u.entry, "daemon"], {
          env: u.env,
          out: u.out,
          err: u.err,
        });
    },

    async remove() {
      if (!installed()) {
        // The fallback's daemon, or one in a terminal.
        const pid = await d.daemonPid();
        if (pid === undefined) return undefined;
        await stopped(pid);
        updateInstallFile(installFile(), { service: {} });
        return "daemon";
      }
      const f = file();
      if (manager === "launchd")
        await d.exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
      else await systemctl("disable", "--now", SYSTEMD_UNIT);
      rmSync(f, { force: true });
      if (manager === "systemd") await systemctl("daemon-reload");
      // `--purge` next refuses while the daemon still answers.
      await stopped();
      updateInstallFile(installFile(), { service: {} });
      return manager;
    },

    cli() {
      return [d.execPath, installCli(home(), d.source())];
    },

    problems() {
      if (!installed()) return [];
      const out: ServiceProblem[] = [];
      const node = record().node;
      if (typeof node === "string" && !existsSync(node))
        out.push({ kind: "node-missing", node });
      if (
        manager === "systemd" &&
        !existsSync(join(d.lingerDir ?? "/var/lib/systemd/linger", d.user))
      )
        out.push({ kind: "linger-off" });
      return out;
    },
  };
}
