import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { install } from "../src/commands/install.ts";
import { status as statusCmd } from "../src/commands/status.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import {
  LAUNCHD_LABEL,
  type ServiceDeps,
  systemService,
} from "../src/steps/service.ts";
import { type Fake, fakeCtx, HUB, LABEL, status, TOKEN } from "./fake.ts";

/** The real service on a fake ctx: exec, home and the daemon are all fakes. */
function withService(
  platform: NodeJS.Platform,
  fail: (cmd: string, args: string[]) => boolean = () => false,
  over: Partial<ServiceDeps> = {},
) {
  const calls: string[] = [];
  let up = false;
  const dist = mkdtempSync(join(tmpdir(), "ob-dist-"));
  writeFileSync(join(dist, "open-bus.js"), "// bundle");
  const ctx: Fake = fakeCtx({
    exec: vi.fn(async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (fail(cmd, args)) return { code: 1, stdout: "", stderr: "no bus" };
      // The service manager starting the daemon.
      if (args[0] === "bootstrap" || args[1] === "restart") up = true;
      if (args[0] === "bootout" || args[1] === "disable") up = false;
      return { code: 0, stdout: "", stderr: "" };
    }),
    status: vi.fn(async () => {
      if (!up) throw new Error("ECONNREFUSED");
      return status();
    }),
  });
  const spawnDaemon = vi.fn(() => {
    up = true;
  });
  ctx.service = systemService({
    platform,
    userHome: ctx.userHome,
    home: () => ctx.home,
    env: { PATH: "/usr/bin" },
    exec: ctx.exec,
    sleep: ctx.sleep,
    execPath: process.execPath,
    uid: 501,
    user: "leo",
    lingerDir: join(ctx.userHome, "linger"),
    source: () => ({ kind: "bundle", file: join(dist, "open-bus.js") }),
    daemonPid: async () => (up ? 48213 : undefined),
    kill: vi.fn(() => {
      up = false;
    }),
    spawnDaemon,
    ...over,
  });
  mkdirSync(ctx.home, { recursive: true });
  writeFileSync(
    join(ctx.home, "machine.json"),
    JSON.stringify({
      hub: HUB,
      machine_id: "m",
      label: LABEL,
      machine_token: TOKEN,
    }),
    { mode: 0o600 },
  );
  return { ctx, calls, spawnDaemon, isUp: () => up };
}

const plistOf = (ctx: Fake) =>
  join(ctx.userHome, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const RUNNING_LAUNCHD =
  "[[success]]✓[[/success]]  Daemon running as a launchd service  [[muted]]pid 48213[[/muted]]";
const NO_SERVICE = [
  "[[warning]]![[/warning]]  Daemon running, but no service will restart it after a reboot.",
  "   Run npx open-bus install.",
];

const FALLBACK = [
  "[[warning]]![[/warning]]  Daemon running without a service; it will not restart after a reboot.",
  "   After a reboot, start it with npx open-bus daemon.",
];

describe("install through the service", () => {
  it("starts the launchd service, then prints Daemon running once the socket answers", async () => {
    const { ctx, calls } = withService("darwin");
    expect(await install({ hub: HUB }, ctx)).toBe(0);
    expect(calls).toContain(`launchctl bootstrap gui/501 ${plistOf(ctx)}`);
    expect(existsSync(join(ctx.home, "bin/open-bus.js"))).toBe(true);
    expect(ctx.out()).toContain(RUNNING_LAUNCHD);
    expect(ctx.out()).not.toContain(NO_SERVICE[0]);
  });

  it("points the MCP entries at the stable copy, run by this node", async () => {
    const { ctx, calls } = withService("darwin");
    // Neither OPENBUS_BIN nor argv[1]: both may be an npx cache path.
    ctx.env = { OPENBUS_BIN: "/tmp/_npx/open-bus" };
    ctx.which = (c) => c === "opencode" || c === "claude";
    const exec = ctx.exec;
    ctx.exec = vi.fn(async (cmd: string, args: string[]) =>
      cmd === "opencode" && args[0] === "--version"
        ? { code: 0, stdout: "opencode v2.0.32\n", stderr: "" }
        : exec(cmd, args),
    );
    expect(await install({ hub: HUB }, ctx)).toBe(0);
    const entry = join(ctx.home, "bin/open-bus.js");
    const oc = JSON.parse(
      readFileSync(
        join(ctx.userHome, ".config/opencode/opencode.json"),
        "utf8",
      ),
    );
    expect(oc.mcp.servers.openbus.command).toEqual([
      process.execPath,
      entry,
      "mcp",
      "opencode",
    ]);
    expect(existsSync(entry)).toBe(true);
    expect(calls).toContain(
      `claude mcp add --scope user openbus -- ${process.execPath} ${entry} mcp claude`,
    );
  });

  it("systemd: names the user service", async () => {
    const { ctx } = withService("linux");
    expect(await install({ hub: HUB }, ctx)).toBe(0);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  Daemon running as a systemd user service  [[muted]]pid 48213[[/muted]]",
    );
  });

  it("no systemd user session: runs the daemon itself, and says how to start it after a reboot", async () => {
    const { ctx, spawnDaemon } = withService("linux", (c) => c === "systemctl");
    expect(await install({ hub: HUB }, ctx)).toBe(0);
    expect(spawnDaemon).toHaveBeenCalledOnce();
    // Not "Run npx open-bus install": install just ran, and fell back.
    expect(ctx.out()).toEqual(expect.arrayContaining(FALLBACK));
    expect(ctx.out()).not.toContain(NO_SERVICE[1]);
    // status says the same thing afterwards.
    expect(await statusCmd(ctx)).toBe(0);
    expect(ctx.out().filter((l) => l === FALLBACK[1])).toHaveLength(2);
  });

  it("a service that never answers is the 10 s failure", async () => {
    // Neither launchd nor the fallback daemon ever answers.
    const { ctx } = withService("darwin", (_c, a) => a[0] === "bootstrap", {
      daemonPid: async () => undefined,
      spawnDaemon: () => {},
    });
    expect(await install({ hub: HUB }, ctx)).toBe(1);
    expect(ctx.err()[0]).toBe(
      "[[danger]]×[[/danger]]  The daemon did not start within 10 seconds.",
    );
  });
});

