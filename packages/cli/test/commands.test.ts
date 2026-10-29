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
import { revokedMarker, StartError } from "@ob/daemon";
import { newMachineToken } from "@ob/shared";
import { describe, expect, it, vi } from "vitest";
import { daemon } from "../src/commands/daemon.ts";
import { doctor } from "../src/commands/doctor.ts";
import { logs } from "../src/commands/logs.ts";
import { mcp } from "../src/commands/mcp.ts";
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
  ensure: vi.fn(async () => ({})),
  remove: vi.fn(async () => (removed ? { unit: "launchd" as const } : {})),
  cli: () => ["open-bus"],
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
    openBusBin: ["/usr/local/bin/open-bus"],
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
    expect(ctx.all()[2]).toBe(
      "Hub      bus.example.com  [[success]]● connected[[/success]]",
    );
    noToken(ctx);
  });

  it("hub not reachable: no roster rows; exit 1", async () => {
    const ctx = fakeCtx({
      service: launchd(),
      status: up({
        hub: "connecting",
        hub_error: "ECONNREFUSED",
        hub_ever: true,
        hub_since: 1_000_000 - 120_000,
      }),
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

  it("names machine.json's hub, not OPENBUS_HUB", async () => {
    const ctx = fakeCtx({ env: { OPENBUS_HUB: "https://other.example.org" } });
    approve(ctx);
    await statusCmd(ctx);
    expect(ctx.all()[2]).toBe("Hub      bus.example.com");
  });

  describe("hub link state (C20)", () => {
    const hubRow = async (over: Parameters<typeof status>[0], ctxOver = {}) => {
      const ctx = fakeCtx({ status: up(over), ...ctxOver });
      approve(ctx);
      await statusCmd(ctx);
      return ctx.all()[2];
    };
    const down = (agoMs: number) => ({
      hub: "connecting" as const,
      hub_ever: true,
      hub_since: 1_000_000 - agoMs,
    });
    const R = "Hub      bus.example.com  [[warning]]○ reconnecting[[/warning]]";
    it("reconnecting under 1 min has no duration", async () => {
      expect(await hubRow(down(59_999))).toBe(R);
    });
    it("reconnecting 2 min", async () => {
      expect(await hubRow(down(2 * 60_000 + 30_000))).toBe(
        `${R}  [[muted]]for 2 min[[/muted]]`,
      );
    });
    it("reconnecting 61 min reads 1 h", async () => {
      expect(await hubRow(down(61 * 60_000))).toBe(
        `${R}  [[muted]]for 1 h[[/muted]]`,
      );
    });
    it("pins the 59 min and 60 min boundaries", async () => {
      expect(await hubRow(down(59 * 60_000 + 59_000))).toBe(
        `${R}  [[muted]]for 59 min[[/muted]]`,
      );
      expect(await hubRow(down(60 * 60_000))).toBe(
        `${R}  [[muted]]for 1 h[[/muted]]`,
      );
    });
    it("connecting: never connected since the daemon started", async () => {
      expect(await hubRow({ hub: "connecting", hub_ever: false })).toBe(
        "Hub      bus.example.com  [[warning]]○ connecting[[/warning]]",
      );
    });
    it("an older daemon without the fields: connected, or connecting with no duration", async () => {
      expect(await hubRow({})).toContain("● connected");
      expect(await hubRow({ hub: "connecting" })).toBe(
        "Hub      bus.example.com  [[warning]]○ connecting[[/warning]]",
      );
    });
    it("a long host is cut so the row is at most 80", async () => {
      const ctx = fakeCtx({ status: up(down(2 * 60_000)) });
      approve(ctx);
      writeFileSync(
        join(ctx.home, "machine.json"),
        JSON.stringify({
          machine_id: "m",
          label: LABEL,
          machine_token: TOKEN,
          hub: `https://${"a".repeat(30)}.${"b".repeat(60)}.example.com`,
        }),
      );
      await statusCmd(ctx);
      const line = ctx.all()[2] ?? "";
      expect(line).toContain("…");
      expect(line).toContain("reconnecting");
      expect(line.replace(/\[\[\/?\w+\]\]/g, "").length).toBeLessThanOrEqual(
        80,
      );
    });
  });

  describe("late deliveries (C17)", () => {
    const Q = "Can you regenerate the API reference pag…";
    const late = (from: string, to: string, agoMs: number, excerpt = Q) => ({
      from,
      to,
      ...(excerpt ? { excerpt } : {}),
      at: 1_000_000 - agoMs,
    });
    const run = async (l: ReturnType<typeof late>[]) => {
      const ctx = fakeCtx({
        service: launchd(),
        status: vi.fn(async () => ({ ...healthy, late: l })),
      });
      approve(ctx);
      const code = await statusCmd(ctx);
      return { code, out: ctx.all(), base: blocks[0] as string[] };
    };

    it("follows the last table and its footnote, newest first; exit unaffected", async () => {
      const { code, out, base } = await run([
        late(
          "openbus-design",
          "openbus-frontend",
          14 * 60_000,
          "The Machines page empty state is ready f…",
        ),
        late("openbus-backend", "openbus-e0", 2 * 60_000),
      ]);
      expect(code).toBe(0);
      expect(out.slice(0, base.length)).toEqual(base);
      const section = out.slice(base.length);
      expect(section[0]).toBe("");
      expect(section.slice(1)).toEqual(blocks[5]);
    });

    it("singular, and a row with no excerpt has no quote line", async () => {
      const { out, base } = await run([late("a", "b", 10_000, "")]);
      expect(out.slice(base.length)).toEqual([
        "",
        "1 message delivered late  [[muted]]last hour[[/muted]]",
        "  a to b  [[muted]]now[[/muted]]",
      ]);
    });

    it("is absent at 0", async () => {
      expect((await run([])).out).toEqual(blocks[0]);
    });

    it("cuts long names so no row passes 80 columns", async () => {
      const untag = (l: string) => l.replace(/\[\[\/?[a-z]+\]\]/g, "");
      for (const [from, to] of [
        ["f".repeat(64), "t".repeat(64)],
        ["short", "t".repeat(128)],
        ["f".repeat(128), "x"],
      ]) {
        const { out, base } = await run([late(from, to, 59 * 60_000)]);
        for (const line of out.slice(base.length))
          expect(untag(line).length).toBeLessThanOrEqual(80);
        const row = untag(out[base.length + 2] as string);
        expect(row).toHaveLength(80);
        expect(row).toContain(" to ");
      }
    });

    it("strips terminal controls from the quote", async () => {
      const { out } = await run([late("a", "b", 0, "hi\x1b]52;c;x\x07 there")]);
      expect(out.at(-1)).toBe('    "hi there"');
    });
  });

  it("revoked: the daemon's marker; exit 1", async () => {
    const ctx = fakeCtx({ status: up() });
    approve(ctx);
    writeFileSync(join(ctx.home, "revoked"), "{}");
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.all()).toEqual(blocks[4]);
  });
});

describe("status and doctor: update available and unknown kinds (C26h)", () => {
  const draft = transcript("## 7. status").at(-1) as string[];
  const run = async (hub_version?: string, version = "0.46.3") => {
    const ctx = fakeCtx({
      service: launchd(),
      status: up({ version, ...(hub_version ? { hub_version } : {}) }),
    });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(0);
    return ctx.all();
  };
  const down = {
    hub: "connecting" as const,
    hub_ever: true,
    hub_error: "ECONNREFUSED",
    version: "0.46.3",
    hub_version: "0.47.0",
  };

  it("says so when the hub is newer, as the transcript shows", async () => {
    const out = await run("0.47.0");
    const at = out.indexOf(draft[0] as string);
    expect(out.slice(at, at + 3)).toEqual(draft);
    expect(await run("1.0.0", "0.46.3-rc.1")).toContain(
      "[[warning]]![[/warning]]  Update available: 1.0.0 (this machine runs 0.46.3-rc.1)",
    );
  });

  it("compares and shows the core version only", async () => {
    expect(await run("0.47.0-abc1234")).toContain(
      "[[warning]]![[/warning]]  Update available: 0.47.0 (this machine runs 0.46.3)",
    );
    expect(await run("0.47.0+build.7")).toContain(
      "[[warning]]![[/warning]]  Update available: 0.47.0 (this machine runs 0.46.3)",
    );
    // A pre-release of the same core is never newer, on either side.
    for (const [hub, mine] of [
      ["0.47.0", "0.47.0-rc.1"],
      ["0.47.0-abc1234", "0.47.0-rc.1"],
      ["0.47.0-abc1234", "0.47.0"],
    ])
      expect((await run(hub, mine)).join("\n")).not.toContain(
        "Update available",
      );
  });

  it("stays within 80 columns at its longest", async () => {
    const out = await run(
      "1234567890123.1234567890123.1234567890123-sha",
      "1234567890123.1234567890123.1234567890122-rc.1+build.9",
    );
    const line = out.find((l) => l.includes("Update available")) ?? "";
    const plain = line.replace(/\[\[\/?\w+\]\]/g, "");
    expect([...plain].length).toBe(80);
    expect(plain).toBe(
      "!  Update available: 123456789…567890123 (this machine runs 123456789…1+build.9)",
    );
  });

  it("says nothing while the hub link is down", async () => {
    const ctx = fakeCtx({ service: launchd(), status: up(down) });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(1);
    expect(ctx.all().join("\n")).not.toContain("Update available");
    expect(ctx.all().join("\n")).toContain("Hub not reachable");
    const doc = fakeCtx({
      nodeVersion: "v22.11.0",
      service: launchd(),
      status: up(down),
      fetch: vi.fn(async () => new Response("ok")) as unknown as typeof fetch,
      which: () => false,
    });
    approve(doc);
    await doctor(doc);
    expect(doc.all().join("\n")).not.toContain("Update available");
  });

  it("is silent when equal, older or unknown", async () => {
    for (const hub of [
      "0.47.0",
      "0.47.0+build.7",
      "0.46.2",
      "0.9.99",
      "0.47.0-abc1234",
      undefined,
      "dev",
      "e2e",
      "\x1b]52;c;aGk=\x07",
    ]) {
      const out = await run(hub, "0.47.0");
      expect(out.join("\n")).not.toContain("Update available");
    }
  });

  it("doctor warns once and counts it", async () => {
    const ctx = fakeCtx({
      nodeVersion: "v22.11.0",
      service: launchd(),
      status: up({ version: "0.46.3", hub_version: "0.47.0" }),
      fetch: vi.fn(async () => new Response("ok")) as unknown as typeof fetch,
      which: () => false,
    });
    approve(ctx);
    expect(await doctor(ctx)).toBe(0);
    const out = ctx.all();
    expect(out.filter((l) => l.includes("Update available"))).toEqual([
      draft[1],
    ]);
    expect(out).toContain(draft[2]);
    expect(out.at(-1)).toBe("[[muted]]1 warning, 4 passed.[[/muted]]");
  });

  it("status shows a made-up kind as itself", async () => {
    const ctx = fakeCtx({
      service: launchd(),
      status: up({
        namespaces: [
          {
            namespace: NS,
            agents: [
              { name: "zz-1", kind: "zz", machine: LABEL, state: "live" },
            ],
          },
        ],
      }),
    });
    approve(ctx);
    expect(await statusCmd(ctx)).toBe(0);
    expect(ctx.all().find((l) => l.includes("zz-1"))).toMatch(
      /^ {2}zz-1 {16}zz {11}leo-macbook-pro/,
    );
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
      "   Install Node 22 or newer, then run npx @open-bus/cli doctor again.",
      "[[danger]]×[[/danger]]  No credentials at ~/.openbus/machine.json",
      "   Run npx @open-bus/cli to approve this machine.",
      "[[danger]]×[[/danger]]  Daemon is not running",
      "   Run npx @open-bus/cli to restart it.",
      "[[warning]]![[/warning]]  OpenCode version unknown",
      "   Run opencode --version to check it, then npx @open-bus/cli install again.",
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
        "   Run npx @open-bus/cli install to approve it again.",
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
        "   Run npx @open-bus/cli install.",
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
    const ctx = fakeCtx({
      service: launchd(),
      which: ALL,
      exec: execWith(),
      // machine.json's hub is the one to revoke on, whatever OPENBUS_HUB says.
      env: { OPENBUS_HUB: "https://other.example.org" },
    });
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

describe("--home", () => {
  it("uninstall --purge --home X purges X, not ~/.openbus", async () => {
    const ctx = fakeCtx();
    approve(ctx);
    const own = ctx.home;
    const other = join(ctx.userHome, "other");
    mkdirSync(other);
    writeFileSync(join(other, "machine.json"), "{}");
    expect(
      await main(["uninstall", "--purge", "--home", other], () => ctx),
    ).toBe(0);
    expect(existsSync(other)).toBe(false);
    expect(existsSync(join(own, "machine.json"))).toBe(true);
  });

  it("status --home X reads X", async () => {
    const ctx = fakeCtx();
    const other = join(ctx.userHome, "other");
    expect(await main(["status", "--home", other], () => ctx)).toBe(1);
    expect(ctx.home).toBe(other);
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
    writeFileSync(join(home, "install.json.123.0a1b2c3d.tmp"), "");
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
    expect(load.mock.calls).toEqual([["claude"], ["opencode"]]);
    const pi = fakeCtx();
    expect(await mcp("pi", pi, load)).toBe(1);
    expect(pi.out()[0]).toMatch(/Pi uses the OpenBus extension/);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("main: version, and a usage error exits 2", async () => {
    const ctx = fakeCtx();
    expect(await main(["version"], () => ctx)).toBe(0);
    expect(await main(["-v"], () => ctx)).toBe(0);
    expect(ctx.out()).toEqual(["open-bus 0.1.0", "open-bus 0.1.0"]);
    const bad = fakeCtx();
    expect(await main(["wat"], () => bad)).toBe(2);
    expect(bad.err()[0]).toBe("[[danger]]×[[/danger]]  Unknown command: wat");
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
    let deps: { onRevoked?: (replaced?: boolean) => void } = {};
    const run = vi.fn(
      async (d: { onRevoked?: (replaced?: boolean) => void }) => {
        deps = d;
        return { stop } as unknown as Awaited<
          ReturnType<Parameters<typeof daemon>[1] & {}>
        >;
      },
    );
    return {
      signals,
      stop,
      run,
      revoke: (replaced?: boolean) => deps.onRevoked?.(replaced),
    };
  };

  it("stays in the foreground and exits 0 on SIGTERM", async () => {
    const f = fake();
    const done = daemon(fakeCtx(), f.run as never, f.signals);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    f.signals.emit("SIGTERM");
    expect(await done).toBe(0);
    expect(f.stop).toHaveBeenCalledOnce();
  });

  it("exits 78, once, when the machine is revoked", async () => {
    const f = fake();
    const done = daemon(fakeCtx(), f.run as never, f.signals);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    f.revoke();
    f.revoke();
    f.signals.emit("SIGINT");
    expect(await done).toBe(78);
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.signals.listenerCount("SIGINT")).toBe(0);
  });

  it("exits 1 for a restart when only an older token was revoked", async () => {
    const f = fake();
    const done = daemon(fakeCtx(), f.run as never, f.signals);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    f.revoke(true);
    expect(await done).toBe(1);
  });

  it("starts when the revoked marker names another token", async () => {
    const f = fake();
    const ctx = fakeCtx();
    approve(ctx);
    writeFileSync(join(ctx.home, "revoked"), revokedMarker(newMachineToken()));
    const done = daemon(ctx, f.run as never, f.signals);
    await vi.waitFor(() => expect(f.run).toHaveBeenCalled());
    f.signals.emit("SIGTERM");
    expect(await done).toBe(0);
  });

  it("exits 0 without starting when the revoked marker is there", async () => {
    const f = fake();
    const ctx = fakeCtx();
    mkdirSync(ctx.home, { recursive: true });
    writeFileSync(join(ctx.home, "revoked"), "");
    expect(await daemon(ctx, f.run as never, f.signals)).toBe(0);
    expect(f.run).not.toHaveBeenCalled();
    expect(ctx.err()).toEqual([
      "[[danger]]×[[/danger]]  This machine was revoked.",
      "   Run npx @open-bus/cli install to approve it again.",
    ]);
  });

  describe("under a service (OPENBUS_SERVICE=1)", () => {
    const start = (env: Record<string, string>, error: Error) => {
      const ctx = fakeCtx({ env });
      return daemon(
        ctx,
        async () => {
          throw error;
        },
        new EventEmitter() as never,
      ).then((code) => ({ code, err: ctx.err() }));
    };
    const lastingErrors = [
      new StartError(
        "NOT_LOGGED_IN",
        "not logged in: run `npx @open-bus/cli install`",
      ),
      new StartError(
        "SOCKET_IN_USE",
        "daemon already listening on /x/daemon.sock",
      ),
      new StartError(
        "HUB_MISMATCH",
        "the hub https://a is not the one this machine was approved for (https://b)",
      ),
    ];

    it("a lasting start failure logs one line and exits 0, so no manager restarts it", async () => {
      for (const e of lastingErrors) {
        const r = await start({ OPENBUS_SERVICE: "1" }, e);
        expect(r.code).toBe(0);
        // The copy's failure block, the message clipped to 80 columns.
        expect(r.err).toEqual(fakeCtx().copy.failed(e.message));
      }
    });

    it("a transient failure still exits 1, to be restarted", async () => {
      const r = await start({ OPENBUS_SERVICE: "1" }, new Error("ECONNRESET"));
      expect(r.code).toBe(1);
    });

    it("a machine.json it may not read (EACCES, EPERM) is lasting too", async () => {
      for (const code of ["EACCES", "EPERM"]) {
        const e = Object.assign(new Error(`${code}: open machine.json`), {
          code,
        });
        expect((await start({ OPENBUS_SERVICE: "1" }, e)).code).toBe(0);
      }
    });

    it("matches the code, never the message", async () => {
      const r = await start(
        { OPENBUS_SERVICE: "1" },
        new Error("not logged in: run `npx @open-bus/cli install`"),
      );
      expect(r.code).toBe(1);
    });

    it("in a terminal the same failures exit 1", async () => {
      for (const e of lastingErrors) expect((await start({}, e)).code).toBe(1);
    });
  });

  it("exits 1 with the reason when it cannot start", async () => {
    const ctx: Ctx = fakeCtx();
    const code = await daemon(
      ctx,
      async () => {
        throw new Error("not logged in: run `npx @open-bus/cli install`");
      },
      new EventEmitter() as never,
    );
    expect(code).toBe(1);
    expect((ctx as Fake).err()[0]).toBe(
      "[[danger]]×[[/danger]]  not logged in: run `npx @open-bus/cli install`",
    );
  });
});
