import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { realCtx } from "../src/context.ts";
import { guardServiceManager, makeExec } from "../src/deps.ts";
import {
  type CliSource,
  installCli,
  LAUNCHD_LABEL,
  REVOKED_EXIT,
  renderPlist,
  renderSystemd,
  type ServiceDeps,
  SYSTEMD_UNIT,
  systemService,
  type Unit,
} from "../src/steps/service.ts";
import { SENTINEL_HOME, serviceWrites } from "./sentinel.ts";

const unit = (over: Partial<Unit> = {}): Unit => ({
  node: "/usr/local/bin/node",
  entry: "/Users/leo/.openbus/bin/open-bus.js",
  env: { PATH: "/usr/bin:/bin" },
  out: "/Users/leo/.openbus/logs/daemon.log",
  err: "/Users/leo/.openbus/logs/daemon.err.log",
  ...over,
});

describe("renderPlist", () => {
  it("runs node on the stable copy, keeps it alive on failure, logs under logs/", () => {
    const p = renderPlist(unit());
    expect(p).toContain(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`);
    expect(p).toContain(
      "<array><string>/usr/local/bin/node</string><string>/Users/leo/.openbus/bin/open-bus.js</string><string>daemon</string></array>",
    );
    expect(p).toContain(
      "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    );
    expect(p).toContain(
      "<key>StandardOutPath</key><string>/Users/leo/.openbus/logs/daemon.log</string>",
    );
    expect(p).toContain(
      "<key>StandardErrorPath</key><string>/Users/leo/.openbus/logs/daemon.err.log</string>",
    );
    expect(p).toContain("<key>PATH</key><string>/usr/bin:/bin</string>");
    expect(p).not.toContain("OPENBUS_HOME");
  });

  it("escapes XML and keeps spaces", () => {
    const p = renderPlist(
      unit({
        entry: "/Users/a b/<x>&'\".js",
        env: { PATH: "/a&b", OPENBUS_HOME: "/Users/a b/bus" },
      }),
    );
    expect(p).toContain(
      "<string>/Users/a b/&lt;x&gt;&amp;&apos;&quot;.js</string>",
    );
    expect(p).toContain("<key>PATH</key><string>/a&amp;b</string>");
    expect(p).toContain(
      "<key>OPENBUS_HOME</key><string>/Users/a b/bus</string>",
    );
  });

  it("refuses a value with a line break", () => {
    expect(() => renderPlist(unit({ entry: "/a\n/b" }))).toThrow(/line break/);
    expect(() => renderPlist(unit({ env: { PATH: "/a\r" } }))).toThrow(
      /line break/,
    );
  });
});

describe("renderSystemd", () => {
  it("quotes ExecStart, restarts on failure but not on revoke", () => {
    const u = renderSystemd(unit());
    expect(u).toContain(
      'ExecStart="/usr/local/bin/node" "/Users/leo/.openbus/bin/open-bus.js" daemon',
    );
    expect(u).toContain("Restart=on-failure");
    expect(u).toContain(`RestartPreventExitStatus=${REVOKED_EXIT}`);
    expect(u).toContain('Environment="PATH=/usr/bin:/bin"');
    expect(u).toContain(
      "StandardOutput=append:/Users/leo/.openbus/logs/daemon.log",
    );
    expect(u).toContain(
      "StandardError=append:/Users/leo/.openbus/logs/daemon.err.log",
    );
    expect(u).toContain("WantedBy=default.target");
  });

  it("escapes quotes, backslashes, specifiers and variables; keeps spaces", () => {
    const u = renderSystemd(
      unit({
        entry: '/home/a b/x"\\%$y.js',
        env: { PATH: "/a b:%h", OPENBUS_HOME: "/home/a b/bus" },
        out: "/home/a b/50%.log",
      }),
    );
    expect(u).toContain('"/home/a b/x\\"\\\\%%$$y.js" daemon');
    expect(u).toContain('Environment="PATH=/a b:%%h"');
    expect(u).toContain('Environment="OPENBUS_HOME=/home/a b/bus"');
    expect(u).toContain("StandardOutput=append:/home/a b/50%%.log");
  });

  it("refuses a value with a line break", () => {
    expect(() => renderSystemd(unit({ node: "/n\node" }))).toThrow(
      /line break/,
    );
    expect(() =>
      renderSystemd(unit({ env: { PATH: "/a\n[Service]" } })),
    ).toThrow(/line break/);
  });
});

const tmp = () => mkdtempSync(join(tmpdir(), "ob-svc-"));

describe("installCli", () => {
  it("copies a bundle and its assets into <home>/bin", () => {
    const dist = tmp();
    writeFileSync(join(dist, "open-bus.js"), "// bundle");
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets/plugin.ts"), "x");
    const home = join(tmp(), ".openbus");
    const entry = installCli(home, {
      kind: "bundle",
      file: join(dist, "open-bus.js"),
    });
    expect(entry).toBe(join(home, "bin/open-bus.js"));
    expect(readFileSync(entry, "utf8")).toBe("// bundle");
    expect(readFileSync(join(home, "bin/assets/plugin.ts"), "utf8")).toBe("x");
    // A second install replaces the copy, not nests it.
    writeFileSync(join(dist, "open-bus.js"), "// v2");
    installCli(home, { kind: "bundle", file: join(dist, "open-bus.js") });
    expect(readFileSync(entry, "utf8")).toBe("// v2");
    expect(existsSync(join(home, "bin/bin"))).toBe(false);
  });

  it("before the bundle, writes a shim that runs these sources", () => {
    const home = join(tmp(), ".openbus");
    const src: CliSource = {
      kind: "dev",
      main: new URL("../src/main.ts", import.meta.url).pathname,
      jiti: import.meta.resolve("jiti"),
    };
    const entry = installCli(home, src);
    expect(entry).toBe(join(home, "bin/open-bus.js"));
    const out = execFileSync(process.execPath, [entry, "version"], {
      env: { ...process.env, OPENBUS_HOME: home, NO_COLOR: "1" },
      encoding: "utf8",
    });
    expect(out).toMatch(/^open-bus \d+\.\d+\.\d+/);
  });
});

type Call = [string, string[]];

function deps(
  platform: NodeJS.Platform,
  over: Partial<ServiceDeps> = {},
  fail: (cmd: string, args: string[]) => boolean = () => false,
) {
  const userHome = tmp();
  const home = join(userHome, ".openbus");
  const calls: Call[] = [];
  const dist = tmp();
  writeFileSync(join(dist, "open-bus.js"), "// bundle");
  const d: ServiceDeps = {
    platform,
    userHome,
    home: () => home,
    env: { PATH: "/opt/x/bin:/usr/bin" },
    exec: vi.fn(async (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      return fail(cmd, args)
        ? { code: 1, stdout: "", stderr: "Failed to connect to bus" }
        : { code: 0, stdout: "", stderr: "" };
    }),
    sleep: vi.fn(async () => {}),
    execPath: "/opt/node/bin/node",
    uid: 501,
    user: "leo",
    lingerDir: join(userHome, "linger"),
    source: () => ({ kind: "bundle", file: join(dist, "open-bus.js") }),
    answering: vi.fn(async () => false),
    spawnDaemon: vi.fn(),
    ...over,
  };
  return { d, calls, userHome, home };
}

describe("systemService: launchd", () => {
  const plistOf = (userHome: string) =>
    join(userHome, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);

  it("copies the cli, writes the plist and bootstraps it", async () => {
    const { d, calls, userHome, home } = deps("darwin");
    const s = systemService(d);
    expect(s.kind).toBeUndefined();
    await s.ensure();
    const plist = readFileSync(plistOf(userHome), "utf8");
    expect(plist).toContain(
      `<string>/opt/node/bin/node</string><string>${home}/bin/open-bus.js</string><string>daemon</string>`,
    );
    expect(plist).toContain(
      "<key>PATH</key><string>/opt/x/bin:/usr/bin</string>",
    );
    expect(plist).not.toContain("OPENBUS_HOME");
    expect(plist).toContain(`${home}/logs/daemon.log`);
    expect(existsSync(join(home, "bin/open-bus.js"))).toBe(true);
    expect(existsSync(join(home, "logs"))).toBe(true);
    expect(calls).toEqual([
      ["launchctl", ["bootout", `gui/501/${LAUNCHD_LABEL}`]],
      ["launchctl", ["bootstrap", "gui/501", plistOf(userHome)]],
    ]);
    expect(s.kind).toBe("launchd");
    expect(d.spawnDaemon).not.toHaveBeenCalled();
  });

  it("passes OPENBUS_HOME when it is not the default", async () => {
    const { d, userHome } = deps("darwin");
    const other = join(userHome, "elsewhere bus");
    await systemService({ ...d, home: () => other }).ensure();
    expect(readFileSync(plistOf(userHome), "utf8")).toContain(
      `<key>OPENBUS_HOME</key><string>${other}</string>`,
    );
  });

  it("retries a bootstrap that races the bootout once", async () => {
    let n = 0;
    const { d, calls } = deps(
      "darwin",
      {},
      (_c, a) => a[0] === "bootstrap" && n++ === 0,
    );
    const s = systemService(d);
    await s.ensure();
    expect(calls.filter((c) => c[1][0] === "bootstrap")).toHaveLength(2);
    expect(s.kind).toBe("launchd");
  });

  it("remove stops the service and deletes the plist; false when there was none", async () => {
    const { d, calls, userHome } = deps("darwin");
    const s = systemService(d);
    expect(await s.remove()).toBe(false);
    await s.ensure();
    calls.length = 0;
    expect(await s.remove()).toBe(true);
    expect(calls).toEqual([
      ["launchctl", ["bootout", `gui/501/${LAUNCHD_LABEL}`]],
    ]);
    expect(existsSync(plistOf(userHome))).toBe(false);
    expect(s.kind).toBeUndefined();
  });

  it("remove waits until the daemon stops answering", async () => {
    let answers = 3;
    const { d } = deps("darwin", {
      answering: vi.fn(async () => answers-- > 0),
    });
    const s = systemService(d);
    await s.ensure();
    await s.remove();
    expect(d.answering).toHaveBeenCalledTimes(4);
  });
});

describe("systemService: systemd", () => {
  const unitOf = (userHome: string) =>
    join(userHome, ".config/systemd/user", SYSTEMD_UNIT);

  it("writes the unit, reloads, enables and restarts it", async () => {
    const { d, calls, userHome, home } = deps("linux");
    const s = systemService(d);
    await s.ensure();
    const u = readFileSync(unitOf(userHome), "utf8");
    expect(u).toContain(
      `ExecStart="/opt/node/bin/node" "${home}/bin/open-bus.js" daemon`,
    );
    expect(u).toContain('Environment="PATH=/opt/x/bin:/usr/bin"');
    expect(calls).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", SYSTEMD_UNIT]],
      ["systemctl", ["--user", "restart", SYSTEMD_UNIT]],
    ]);
    expect(s.kind).toBe("systemd");
  });

  it("honours XDG_CONFIG_HOME", async () => {
    const { d, userHome } = deps("linux");
    const xdg = join(userHome, "xdg");
    await systemService({
      ...d,
      env: { ...d.env, XDG_CONFIG_HOME: xdg },
    }).ensure();
    expect(existsSync(join(xdg, "systemd/user", SYSTEMD_UNIT))).toBe(true);
  });

  it("falls back to a background daemon when systemctl --user fails", async () => {
    const { d, userHome, home } = deps("linux", {}, (c) => c === "systemctl");
    const s = systemService(d);
    await s.ensure();
    expect(existsSync(unitOf(userHome))).toBe(false);
    expect(s.kind).toBeUndefined();
    expect(d.spawnDaemon).toHaveBeenCalledWith(
      "/opt/node/bin/node",
      [join(home, "bin/open-bus.js"), "daemon"],
      {
        env: { PATH: "/opt/x/bin:/usr/bin" },
        out: join(home, "logs/daemon.log"),
        err: join(home, "logs/daemon.log"),
      },
    );
  });

  it("the fallback never starts a second daemon", async () => {
    const { d } = deps(
      "linux",
      { answering: vi.fn(async () => true) },
      (c) => c === "systemctl",
    );
    await systemService(d).ensure();
    expect(d.spawnDaemon).not.toHaveBeenCalled();
  });

  it("an enable that fails undoes the unit", async () => {
    const { d, calls, userHome } = deps(
      "linux",
      {},
      (_c, a) => a[1] === "restart",
    );
    await systemService(d).ensure();
    expect(existsSync(unitOf(userHome))).toBe(false);
    expect(calls.slice(-2)).toEqual([
      ["systemctl", ["--user", "disable", SYSTEMD_UNIT]],
      ["systemctl", ["--user", "daemon-reload"]],
    ]);
  });

  it("remove disables and deletes the unit", async () => {
    const { d, calls, userHome } = deps("linux");
    const s = systemService(d);
    await s.ensure();
    calls.length = 0;
    expect(await s.remove()).toBe(true);
    expect(calls).toEqual([
      ["systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]],
      ["systemctl", ["--user", "daemon-reload"]],
    ]);
    expect(existsSync(unitOf(userHome))).toBe(false);
    expect(await s.remove()).toBe(false);
  });

  it("problems: lingering off, and a node path that is gone", async () => {
    const { d, userHome } = deps("linux", { execPath: process.execPath });
    const s = systemService(d);
    expect(s.problems?.()).toEqual([]);
    await s.ensure();
    expect(s.problems?.()).toEqual([{ kind: "linger-off" }]);
    mkdirSync(join(userHome, "linger"));
    writeFileSync(join(userHome, "linger/leo"), "");
    expect(s.problems?.()).toEqual([]);
    await systemService({ ...d, execPath: "/gone/node" }).ensure();
    expect(s.problems?.()).toEqual([
      { kind: "node-missing", node: "/gone/node" },
    ]);
  });
});

describe("systemService: no service manager", () => {
  it("runs the daemon in the background on other platforms", async () => {
    const { d, calls } = deps("freebsd");
    const s = systemService(d);
    await s.ensure();
    expect(calls).toEqual([]);
    expect(d.spawnDaemon).toHaveBeenCalledOnce();
    expect(s.kind).toBeUndefined();
    expect(await s.remove()).toBe(false);
  });
});

describe("tripwires", () => {
  it("the default exec refuses launchctl and systemctl under vitest", async () => {
    const exec = makeExec(1000);
    await expect(exec("launchctl", ["list"])).rejects.toThrow(/under vitest/);
    await expect(exec("/bin/systemctl", ["--user", "status"])).rejects.toThrow(
      /under vitest/,
    );
    await expect(realCtx(true).exec("launchctl", ["list"])).rejects.toThrow(
      /under vitest/,
    );
    expect(() => guardServiceManager("launchctl", {})).not.toThrow();
  });

  it("the real ctx's homes are the sentinel, whose service folders are checked", () => {
    const ctx = realCtx(true);
    expect(ctx.userHome).toBe(SENTINEL_HOME);
    expect(ctx.home).toBe(join(SENTINEL_HOME, ".openbus"));
    const dir = join(SENTINEL_HOME, "Library/LaunchAgents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "x.plist"), "");
    try {
      expect(serviceWrites()).toEqual(["Library/LaunchAgents/x.plist"]);
    } finally {
      rmSync(join(dir, "x.plist"));
    }
    expect(serviceWrites()).toEqual([]);
  });
});