describe("status and doctor report the service", () => {
  it("status: the no-service line only while no service is installed", async () => {
    const a = withService("darwin", () => false);
    a.ctx.status = vi.fn(async () => status());
    expect(await statusCmd(a.ctx)).toBe(0);
    expect(a.ctx.out()).toEqual(expect.arrayContaining(NO_SERVICE));

    const b = withService("darwin");
    await b.ctx.service.ensure();
    expect(await statusCmd(b.ctx)).toBe(0);
    expect(b.ctx.out()).toContain(RUNNING_LAUNCHD);
    expect(b.ctx.out()).not.toContain(NO_SERVICE[0]);
  });

  it("doctor: the service passes; lingering off and a gone node are warnings", async () => {
    const { ctx } = withService("linux", () => false, {
      execPath: "/gone/node",
    });
    ctx.fetch = vi.fn(async () => new Response("ok")) as never;
    await ctx.service.ensure();
    expect(await doctor(ctx)).toBe(0);
    expect(ctx.out()).toEqual(
      expect.arrayContaining([
        "[[success]]✓[[/success]]  Daemon running as a systemd user service  [[muted]]pid 48213[[/muted]]",
        "[[warning]]![[/warning]]  The service's Node is gone: /gone/node",
        "   Run npx open-bus install to point it at this Node.",
        "[[warning]]![[/warning]]  Lingering is off: the daemon stops when you log out",
        "   Run loginctl enable-linger, then npx open-bus doctor again.",
        "[[muted]]2 warnings, 4 passed.[[/muted]]",
      ]),
    );
    expect(ctx.out()).not.toContain(NO_SERVICE[0]);
  });
});

describe("uninstall through the service", () => {
  it("stops the service and removes the plist; the second run has none", async () => {
    const { ctx, calls, isUp } = withService("darwin");
    await ctx.service.ensure();
    expect(isUp()).toBe(true);
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(calls.at(-1)).toBe(`launchctl bootout gui/501/${LAUNCHD_LABEL}`);
    expect(existsSync(plistOf(ctx))).toBe(false);
    expect(isUp()).toBe(false);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  Stopped and removed the launchd service",
    );
    const again = await uninstall({ purge: false }, ctx);
    expect(again).toBe(0);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  No service to remove",
    );
  });

  it("stops the fallback's daemon", async () => {
    const { ctx, isUp } = withService("linux", (c) => c === "systemctl");
    await ctx.service.ensure();
    expect(isUp()).toBe(true);
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(isUp()).toBe(false);
    expect(ctx.out()).toContain("[[success]]✓[[/success]]  Stopped the daemon");
  });

  it("--purge after the stop removes <home>/bin too", async () => {
    const { ctx } = withService("linux");
    await ctx.service.ensure();
    expect(await uninstall({ purge: true }, ctx)).toBe(0);
    expect(existsSync(join(ctx.home, "bin"))).toBe(false);
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  Stopped and removed the systemd user service",
    );
  });
});
