import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { daemon } from "../src/commands/daemon.ts";
import { doctor } from "../src/commands/doctor.ts";
import { logs } from "../src/commands/logs.ts";
import { MCP_ENTRY, mcp } from "../src/commands/mcp.ts";
import { status as statusCmd } from "../src/commands/status.ts";
import { uninstall } from "../src/commands/uninstall.ts";
import type { Ctx } from "../src/context.ts";
import { main } from "../src/main.ts";
import { installAdapters } from "../src/steps/adapters.ts";
import { purge } from "../src/steps/purge.ts";
import {
  type Fake,
  fakeCtx,
  HUB,
  LABEL,
  NS,
  status,
  TOKEN,
  transcript,
} from "./fake.ts";

function approve(ctx: Fake, mode = 0o600) {
  mkdirSync(ctx.home, { recursive: true });
  const file = join(ctx.home, "machine.json");
  writeFileSync(
    file,
    JSON.stringify({
      hub: HUB,
      machine_id: "m",
      label: LABEL,
      machine_token: TOKEN,
    }),
  );
  chmodSync(file, mode);
}
const up = (over = {}) => vi.fn(async () => status(over));
const noToken = (ctx: Fake) =>
  expect([...ctx.out(), ...ctx.err()].join("\n")).not.toContain(
    TOKEN.slice(11),
  );

const ALL = (c: string) => ["claude", "opencode", "pi"].includes(c);
const launchd = (removed = true) => ({
  kind: "launchd" as const,
  ensure: vi.fn(async () => {}),
  remove: vi.fn(async () => removed),
});
/** exec: `opencode --version` answers `version`; `claude mcp` fails so configs are files. */
const execWith = (version = "2.0.32", restart = 0) =>
  vi.fn(async (cmd: string, args: string[]) =>
    cmd === "opencode" && args[0] === "--version"
      ? { code: 0, stdout: `opencode v${version}\n`, stderr: "" }
      : cmd === "opencode" && args[0] === "service"
        ? { code: restart, stdout: "", stderr: restart ? "not running" : "" }
        : cmd === "claude"
          ? { code: 1, stdout: "", stderr: "no" }
          : { code: 0, stdout: "", stderr: "" },
  );
/** Wires every harness into the fake homes, as install would. */
async function wire(ctx: Fake, which = ALL) {
  await installAdapters({
    home: ctx.userHome,
    openbusHome: ctx.home,
    openBusBin: "/usr/local/bin/open-bus",
    assets: { pi: "P", opencodePlugin: "J" },
    which,
    exec: execWith(),
  });
}
const row = (
  name: string,
  kind: "claude-code" | "opencode" | "pi",
  machine = LABEL,
  state: "live" | "queued" = "live",
) => ({ name, kind, machine, state });

describe("status: transcript state 7", () => {
  const blocks = transcript("## 7. status");
  const healthy = status({
    namespaces: [
      {
        namespace: NS,
        agents: [
          row("openbus-platform", "claude-code", "leo-mac-mini", "queued"),
          row("openbus-design", "claude-code"),
          row("openbus-backend", "claude-code"),
        ],
      },
      {
        namespace: "github.com/leourbina/notes",
        agents: [row("notes-writer", "pi")],
      },
    ],
  });

  it("connected and healthy: rows, daemon, one roster per namespace; exit 0", async () => {
    const ctx = fakeCtx({
      service: launchd(),
      status: vi.fn(async () => healthy),
    });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(0);
    expect(ctx.all()).toEqual(blocks[0]);
    noToken(ctx);
  });

  it("hub not reachable: no roster rows; exit 1", async () => {
    const ctx = fakeCtx({
      service: launchd(),
      status: up({ hub: "connecting", hub_error: "ECONNREFUSED" }),
    });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.all()).toEqual(blocks[1]);
  });

  it("daemon not running; exit 1", async () => {
    const ctx = fakeCtx({ service: launchd() });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.all()).toEqual(blocks[2]);
  });

  it("not registered: no Hub or Machine rows; exit 1", async () => {
    const ctx = fakeCtx();
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.all()).toEqual(blocks[3]);
  });

  it("revoked: the daemon's marker; exit 1", async () => {
    const ctx = fakeCtx({ status: up() });
    approve(ctx);
    writeFileSync(join(ctx.home, "revoked"), "{}");
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.all()).toEqual(blocks[4]);
  });
});

