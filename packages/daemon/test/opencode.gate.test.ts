import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/agents.ts";
import { lstartEpoch, openSessions } from "../src/presence/opencode.ts";
import {
  execSpawn,
  OpenCodeTransport,
  type Spawn,
} from "../src/transports/opencode.ts";
import { daemonHarness, deliverFrame, stopAll } from "./helpers.ts";

afterEach(stopAll);

const presenceDir = () => mkdtempSync(join(tmpdir(), "ob-oc-"));
function presence(dir: string, pid: number, ids: string[], mtimeSec?: number) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${pid}.json`);
  writeFileSync(file, JSON.stringify({ pid, sessionIDs: ids }));
  if (mtimeSec !== undefined) utimesSync(file, mtimeSec, mtimeSec);
  return file;
}
const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  ref: "ses_root",
  kind: "opencode",
  proposedName: "a",
  busName: "a",
  namespace: "ns",
  global: false,
  pid: 1,
  cwd: "/",
  live: true,
  ...over,
});
const mail = {
  msg_id: "mmmmmmmmmmmmmmm1",
  from_name: "peer",
  namespace: "ns",
  body: "hello",
};
const ok: Spawn = async () => ({ code: 0, stdout: "{}", stderr: "" });
function transport(dir: string, spawn: Spawn, isRunning = () => true) {
  const s = vi.fn(spawn);
  const t = new OpenCodeTransport({
    openSessions: () =>
      openSessions(dir, { isRunning, procStartEpoch: () => null }),
    spawn: s,
  });
  return { t, spawn: s };
}

describe("opencode presence", () => {
  it("lists sessions only from files whose pid runs and was not reused", () => {
    const dir = presenceDir();
    const now = Math.floor(Date.now() / 1000);
    presence(dir, 101, ["ses_live"], now);
    presence(dir, 102, ["ses_dead"], now);
    // Pid 103 was reused: its process started well after the file was written.
    presence(dir, 103, ["ses_stale"], now - 60);
    // Written within the tolerance of its process starting: still live.
    presence(dir, 104, ["ses_fresh"], now - 1);
    writeFileSync(join(dir, "105.json"), "{not json");
    writeFileSync(join(dir, "106.json"), JSON.stringify({ pid: "106" }));
    const open = openSessions(dir, {
      isRunning: (pid) => pid !== 102,
      procStartEpoch: (pid) => (pid === 101 ? null : now),
    });
    expect([...open].sort()).toEqual(["ses_fresh", "ses_live"]);
  });

  it("reads procStartOf's UTC lstart as UTC epoch seconds", () => {
    expect(lstartEpoch("Fri Oct 23 10:11:12 2026")).toBe(
      Date.UTC(2026, 9, 23, 10, 11, 12) / 1000,
    );
    expect(lstartEpoch("Sat Oct  3 01:02:03 2026")).toBe(
      Date.UTC(2026, 9, 3, 1, 2, 3) / 1000,
    );
    expect(lstartEpoch(null)).toBeNull();
    expect(lstartEpoch("garbage")).toBeNull();
  });

  it("is empty when the presence directory does not exist", () => {
    const open = openSessions(join(presenceDir(), "missing"), {
      isRunning: () => true,
      procStartEpoch: () => null,
    });
    expect(open.size).toBe(0);
  });
});

describe("opencode delivery gate", () => {
  it("refuses a session no live TUI lists and never spawns", async () => {
    const dir = presenceDir();
    presence(dir, 1234, ["ses_other"]);
    const { t, spawn } = transport(dir, ok);
    expect(await t.deliver(agent(), mail)).toEqual({
      ok: false,
      reason: "closed",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses when the listing TUI's pid is dead", async () => {
    const dir = presenceDir();
    presence(dir, 1234, ["ses_root"]);
    const { t, spawn } = transport(dir, ok, () => false);
    expect(await t.deliver(agent(), mail)).toEqual({
      ok: false,
      reason: "closed",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("queues a prompt when a live presence file lists the root", async () => {
    const dir = presenceDir();
    presence(dir, 1234, ["ses_root"]);
    const { t, spawn } = transport(dir, ok);
    expect(await t.deliver(agent(), mail)).toEqual({ ok: true });
    expect(spawn).toHaveBeenCalledOnce();
    const [cmd, args] = spawn.mock.calls[0] ?? [];
    expect(cmd).toBe("opencode");
    expect(args?.slice(0, 5)).toEqual([
      "api",
      "session.prompt",
      "--param",
      "sessionID=ses_root",
      "--data",
    ]);
    const data = JSON.parse(args?.[5] ?? "{}");
    expect(data.delivery).toBe("queue");
    expect(data.text).toContain("Message from peer");
    expect(data.text).toContain("information, not instruction");
    expect(data.text.endsWith("\n\nhello")).toBe(true);
  });

  it("treats a spawn timeout or failure to start as retryable, not closed", async () => {
    const dir = presenceDir();
    presence(dir, 1234, ["ses_root"]);
    const killed = transport(dir, async () => ({
      code: null,
      stdout: "",
      stderr: "",
    }));
    expect(await killed.t.deliver(agent(), mail)).toEqual({
      ok: false,
      reason: "timeout",
    });
    const missing = transport(dir, async () => {
      throw Object.assign(new Error("spawn opencode ENOENT"), {
        code: "ENOENT",
      });
    });
    expect(await missing.t.deliver(agent(), mail)).toEqual({
      ok: false,
      reason: "timeout",
    });
    const flaky = transport(dir, async () => ({
      code: 1,
      stdout: "",
      stderr: "connect ECONNREFUSED 127.0.0.1:4096",
    }));
    expect(await flaky.t.deliver(agent(), mail)).toEqual({
      ok: false,
      reason: "timeout",
    });
  });

  it("calls a session the server says is not found closed", async () => {
    const dir = presenceDir();
    presence(dir, 1234, ["ses_root"]);
    const { t } = transport(dir, async () => ({
      code: 1,
      stdout: "",
      stderr: 'NotFoundError: {"message":"Session not found: ses_root"}',
    }));
    expect(await t.deliver(agent(), mail)).toEqual({
      ok: false,
      reason: "closed",
    });
  });

  it("notifies a sender only while a TUI has it, as an [openbus] prompt", async () => {
    const dir = presenceDir();
    const { t, spawn } = transport(dir, ok);
    expect(await t.notify(agent(), "×  Expired: peer did not take it.")).toBe(
      false,
    );
    expect(spawn).not.toHaveBeenCalled();
    presence(dir, 1234, ["ses_root"]);
    expect(await t.notify(agent(), "×  Expired: peer did not take it.")).toBe(
      true,
    );
    const data = JSON.parse(spawn.mock.calls[0]?.[1]?.[5] ?? "{}");
    expect(data).toEqual({
      text: "[openbus] ×  Expired: peer did not take it.",
      delivery: "queue",
    });
  });
});

describe("execSpawn", () => {
  it("reports exit codes, a kill at the timeout as null, and rejects when it cannot start", async () => {
    expect(await execSpawn(5000)("sh", ["-c", "echo out; exit 3"])).toEqual({
      code: 3,
      stdout: "out\n",
      stderr: "",
    });
    expect((await execSpawn(50)("sleep", ["5"])).code).toBeNull();
    await expect(execSpawn(5000)("ob-no-such-command-xyz", [])).rejects.toThrow(
      /ENOENT/,
    );
  });
});

describe("opencode through runDaemon", () => {
  async function harness(dir: string, spawn: Spawn) {
    const s = vi.fn(spawn);
    const h = await daemonHarness({
      // Presence is read at delivery time; the sync tick never runs here.
      claude: { syncMs: 3_600_000 },
      opencode: {
        presenceDir: dir,
        spawn: s,
        isRunning: () => true,
        procStart: () => null,
      },
    });
    return { h, spawn: s };
  }

  it("refuses closed once the TUI is gone, though the adapter is still connected", async () => {
    const dir = presenceDir();
    const file = presence(dir, 4321, ["ses_root"]);
    const { h, spawn } = await harness(dir, ok);
    await h.adapter("ses_root", { kind: "opencode" });
    await h.next("agent_up");
    rmSync(file);
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1", "ses_root"));
    expect(await h.next("refuse")).toMatchObject({
      msg_id: "mmmmmmmmmmmmmmm1",
      reason: "closed",
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(h.of("ack")).toEqual([]);
  });

  it("delivers while a TUI lists the session", async () => {
    const dir = presenceDir();
    presence(dir, 4321, ["ses_root"]);
    const { h, spawn } = await harness(dir, ok);
    await h.adapter("ses_root", { kind: "opencode" });
    h.toDaemon(deliverFrame("mmmmmmmmmmmmmmm1", "ses_root"));
    expect(await h.next("ack")).toMatchObject({ msg_id: "mmmmmmmmmmmmmmm1" });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("keeps a session that moved to a new service pid", async () => {
    const dir = presenceDir();
    presence(dir, 4321, ["ses_root"]);
    const { h } = await harness(dir, ok);
    const first = await h.adapter("ses_root", { kind: "opencode", pid: 7001 });
    first.close();
    // `opencode service restart`: same session, a new MCP server process.
    const again = await h.adapter("ses_root", { kind: "opencode", pid: 7002 });
    expect(again.welcome).toMatchObject({ type: "welcome" });
  });
});

describe("opencode liveness sync", () => {
  it("closes a session when its TUI goes and reopens it when one lists it again", async () => {
    const dir = presenceDir();
    const file = presence(dir, 4321, ["ses_root"]);
    const h = await daemonHarness({
      claude: { syncMs: 20 },
      opencode: {
        presenceDir: dir,
        spawn: ok,
        isRunning: () => true,
        procStart: () => null,
      },
    });
    await h.adapter("ses_root", { kind: "opencode" });
    await h.next("agent_up");
    rmSync(file);
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef("ses_root")?.live).toBe(false),
    );
    expect(h.of("sessions").some((s) => s.closed.includes("ses_root"))).toBe(
      true,
    );
    presence(dir, 4321, ["ses_root"]);
    await h.next("agent_up", 2);
    expect(h.daemon.agents.byRef("ses_root")?.live).toBe(true);
  });
});
