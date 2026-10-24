import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
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

/** Replaces `<home>/bin` with a copy of `src`; returns the entry to run. */
export function installCli(home: string, src: CliSource): string {
  const bin = join(home, "bin");
  const tmp = `${bin}.${process.pid}.tmp`;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  rmSync(tmp, { recursive: true, force: true });
  if (src.kind === "bundle")
    cpSync(dirname(src.file), tmp, { recursive: true });
  else {
    mkdirSync(tmp);
    writeFileSync(join(tmp, entryName(src)), shim(src));
  }
  if (!existsSync(join(tmp, "package.json")))
    writeFileSync(join(tmp, "package.json"), '{ "type": "module" }\n');
  rmSync(bin, { recursive: true, force: true });
  renameSync(tmp, bin);
  return join(bin, entryName(src));
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
  /** The daemon answers on its socket. */
  answering: () => Promise<boolean>;
  /** Starts the daemon detached, when no service manager will. */
  spawnDaemon: (
    cmd: string,
    args: string[],
    opts: { env: Record<string, string>; out: string; err: string },
  ) => void;
};

/** launchd on macOS, systemd --user on Linux, else a background daemon. */
export function systemService(d: ServiceDeps): Service {
  const manager =
    d.platform === "darwin"
      ? "launchd"
      : d.platform === "linux"
        ? "systemd"
        : undefined;
  const plist = join(
    d.userHome,
    "Library/LaunchAgents",
    `${LAUNCHD_LABEL}.plist`,
  );
  const unitFile = () =>
    join(
      d.env.XDG_CONFIG_HOME ?? join(d.userHome, ".config"),
      "systemd/user",
      SYSTEMD_UNIT,
    );
  const file = () => (manager === "launchd" ? plist : unitFile());
  const installed = () => manager !== undefined && existsSync(file());
  const installFile = () => join(d.home(), "install.json");
  const domain = `gui/${d.uid}`;
  const systemctl = (...args: string[]) =>
    d.exec("systemctl", ["--user", ...args]);

  async function startLaunchd(u: Unit): Promise<boolean> {
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, renderPlist(u));
    await d.exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
    // bootstrap can race the bootout's teardown: one retry.
    for (let i = 0; i < 2; i++) {
      if ((await d.exec("launchctl", ["bootstrap", domain, plist])).code === 0)
        return true;
      await d.sleep(1000);
    }
    rmSync(plist, { force: true });
    return false;
  }

  async function startSystemd(u: Unit): Promise<boolean> {
    const f = unitFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, renderSystemd(u));
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

    async ensure() {
      const home = d.home();
      const src = d.source();
      const logs = join(home, "logs");
      const u: Unit = {
        node: d.execPath,
        entry: join(home, "bin", entryName(src)),
        env: {
          PATH: d.env.PATH ?? DEFAULT_PATH,
          ...(home === join(d.userHome, ".openbus")
            ? {}
            : { OPENBUS_HOME: home }),
        },
        // One file: the daemon logs to stderr, and `open-bus logs` tails it.
        out: join(logs, "daemon.log"),
        err: join(logs, "daemon.log"),
      };
      // Refuse a line break before anything is written.
      renderPlist(u);
      installCli(home, src);
      mkdirSync(logs, { recursive: true, mode: 0o700 });
      const started =
        manager === "launchd"
          ? await startLaunchd(u)
          : manager === "systemd"
            ? await startSystemd(u)
            : false;
      if (started) {
        updateInstallFile(installFile(), {
          service: { kind: manager, node: u.node, entry: u.entry },
        });
        return;
      }
      if (!(await d.answering()))
        d.spawnDaemon(u.node, [u.entry, "daemon"], {
          env: u.env,
          out: u.out,
          err: u.err,
        });
    },

    async remove() {
      if (!installed()) return false;
      if (manager === "launchd")
        await d.exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
      else await systemctl("disable", "--now", SYSTEMD_UNIT);
      rmSync(file(), { force: true });
      if (manager === "systemd") await systemctl("daemon-reload");
      // `--purge` next refuses while the daemon still answers.
      for (let waited = 0; waited < STOP_WAIT_MS; waited += POLL_MS) {
        if (!(await d.answering())) break;
        await d.sleep(POLL_MS);
      }
      return true;
    },

    cli() {
      return [d.execPath, installCli(d.home(), d.source())];
    },

    problems() {
      if (!installed()) return [];
      const out: ServiceProblem[] = [];
      const rec = readInstallFile(installFile()).service as
        | { node?: unknown }
        | undefined;
      if (typeof rec?.node === "string" && !existsSync(rec.node))
        out.push({ kind: "node-missing", node: rec.node });
      if (
        manager === "systemd" &&
        !existsSync(join(d.lingerDir ?? "/var/lib/systemd/linger", d.user))
      )
        out.push({ kind: "linger-off" });
      return out;
    },
  };
}