describe("doctor: transcript state 8", () => {
  const blocks = transcript("## 8. doctor");
  const healthz = (ok: boolean) =>
    vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(`${HUB}/healthz`);
      if (!ok)
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNREFUSED" },
        });
      return new Response("ok");
    }) as unknown as typeof fetch;

  it("all 8 checks pass; exit 0; read-only", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v22.11.0",
      service: launchd(),
      status: up(),
      fetch: healthz(true),
      which: ALL,
      exec: execWith(),
    });
    approve(ctx);
    await wire(ctx);
    mkdirSync(join(ctx.userHome, ".claude"), { recursive: true });
    writeFileSync(
      join(ctx.userHome, ".claude/settings.json"),
      JSON.stringify({ isolatePeerMachines: false }),
    );
    const before = readdirSync(ctx.home);
    vi.mocked(ctx.exec).mockClear();
    expect(await doctor(ctx)).toBe(0);
    expect(ctx.all()).toEqual(blocks[0]);
    expect(readdirSync(ctx.home)).toEqual(before);
    for (const [cmd, args] of vi.mocked(ctx.exec).mock.calls)
      expect([cmd, ...args]).toEqual(["opencode", "--version"]);
    // Only the token's tail.
    expect(ctx.all().join("\n")).not.toContain(TOKEN.slice(11, 30));
  });

  it("a run with problems; exit 1 on any ×", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v22.11.0",
      fetch: healthz(false),
      which: ALL,
      exec: execWith("1.4.2"),
    });
    approve(ctx);
    await wire(ctx, (c) => c === "claude");
    expect(await doctor(ctx)).toBe(1);
    expect(ctx.all()).toEqual(blocks[1]);
  });

  it("each check's failure line", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v20.9.0",
      which: (c) => c === "opencode",
      exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "" })),
    });
    expect(await doctor(ctx)).toBe(1);
    expect(ctx.all()).toEqual([
      "open-bus 0.1.0",
      "",
      "[[danger]]×[[/danger]]  Node 20.9.0 is too old (needs 22 or newer)",
      "   Install Node 22 or newer, then run npx open-bus doctor again.",
      "[[danger]]×[[/danger]]  No credentials at ~/.openbus/machine.json",
      "   Run npx open-bus to approve this machine.",
      "[[danger]]×[[/danger]]  Daemon is not running",
      "   Run npx open-bus to restart it.",
      "[[warning]]![[/warning]]  OpenCode version unknown",
      "   Run opencode --version to check it, then npx open-bus install again.",
      "",
      "[[muted]]3 failed, 1 warning.[[/muted]]",
    ]);
  });

  it("revoked credentials, and Claude ignoring other machines", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v22.11.0",
      status: up(),
      fetch: healthz(true),
      which: (c) => c === "claude",
      exec: execWith(),
    });
    approve(ctx);
    writeFileSync(join(ctx.home, "revoked"), "{}");
    await wire(ctx, (c) => c === "claude");
    mkdirSync(join(ctx.userHome, ".claude"), { recursive: true });
    writeFileSync(
      join(ctx.userHome, ".claude/settings.json"),
      JSON.stringify({ isolatePeerMachines: true }),
    );
    expect(await doctor(ctx)).toBe(1);
    expect(ctx.all()).toEqual(
      expect.arrayContaining([
        "[[danger]]×[[/danger]]  This machine was revoked",
        "   Run npx open-bus login to approve it again.",
        "[[warning]]![[/warning]]  Claude Code ignores messages from other machines",
        "   Set isolatePeerMachines to false in ~/.claude/settings.json.",
      ]),
    );
    // No service: the daemon line is the second warning.
    expect(ctx.all().at(-1)).toBe(
      "[[muted]]1 failed, 2 warnings, 3 passed.[[/muted]]",
    );
  });

  it("a daemon with no service is a warning: exit 0", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v22.11.0",
      status: up(),
      fetch: healthz(true),
    });
    approve(ctx);
    expect(await doctor(ctx)).toBe(0);
    expect(ctx.all()).toEqual(
      expect.arrayContaining([
        "[[warning]]![[/warning]]  Daemon running, but no service will restart it after a reboot.",
        "   Run npx open-bus install.",
        "[[muted]]1 warning, 3 passed.[[/muted]]",
      ]),
    );
  });
});

