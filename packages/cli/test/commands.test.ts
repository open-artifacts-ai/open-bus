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
import { purge } from "../src/steps/purge.ts";
import { type Fake, fakeCtx, HUB, LABEL, status, TOKEN } from "./fake.ts";

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

describe("status (DRAFT copy)", () => {
  it("prints the machine, the daemon, the hub link and the roster", async () => {
    const ctx = fakeCtx({
      status: up({
        agents: [{ name: "openbus-e0", kind: "opencode", live: true }],
      }),
    });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(0);
    expect(ctx.out()).toEqual([
      "open-bus 0.1.0",
      "",
      "[[success]]✓[[/success]]  Connected as leo-macbook-pro to bus.example.com",
      "[[success]]✓[[/success]]  Daemon running  [[muted]]pid 48213[[/muted]]",
      "[[success]]✓[[/success]]  Hub connected",
      "",
      "1 agent in namespace [[accent]]github.com/open-artifacts-ai/open-bus[[/accent]]  [[muted]]1 live[[/muted]]",
      "  openbus-e0          OpenCode     leo-macbook-pro       [[success]]● live[[/success]]",
    ]);
    expect(ctx.status).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/work/open-bus" }),
    );
    noToken(ctx);
  });

  it("not connected, daemon down, hub not reachable", async () => {
    const a = fakeCtx();
    expect(await statusCmd(a)).toBe(1);
    expect(a.err()).toEqual([
      "[[danger]]×[[/danger]]  This machine is not connected.",
      "   Run npx open-bus to approve it.",
    ]);
    const b = fakeCtx();
    approve(b);
    expect(await statusCmd(b)).toBe(1);
    expect(b.err()).toEqual([
      "[[danger]]×[[/danger]]  The daemon is not running.",
      "   Run npx open-bus doctor to see why.",
    ]);
    const c = fakeCtx({ status: up({ hub: "connecting" }) });
    approve(c);
    expect(await statusCmd(c)).toBe(0);
    expect(c.out()).toContain(
      "[[warning]]![[/warning]]  The daemon cannot reach the hub yet; it keeps retrying.",
    );
  });
});