describe("uninstall: transcript states 9 and 10", () => {
  async function installed(ctx: Fake) {
    approve(ctx);
    await wire(ctx);
    for (const f of [
      "install.json",
      "sent.json",
      "claude-held.json",
      "opencode-uncertain.json",
    ])
      writeFileSync(join(ctx.home, f), "{}");
    mkdirSync(join(ctx.home, "logs"));
    writeFileSync(join(ctx.home, "logs/daemon.log"), "x\n");
  }

  it("9: removes the service and the wiring, keeps the credentials; exit 0", async () => {
    const ctx = fakeCtx({ service: launchd(), which: ALL, exec: execWith() });
    await installed(ctx);
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(ctx.all()).toEqual(transcript("## 9. uninstall")[0]);
    expect(existsSync(join(ctx.home, "machine.json"))).toBe(true);
    expect(ctx.service.remove).toHaveBeenCalledOnce();
  });

  it("9: a second run has nothing to remove; exit 0", async () => {
    const ctx = fakeCtx({
      service: launchd(false),
      which: ALL,
      exec: execWith(),
    });
    approve(ctx);
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(ctx.all().slice(2, 4)).toEqual([
      "[[success]]✓[[/success]]  No service to remove",
      "[[success]]✓[[/success]]  No harness had OpenBus wired",
    ]);
  });

  it("9: only the OpenCode plugin folder was left: says so, never 'from OpenCode'", async () => {
    const ctx = fakeCtx({
      service: launchd(false),
      which: ALL,
      exec: execWith(),
    });
    approve(ctx);
    mkdirSync(join(ctx.home, "integrations/opencode/openbus"), {
      recursive: true,
    });
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(ctx.all().slice(2, 5)).toEqual([
      "[[success]]✓[[/success]]  No service to remove",
      "[[success]]✓[[/success]]  Removed the OpenCode plugin folder",
      "[[success]]✓[[/success]]  Restarted the OpenCode service to unload the plugin",
    ]);
  });

  it("9: OpenCode's service not running", async () => {
    const ctx = fakeCtx({
      service: launchd(),
      which: ALL,
      exec: execWith("2.0.32", 1),
    });
    await installed(ctx);
    await uninstall({ purge: false }, ctx);
    expect(ctx.all()[4]).toBe(
      "[[success]]✓[[/success]]  OpenCode service not running; nothing to restart",
    );
  });

  it("10: --purge deletes ~/.openbus and names the machine to revoke; exit 0", async () => {
    const ctx = fakeCtx({ service: launchd(), which: ALL, exec: execWith() });
    await installed(ctx);
    expect(await uninstall({ purge: true }, ctx)).toBe(0);
    expect(ctx.all()).toEqual(transcript("## 10. uninstall --purge")[0]);
    expect(existsSync(ctx.home)).toBe(false);
  });

  it("10: --purge refuses an OPENBUS_HOME that is not OpenBus's (DRAFT copy)", async () => {
    const userHome = mkdtempSync(join(tmpdir(), "ob-cli-home-"));
    const ctx = fakeCtx({ userHome, home: join(userHome, "work") });
    mkdirSync(join(ctx.home, "logs"), { recursive: true });
    writeFileSync(join(ctx.home, "logs/daemon.log"), "theirs");
    expect(await uninstall({ purge: true }, ctx)).toBe(1);
    expect(ctx.all()).toEqual(transcript("## 10. uninstall --purge")[2]);
    expect(existsSync(join(ctx.home, "logs/daemon.log"))).toBe(true);
  });

  it("10: --purge keeps ~/.openbus while the daemon still answers; exit 1", async () => {
    const ctx = fakeCtx({
      service: launchd(),
      which: ALL,
      exec: execWith(),
      status: up(),
    });
    await installed(ctx);
    expect(await uninstall({ purge: true }, ctx)).toBe(1);
    expect(ctx.all()).toEqual(transcript("## 10. uninstall --purge")[1]);
    expect(existsSync(join(ctx.home, "machine.json"))).toBe(true);
  });
});

describe("purge safety", () => {
  const shared = { isDefault: false };
  const own = { isDefault: true };

  it("never removes what OpenBus did not create, so a shared OPENBUS_HOME survives", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    writeFileSync(join(home, "machine.json"), "{}");
    writeFileSync(join(home, "notes.txt"), "mine");
    mkdirSync(join(home, "projects"));
    writeFileSync(join(home, "projects/a"), "mine");
    // A known file name that is someone's directory is left alone.
    mkdirSync(join(home, "sent.json"));
    writeFileSync(join(home, "sent.json/x"), "mine");
    const out = purge(home, shared);
    expect(out).toMatchObject({ leftDir: true });
    expect(readdirSync(home).sort()).toEqual([
      "notes.txt",
      "projects",
      "sent.json",
    ]);
  });

  it("keeps the user's own logs/ and config.json in a shared folder", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    mkdirSync(join(home, "logs"));
    writeFileSync(join(home, "logs/my-app.log"), "user data\n");
    writeFileSync(join(home, "logs/daemon.log"), "ours\n");
    mkdirSync(join(home, "integrations/opencode/openbus"), { recursive: true });
    writeFileSync(join(home, "integrations/opencode/openbus/tui.js"), "ours");
    mkdirSync(join(home, "integrations/other"));
    writeFileSync(join(home, "config.json"), '{"mine":true}\n');
    writeFileSync(join(home, "machine.json"), "{}\n");
    purge(home, shared);
    expect(existsSync(join(home, "machine.json"))).toBe(false);
    expect(existsSync(join(home, "logs/daemon.log"))).toBe(false);
    expect(existsSync(join(home, "logs/my-app.log"))).toBe(true);
    expect(existsSync(join(home, "config.json"))).toBe(true);
    expect(existsSync(join(home, "integrations/opencode"))).toBe(false);
    expect(existsSync(join(home, "integrations/other"))).toBe(true);
  });

  it("removes OpenBus's folders once they are empty, then the home", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    writeFileSync(join(home, "machine.json"), "{}");
    mkdirSync(join(home, "logs"));
    writeFileSync(join(home, "logs/daemon.log"), "x");
    mkdirSync(join(home, "integrations/opencode/openbus"), { recursive: true });
    mkdirSync(join(home, "opencode-tui"));
    writeFileSync(join(home, "opencode-tui/4321.json"), "{}");
    mkdirSync(join(home, "claude-return"));
    expect(purge(home, own)).toMatchObject({ leftDir: false });
    expect(existsSync(home)).toBe(false);
  });

  it("refuses a home that is not ~/.openbus and holds no machine.json or install.json", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    mkdirSync(join(home, "logs"));
    writeFileSync(join(home, "logs/daemon.log"), "maybe someone else's");
    expect(purge(home, shared)).toEqual({ refused: true });
    expect(existsSync(join(home, "logs/daemon.log"))).toBe(true);
  });

  it("leaves a symlinked folder and its target alone", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "ob-else-"));
    writeFileSync(join(elsewhere, "daemon.log"), "x");
    symlinkSync(elsewhere, join(home, "logs"));
    writeFileSync(join(home, "install.json"), "{}");
    expect(purge(home, own)).toMatchObject({ leftDir: true });
    expect(readdirSync(elsewhere)).toEqual(["daemon.log"]);
  });

  it("removes interrupted temp files and a missing home is fine", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    writeFileSync(join(home, ".machine.json.0a1b.tmp"), "");
    writeFileSync(join(home, "sent.json.123.tmp"), "");
    expect(purge(home, own)).toMatchObject({ leftDir: false });
    expect(purge(join(home, "gone"), own)).toEqual({
      removed: [],
      leftDir: false,
    });
  });
});