describe("doctor (DRAFT copy)", () => {
  const opencode = (version: string) =>
    vi.fn(async (cmd: string, args: string[]) =>
      cmd === "opencode" && args[0] === "--version"
        ? { code: 0, stdout: `opencode v${version}`, stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );

  it("is read-only and never prints the token", async () => {
    const ctx = fakeCtx({
      status: up(),
      which: (c) => c !== "pi",
      exec: opencode("2.0.32"),
    });
    approve(ctx);
    writeFileSync(
      join(ctx.userHome, ".claude.json"),
      JSON.stringify({ mcpServers: { openbus: { command: "x" } } }),
    );
    const before = readdirSync(ctx.home);
    expect(await doctor(ctx)).toBe(1);
    expect(ctx.out()).toEqual([
      "open-bus 0.1.0",
      "",
      "[[success]]✓[[/success]]  Connected as leo-macbook-pro to bus.example.com",
      "[[success]]✓[[/success]]  Daemon running  [[muted]]pid 48213[[/muted]]",
      "[[success]]✓[[/success]]  Claude Code configured",
      "[[warning]]![[/warning]]  OpenCode is installed but not configured.",
      "   Run npx open-bus to configure it.",
      "   [[muted]]Pi not found[[/muted]]",
      "",
      "[[muted]]open-bus 0.1.0 · node v24.0.0 · darwin arm64 · ~/.openbus[[/muted]]",
    ]);
    expect(readdirSync(ctx.home)).toEqual(before);
    // Only `opencode --version`: nothing that changes a harness.
    for (const [cmd, args] of vi.mocked(ctx.exec).mock.calls)
      expect([cmd, ...args]).toEqual(["opencode", "--version"]);
    noToken(ctx);
  });

  it("prints the upgrade line below OpenCode 2.0.0", async () => {
    const ctx = fakeCtx({
      status: up(),
      which: (c) => c === "opencode",
      exec: opencode("1.9.4"),
    });
    approve(ctx);
    await doctor(ctx);
    expect(ctx.out()).toEqual(
      expect.arrayContaining([
        "[[warning]]![[/warning]]  OpenCode 1.9.4 is older than 2.0.0, so OpenBus skipped it.",
        "   Upgrade OpenCode, then run npx open-bus again.",
      ]),
    );
  });

  it("flags an open machine.json, a silent daemon and no machine", async () => {
    const a = fakeCtx();
    approve(a, 0o644);
    expect(await doctor(a)).toBe(1);
    expect(a.out()).toEqual(
      expect.arrayContaining([
        "[[warning]]![[/warning]]  ~/.openbus/machine.json is readable by other users.",
        "   Run chmod 600 ~/.openbus/machine.json.",
        "[[warning]]![[/warning]]  The daemon is not answering on ~/.openbus/daemon.sock.",
        "   Run npx open-bus daemon to start it in this terminal.",
      ]),
    );
    const b = fakeCtx({ status: up() });
    await doctor(b);
    expect(b.out()).toContain(
      "[[warning]]![[/warning]]  This machine is not connected.",
    );
    expect(existsSync(b.home)).toBe(false);
  });

  it("all good", async () => {
    const ctx = fakeCtx({ status: up() });
    approve(ctx);
    expect(await doctor(ctx)).toBe(0);
    expect(ctx.out()).toContain("[[success]]✓[[/success]]  No problems found.");
  });
});

describe("uninstall (DRAFT copy)", () => {
  function installed(ctx: Fake) {
    approve(ctx);
    writeFileSync(
      join(ctx.userHome, ".claude.json"),
      JSON.stringify({
        theme: "dark",
        mcpServers: { openbus: { command: "x" } },
      }),
    );
    for (const f of [
      "install.json",
      "sent.json",
      "claude-held.json",
      "opencode-uncertain.json",
    ])
      writeFileSync(join(ctx.home, f), "{}");
    mkdirSync(join(ctx.home, "integrations/opencode/openbus"), {
      recursive: true,
    });
    mkdirSync(join(ctx.home, "logs"));
    writeFileSync(join(ctx.home, "logs/daemon.log"), "x\n");
  }

  it("removes the harness entries and keeps ~/.openbus", async () => {
    const ctx = fakeCtx({
      which: (c) => c === "claude",
      exec: vi.fn(async () => ({ code: 1, stdout: "", stderr: "no claude" })),
    });
    installed(ctx);
    expect(await uninstall({ purge: false }, ctx)).toBe(0);
    expect(ctx.out()).toEqual([
      "open-bus 0.1.0",
      "",
      // Uninstall works from the files: the plugin folder counts as OpenCode.
      "[[success]]✓[[/success]]  Removed OpenBus from Claude Code and OpenCode",
      "[[success]]✓[[/success]]  Kept ~/.openbus, so this machine stays approved.",
      "   [[muted]]Run npx open-bus uninstall --purge to remove it too.[[/muted]]",
    ]);
    expect(existsSync(join(ctx.home, "machine.json"))).toBe(true);
  });

  it("--purge removes OpenBus's files and the directory once empty", async () => {
    const ctx = fakeCtx();
    installed(ctx);
    expect(await uninstall({ purge: true }, ctx)).toBe(0);
    expect(ctx.out().slice(2)).toEqual([
      "[[success]]✓[[/success]]  Removed OpenBus from Claude Code and OpenCode",
      "[[success]]✓[[/success]]  Removed this machine's token and files from ~/.openbus",
      "   [[muted]]The hub lists this machine until you revoke it on the dashboard.[[/muted]]",
    ]);
    expect(existsSync(ctx.home)).toBe(false);
  });

  it("--purge refuses while the daemon still answers", async () => {
    const ctx = fakeCtx({ status: up() });
    installed(ctx);
    expect(await uninstall({ purge: true }, ctx)).toBe(1);
    expect(ctx.err()).toEqual([
      "[[danger]]×[[/danger]]  The daemon is still running.  [[muted]]pid 48213[[/muted]]",
      "   Stop it, then run npx open-bus uninstall --purge again.",
    ]);
    expect(existsSync(join(ctx.home, "machine.json"))).toBe(true);
  });

  it("stops and removes the service when there is one", async () => {
    const service = {
      kind: "launchd" as const,
      ensure: vi.fn(),
      remove: vi.fn(async () => {}),
    };
    const ctx = fakeCtx({ service });
    await uninstall({ purge: false }, ctx);
    expect(ctx.out()[2]).toBe(
      "[[success]]✓[[/success]]  Nothing to remove from Claude Code, OpenCode or Pi",
    );
    expect(service.remove).toHaveBeenCalledOnce();
    expect(ctx.out()).toContain(
      "[[success]]✓[[/success]]  Stopped and removed the daemon service",
    );
  });
});

describe("purge safety", () => {
  it("never removes what OpenBus did not create, so a shared OPENBUS_HOME survives", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    writeFileSync(join(home, "machine.json"), "{}");
    writeFileSync(join(home, "notes.txt"), "mine");
    mkdirSync(join(home, "projects"));
    writeFileSync(join(home, "projects/a"), "mine");
    // A known file name that is someone's directory is left alone.
    mkdirSync(join(home, "sent.json"));
    writeFileSync(join(home, "sent.json/x"), "mine");
    const out = purge(home);
    expect(out.leftDir).toBe(true);
    expect(readdirSync(home).sort()).toEqual([
      "notes.txt",
      "projects",
      "sent.json",
    ]);
  });

  it("removes a symlinked store without following it", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "ob-else-"));
    writeFileSync(join(elsewhere, "keep"), "x");
    symlinkSync(elsewhere, join(home, "logs"));
    symlinkSync(join(elsewhere, "keep"), join(home, "install.json"));
    purge(home);
    expect(existsSync(home)).toBe(false);
    expect(readdirSync(elsewhere)).toEqual(["keep"]);
  });

  it("removes interrupted temp files and a missing home is fine", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-purge-"));
    writeFileSync(join(home, ".machine.json.0a1b.tmp"), "");
    writeFileSync(join(home, "sent.json.123.tmp"), "");
    expect(purge(home).leftDir).toBe(false);
    expect(purge(join(home, "gone"))).toEqual({ removed: [], leftDir: false });
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