describe("logs, mcp, version", () => {
  it("logs prints the last 50 lines, or says there is none yet", async () => {
    const a = fakeCtx();
    expect(await logs(a)).toBe(1);
    expect(a.out()[0]).toBe(
      "[[warning]]![[/warning]]  No daemon log yet at ~/.openbus/logs/daemon.log",
    );
    const b = fakeCtx();
    mkdirSync(join(b.home, "logs"), { recursive: true });
    writeFileSync(
      join(b.home, "logs/daemon.log"),
      `${Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n")}\n`,
    );
    expect(await logs(b)).toBe(0);
    expect(b.out()).toHaveLength(50);
    expect(b.out()[0]).toBe("l10");
  });

  it("mcp runs the adapter entry, and explains Pi", async () => {
    const load = vi.fn(async () => ({}));
    expect(await mcp("claude", fakeCtx(), load)).toBeUndefined();
    expect(await mcp("opencode", fakeCtx(), load)).toBeUndefined();
    expect(load.mock.calls).toEqual([[MCP_ENTRY.claude], [MCP_ENTRY.opencode]]);
    const pi = fakeCtx();
    expect(await mcp("pi", pi, load)).toBe(1);
    expect(pi.out()[0]).toMatch(/Pi uses the OpenBus extension/);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("the mcp entries resolve to the adapters' main modules", () => {
    for (const m of Object.values(MCP_ENTRY))
      expect(import.meta.resolve(m)).toMatch(/\/src\/main\.ts$/);
  });

  it("main: version, and a usage error exits 2", async () => {
    const ctx = fakeCtx();
    expect(await main(["version"], () => ctx)).toBe(0);
    expect(await main(["-v"], () => ctx)).toBe(0);
    expect(ctx.out()).toEqual(["open-bus 0.1.0", "open-bus 0.1.0"]);
    const bad = fakeCtx();
    expect(await main(["wat"], () => bad)).toBe(2);
    expect(bad.err()[0]).toBe("[[danger]]×[[/danger]]  unknown command: wat");
  });

  it("main passes --no-color to the context", async () => {
    const seen: boolean[] = [];
    await main(["version", "--no-color"], (n) => {
      seen.push(n);
      return fakeCtx();
    });
    expect(seen).toEqual([true]);
  });
});

describe("daemon command", () => {
  const fake = () => {
    const signals = new EventEmitter() as unknown as Parameters<
      typeof daemon
    >[2] &
      EventEmitter;
    const stop = vi.fn(async () => {});
    let deps: { onRevoked?: () => void } = {};
    const run = vi.fn(async (d: { onRevoked?: () => void }) => {
      deps = d;
      return { stop } as unknown as Awaited<
        ReturnType<Parameters<typeof daemon>[1] & {}>
      >;
    });
    return { signals, stop, run, revoke: () => deps.onRevoked?.() };
  };

  it("stays in the foreground and exits 0 on SIGTERM", async () => {
    const f = fake();
    const done = daemon(fakeCtx(), f.run as never, f.signals);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    f.signals.emit("SIGTERM");
    expect(await done).toBe(0);
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("exits 1, once, when the machine is revoked", async () => {
    const f = fake();
    const done = daemon(fakeCtx(), f.run as never, f.signals);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    f.revoke();
    f.revoke();
    f.signals.emit("SIGINT");
    expect(await done).toBe(1);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.signals.listenerCount("SIGINT")).toBe(0);
  });

  it("exits 1 with the reason when it cannot start", async () => {
    const ctx: Ctx = fakeCtx();
    const code = await daemon(
      ctx,
      async () => {
        throw new Error("not logged in: run `open-bus login`");
      },
      new EventEmitter() as never,
    );
    expect(code).toBe(1);
    expect((ctx as Fake).err()[0]).toBe(
      "[[danger]]×[[/danger]]  not logged in: run `open-bus login`",
    );
  });
});
