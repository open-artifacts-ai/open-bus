// C26c: a codex hello is admitted only when its parent is a codex process
// pinned by start time, that process holds the thread's writer lock, the
// rollout has this call id as an unanswered openbus call, and the thread is
// not a subagent. The rollout fixtures are a live Codex 0.165 capture,
// redacted and abridged (docs/probes/codex.md §2).
import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hello } from "@ob/ipc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attest } from "../src/attest.ts";
import {
  CODEX_REFUSALS,
  type CodexAttestDeps,
  callOpen,
  codexAttestor,
  devParts,
  holdingFiles,
  holdsFileLinux,
  type Proc,
  psRows,
} from "../src/codex-attest.ts";
import { daemonHarness, hello, stopAll } from "./helpers.ts";

/** The live capture's thread; its cwd is redacted to CWD. */
const THREAD = "01a18536-7f07-7680-b17c-199e3dadf886";
const CWD = "/work/project";
const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
/** Codex's rollout at the instant the MCP server got tools/call for call_1. */
const AT_CALL = fixture("codex-rollout-at-call.jsonl");
/** What Codex wrote after the call returned: item_completed, then the output. */
const AFTER = fixture("codex-rollout-after.jsonl");

const procs: ChildProcess[] = [];
afterEach(async () => {
  // Only our own pids.
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  await stopAll();
});

/** Stamped now: a call must be written after its codex process started. */
const line = (
  type: string,
  payload: object,
  timestamp = new Date().toISOString(),
) => `${JSON.stringify({ timestamp, type, payload })}\n`;
const meta = (over: object = {}) =>
  line("session_meta", {
    id: THREAD,
    session_id: THREAD,
    cwd: CWD,
    originator: "codex_exec",
    cli_version: "0.165.0",
    source: "exec",
    thread_source: "user",
    ...over,
  });
/** The capture's function_call shape. */
const call = (call_id: string, namespace = "mcp__openbus") =>
  line("response_item", {
    type: "function_call",
    id: "fc_2",
    name: "send_message",
    namespace,
    arguments: '{"to":"peer","text":"hi"}',
    call_id,
  });
const output = (call_id: string) =>
  line("response_item", {
    type: "function_call_output",
    id: "fco_2",
    call_id,
    output: [{ type: "input_text", text: "sent" }],
  });

type Home = { home: string; rollout: string; lock: string };
/** A temp CODEX_HOME: the lock file, a rollout, and optionally a state_5 row. */
function codexHome(
  opts: {
    rollout?: string;
    db?: false | { source?: string; path?: string };
  } = {},
): Home {
  const home = mkdtempSync(join(tmpdir(), "ob-codex-"));
  mkdirSync(join(home, "thread-writer-locks"));
  const lock = join(home, "thread-writer-locks", `${THREAD}.lock`);
  writeFileSync(lock, "");
  const day = join(home, "sessions", "2026", "10", "29");
  mkdirSync(day, { recursive: true });
  const rollout = join(day, `rollout-2026-10-29T02-11-43-${THREAD}.jsonl`);
  writeFileSync(rollout, opts.rollout ?? AT_CALL);
  if (opts.db !== false) {
    const db = new DatabaseSync(join(home, "state_5.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, source TEXT, originator TEXT, cwd TEXT, archived INTEGER, agent_path TEXT)",
    );
    db.prepare(
      "INSERT INTO threads VALUES (?, ?, ?, 'codex_exec', ?, 0, NULL)",
    ).run(THREAD, opts.db?.path ?? rollout, opts.db?.source ?? "exec", CWD);
    db.close();
  }
  return { home, rollout, lock };
}

const codexHello = (
  over: Partial<NonNullable<Hello["codex"]>> = {},
  h: Partial<Hello> = {},
) =>
  hello({
    kind: "codex",
    agent_ref: THREAD,
    pid: 200,
    cwd: "/adapter/guess",
    codex: {
      thread_id: THREAD,
      call_id: "call_1",
      ppid: 100,
      thread_source: "user",
      ...over,
    },
    ...h,
  });

const START = "Thu Oct 29 01:11:43 2026";
/** P = 100 and P2 = 300 run codex; the adapters 200 and 201 are their children. */
const table = (
  start = () => START,
  start2 = () => START,
): Record<number, () => Proc> => ({
  100: () => ({ ppid: 1, start: start(), comm: "/opt/codex/bin/codex" }),
  300: () => ({ ppid: 1, start: start2(), comm: "/opt/codex/bin/codex" }),
  200: () => ({ ppid: 100, start: START, comm: "node" }),
  201: () => ({ ppid: 300, start: START, comm: "node" }),
  400: () => ({ ppid: 1, start: START, comm: "/bin/zsh" }),
  401: () => ({ ppid: 400, start: START, comm: "node" }),
});
const fakeProcs = ({
  holds = (pid) => pid === 100,
  ...over
}: Partial<CodexAttestDeps> & {
  holds?: (pid: number, file: string) => boolean;
} = {}): CodexAttestDeps => {
  const t = table();
  return {
    procs: (pids) =>
      new Map(pids.flatMap((p) => (t[p] ? [[p, t[p]()] as const] : []))),
    holding: (pairs) => pairs.map(({ pid, file }) => holds(pid, file)),
    retryMs: 0,
    ...over,
  };
};

describe("codex attestation (C26c)", () => {
  it("accepts the live capture's open call, with the rollout's cwd and the codex pid", async () => {
    const { home } = codexHome();
    const check = codexAttestor({ home, ...fakeProcs() });
    expect(check.attestNow(codexHello())).toEqual({
      ok: true,
      cwd: CWD,
      pid: 100,
    });
  });

  it("closes the call on the capture's item_completed and output lines", async () => {
    const { rollout } = codexHome();
    expect(callOpen(rollout, "call_1")).toBe(true);
    // item_completed alone (the line Codex writes first) closes it.
    appendFileSync(rollout, AFTER.split("\n")[0] as string);
    appendFileSync(rollout, "\n");
    expect(callOpen(rollout, "call_1")).toBe(false);
  });

  it("closes a call on an *_end event", async () => {
    const { rollout } = codexHome({
      rollout:
        meta() +
        call("call_9") +
        line("event_msg", { type: "mcp_tool_call_end", call_id: "call_9" }),
    });
    expect(callOpen(rollout, "call_9")).toBe(false);
  });

  it("refuses a forged parent: the ppid is not the adapter's, or not codex", async () => {
    const { home } = codexHome();
    const check = codexAttestor({ home, ...fakeProcs() });
    expect(check.attestNow(codexHello({ ppid: 300 }))).toEqual({
      ok: false,
      reason: CODEX_REFUSALS.notCodex,
    });
    expect(check.attestNow(codexHello({ ppid: 400 }, { pid: 401 }))).toEqual({
      ok: false,
      reason: CODEX_REFUSALS.notCodex,
    });
  });

  it("refuses a parent whose start time moved since it was pinned", async () => {
    const { home, rollout } = codexHome();
    let start = START;
    const t = table(() => start);
    const check = codexAttestor({
      home,
      ...fakeProcs({
        procs: (pids) =>
          new Map(pids.flatMap((p) => (t[p] ? [[p, t[p]()] as const] : []))),
      }),
    });
    expect(check.attestNow(codexHello()).ok).toBe(true);
    appendFileSync(rollout, call("call_2"));
    start = "Thu Oct 29 09:00:00 2026";
    expect(check.attestNow(codexHello({ call_id: "call_2" }))).toEqual({
      ok: false,
      reason: CODEX_REFUSALS.restarted,
    });
  });

  it("refuses when another process holds the thread's lock", async () => {
    const { home } = codexHome();
    const check = codexAttestor({
      home,
      ...fakeProcs({ holds: (pid) => pid === 555 }),
    });
    expect(check.attestNow(codexHello())).toEqual({
      ok: false,
      reason: CODEX_REFUSALS.notLoaded,
    });
  });

  it("refuses an unknown, answered, replayed or foreign-namespace call id", async () => {
    const { home, rollout } = codexHome({
      rollout:
        meta() +
        call("call_old") +
        output("call_old") +
        call("call_probe", "mcp__probe") +
        call("call_1"),
    });
    const check = codexAttestor({ home, ...fakeProcs() });
    const no = { ok: false, reason: CODEX_REFUSALS.callNotFound };
    expect(check.attestNow(codexHello({ call_id: "call_nope" }))).toEqual(no);
    expect(check.attestNow(codexHello({ call_id: "call_old" }))).toEqual(no);
    expect(check.attestNow(codexHello({ call_id: "call_probe" }))).toEqual(no);
    expect(check.attestNow(codexHello()).ok).toBe(true);
    // Replayed while still unanswered, then answered.
    expect(check.attestNow(codexHello())).toEqual(no);
    appendFileSync(rollout, output("call_1"));
    expect(check.attestNow(codexHello())).toEqual(no);
    // A call appended later is read from where the last scan stopped.
    appendFileSync(rollout, call("call_3"));
    expect(check.attestNow(codexHello({ call_id: "call_3" })).ok).toBe(true);
  });

  it("refuses a subagent thread by the db, whatever the hello says", async () => {
    const { home } = codexHome({
      db: {
        source: JSON.stringify({
          subagent: { thread_spawn: { parent_thread_id: "p" } },
        }),
      },
    });
    expect(
      codexAttestor({ home, ...fakeProcs() }).attestNow(codexHello()),
    ).toEqual({ ok: false, reason: CODEX_REFUSALS.subagent });
  });

  it("falls back to the rollout's session_meta when there is no db", async () => {
    const sub = codexHome({
      db: false,
      rollout:
        meta({ source: { subagent: { thread_spawn: {} } } }) + call("call_1"),
    });
    expect(
      codexAttestor({ home: sub.home, ...fakeProcs() }).attestNow(codexHello()),
    ).toEqual({ ok: false, reason: CODEX_REFUSALS.subagent });
    const main = codexHome({ db: false });
    expect(
      codexAttestor({ home: main.home, ...fakeProcs() }).attestNow(
        codexHello(),
      ),
    ).toEqual({ ok: true, cwd: CWD, pid: 100 });
  });

  it("refuses a hello whose agent_ref is not its thread", async () => {
    const { home } = codexHome();
    expect(
      codexAttestor({ home, ...fakeProcs() }).attestNow(
        codexHello({}, { agent_ref: "01a184e8-0000-7561-aed8-9bffaa2355fb" }),
      ),
    ).toEqual({ ok: false, reason: "codex hello does not name its thread" });
  });

  it("refuses a symlinked lock or rollout", async () => {
    const a = codexHome();
    const other = join(a.home, "other.lock");
    writeFileSync(other, "");
    const lock = codexHome();
    rmSync(lock.lock);
    symlinkSync(other, lock.lock);
    expect(
      codexAttestor({ home: lock.home, ...fakeProcs() }).attestNow(
        codexHello(),
      ),
    ).toEqual({ ok: false, reason: CODEX_REFUSALS.notLoaded });
    const link = join(a.home, "link.jsonl");
    symlinkSync(a.rollout, link);
    const ro = codexHome({ db: { path: link } });
    expect(
      codexAttestor({ home: ro.home, ...fakeProcs() }).attestNow(codexHello()),
    ).toEqual({ ok: false, reason: CODEX_REFUSALS.callNotFound });
  });

  it("reads a session_meta past 1 MB (long instructions)", async () => {
    const { home } = codexHome({
      db: false,
      rollout:
        meta({ base_instructions: { text: "x".repeat(2_000_000) } }) +
        call("call_1"),
    });
    expect(
      codexAttestor({ home, ...fakeProcs() }).attestNow(codexHello()),
    ).toEqual({ ok: true, cwd: CWD, pid: 100 });
  });

  it("refuses an oversized (past 8 MB) or newline-less session_meta", async () => {
    const no = { ok: false, reason: CODEX_REFUSALS.callNotFound };
    const big = codexHome({
      db: false,
      rollout:
        meta({ base_instructions: { text: "x".repeat(8_500_000) } }) +
        call("call_1"),
    });
    expect(
      codexAttestor({ home: big.home, ...fakeProcs() }).attestNow(codexHello()),
    ).toEqual(no);
    const open = codexHome({ db: false, rollout: meta().trimEnd() });
    expect(
      codexAttestor({ home: open.home, ...fakeProcs() }).attestNow(
        codexHello(),
      ),
    ).toEqual(no);
  });

  it("finds the call behind more than one read chunk, past a skipped huge line", async () => {
    const { rollout } = codexHome({
      rollout: `${meta()}${line("event_msg", { type: "exec_command_end", call_id: "x", pad: "y".repeat(1_500_000) })}${call("call_1")}${line("event_msg", { type: "token_count", pad: "x".repeat(300_000) })}`,
    });
    expect(callOpen(rollout, "call_1")).toBe(true);
    appendFileSync(rollout, output("call_1"));
    expect(callOpen(rollout, "call_1")).toBe(false);
  });

  it("closes every open call at a turn boundary", async () => {
    for (const ev of ["task_complete", "turn_aborted", "task_started"]) {
      const { rollout } = codexHome({
        rollout:
          meta() +
          call("call_1") +
          line("event_msg", { type: ev }) +
          call("call_2"),
      });
      expect(callOpen(rollout, "call_1")).toBe(false);
      expect(callOpen(rollout, "call_2")).toBe(true);
    }
  });

  it("never admits a call left open by a codex that died, once the thread resumes in another (N1)", async () => {
    // P (100) dies mid-call: call_1 stays open in the rollout, never helloed.
    const { home } = codexHome({
      rollout: meta() + call("call_0") + call("call_1"),
    });
    let alive = true;
    const later = "Thu Dec 31 23:00:00 2099";
    const t = table(
      () => START,
      () => later,
    );
    const check = codexAttestor({
      home,
      ...fakeProcs({
        procs: (pids) =>
          new Map(
            pids.flatMap((p) =>
              t[p] && (alive || p !== 100) ? [[p, t[p]()] as const] : [],
            ),
          ),
        holds: (pid) => (alive ? pid === 100 : pid === 300),
      }),
    });
    expect(check.attestNow(codexHello({ call_id: "call_0" })).ok).toBe(true);
    alive = false;
    expect(check.sweep([{ thread: THREAD, pid: 100 }], true)).toEqual(
      new Set(),
    );
    // Resumed in P2 (300): neither the dangling call nor the admitted one is a token.
    const p2 = (call_id: string) =>
      codexHello({ call_id, ppid: 300 }, { pid: 201 });
    const no = { ok: false, reason: CODEX_REFUSALS.callNotFound };
    expect(check.attestNow(p2("call_1"))).toEqual(no);
    expect(check.attestNow(p2("call_0"))).toEqual(no);
  });

  it("rebuilds a thread's scan for one codex when another codex's is pruned (N2)", async () => {
    const { home } = codexHome({
      rollout: meta() + call("call_1") + call("call_2") + call("call_3"),
    });
    let alive = true;
    const t = table();
    const check = codexAttestor({
      home,
      ...fakeProcs({
        procs: (pids) =>
          new Map(
            pids.flatMap((p) =>
              t[p] && (alive || p !== 100) ? [[p, t[p]()] as const] : [],
            ),
          ),
        holds: (pid) => pid === 100 || pid === 300,
      }),
    });
    const p2 = (call_id: string) =>
      codexHello({ call_id, ppid: 300 }, { pid: 201 });
    expect(check.attestNow(codexHello()).ok).toBe(true);
    expect(check.attestNow(p2("call_2")).ok).toBe(true);
    alive = false;
    check.sweep([{ thread: THREAD, pid: 100 }], false);
    expect(check.attestNow(p2("call_3")).ok).toBe(true);
  });

  it("sweep relocks every live thread with one holding call (N5)", async () => {
    const { home } = codexHome({
      rollout: meta() + call("call_1") + call("call_2"),
    });
    const batches: number[] = [];
    const check = codexAttestor({
      home,
      ...fakeProcs({ holds: (pid) => pid === 100 || pid === 300 }),
    });
    check.attestNow(codexHello());
    check.attestNow(codexHello({ call_id: "call_2", ppid: 300 }, { pid: 201 }));
    const counted = codexAttestor({
      home,
      ...fakeProcs({ holds: (pid) => pid === 100 || pid === 300 }),
      holding: (pairs) => {
        batches.push(pairs.length);
        return pairs.map(() => true);
      },
    });
    counted.attestNow(codexHello());
    counted.attestNow(
      codexHello({ call_id: "call_2", ppid: 300 }, { pid: 201 }),
    );
    batches.length = 0;
    const live = [
      { thread: THREAD, pid: 100 },
      { thread: THREAD, pid: 300 },
    ];
    expect(counted.sweep(live, true)).toEqual(new Set([THREAD]));
    expect(batches).toEqual([2]);
    expect(check.sweep(live, true)).toEqual(new Set([THREAD]));
  });

  it("keeps admitted call ids when their codex is forgotten", async () => {
    const { home, rollout } = codexHome({ rollout: meta() + call("call_1") });
    let start = START;
    const t = table(() => start);
    const check = codexAttestor({
      home,
      ...fakeProcs({
        procs: (pids) =>
          new Map(pids.flatMap((p) => (t[p] ? [[p, t[p]()] as const] : []))),
      }),
    });
    expect(check.attestNow(codexHello()).ok).toBe(true);
    // A pid reuse forgets P; the same pid comes back as an earlier-started codex.
    start = "Thu Oct 29 09:00:00 2026";
    expect(check.attestNow(codexHello()).ok).toBe(false);
    start = START;
    appendFileSync(rollout, "");
    expect(check.attestNow(codexHello())).toEqual({
      ok: false,
      reason: CODEX_REFUSALS.callNotFound,
    });
  });

  it("sweep: a stale lock or a moved start drops the proof", async () => {
    const { home } = codexHome({ rollout: AT_CALL + call("call_2") });
    let held = true;
    const check = codexAttestor({
      home,
      ...fakeProcs({ holds: (pid) => held && pid === 100 }),
    });
    expect(check.attestNow(codexHello()).ok).toBe(true);
    const live = [{ thread: THREAD, pid: 100 }];
    expect(check.sweep(live, true)).toEqual(new Set([THREAD]));
    held = false;
    // Without relock only the start is checked.
    expect(check.sweep(live, false)).toEqual(new Set([THREAD]));
    expect(check.sweep(live, true)).toEqual(new Set());
    // The proof is gone: the next call proves the lock again.
    expect(check.attestNow(codexHello({ call_id: "call_2" }))).toEqual({
      ok: false,
      reason: CODEX_REFUSALS.notLoaded,
    });
    expect(check.sweep([{ thread: THREAD, pid: 999 }], false)).toEqual(
      new Set(),
    );
  });

  it("reads a Linux holder from /proc/locks by device and inode, and the process's fds", async () => {
    const { lock } = codexHome();
    const proc = mkdtempSync(join(tmpdir(), "ob-proc-"));
    const st = statSync(lock, { bigint: true });
    const { major, minor } = devParts(st.dev);
    const at = (maj: bigint) =>
      `1: FLOCK  ADVISORY  WRITE 4242 ${maj.toString(16).padStart(2, "0")}:${minor.toString(16).padStart(2, "0")}:${st.ino} 0 EOF\n`;
    writeFileSync(join(proc, "locks"), at(major));
    mkdirSync(join(proc, "100", "fd"), { recursive: true });
    symlinkSync(lock, join(proc, "100", "fd", "7"));
    mkdirSync(join(proc, "101", "fd"), { recursive: true });
    expect(holdsFileLinux(100, lock, proc)).toBe(true);
    expect(holdsFileLinux(101, lock, proc)).toBe(false);
    // Same inode on another device is another file.
    writeFileSync(join(proc, "locks"), at(major + 1n));
    expect(holdsFileLinux(100, lock, proc)).toBe(false);
    writeFileSync(join(proc, "locks"), "");
    expect(holdsFileLinux(100, lock, proc)).toBe(false);
  });

  it("reads pid, ppid, start and comm in one ps, leaving out a gone pid", async () => {
    const gone = spawn("true");
    await new Promise((r) => gone.once("exit", r));
    const rows = psRows([process.pid, gone.pid as number]);
    expect(rows.get(process.pid)).toMatchObject({ ppid: process.ppid });
    expect(rows.get(process.pid)?.start.split(" ")).toHaveLength(5);
    expect(rows.has(gone.pid as number)).toBe(false);
  });
});

/**
 * A fake Codex: perl run as `codex` (so its comm is codex), flock-ing `lock`
 * when given, with a `sleep` child standing in for the adapter.
 */
async function fakeCodex(
  lock?: string,
): Promise<{ p: number; adapter: number }> {
  const dir = mkdtempSync(join(tmpdir(), "ob-fakecodex-"));
  const bin = join(dir, "codex");
  symlinkSync("/usr/bin/perl", bin);
  const script = `
    use Fcntl ":flock"; $| = 1;
    if (@ARGV) { open(my $f, "<", $ARGV[0]) or die; flock($f, LOCK_EX) or die; our $keep = $f; }
    my $c = fork(); if ($c == 0) { exec("sleep", "60"); }
    print "$c\\n"; waitpid($c, 0);`;
  const proc = spawn(bin, ["-e", script, ...(lock ? [lock] : [])], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  procs.push(proc);
  const adapter = await new Promise<number>((resolve, reject) => {
    proc.stdout?.once("data", (d) => resolve(Number(String(d).trim())));
    proc.once("error", reject);
  });
  // The sleep child outlives a SIGKILLed parent unless killed itself.
  procs.push({ kill: () => process.kill(adapter, "SIGKILL") } as ChildProcess);
  return { p: proc.pid as number, adapter };
}

describe("codex attestation against real processes (C26c)", () => {
  it("checks every lock in one batch (N5)", async () => {
    const a = codexHome();
    const b = codexHome();
    const pa = await fakeCodex(a.lock);
    const pb = await fakeCodex(b.lock);
    expect(
      holdingFiles([
        { pid: pa.p, file: a.lock },
        { pid: pb.p, file: b.lock },
        { pid: pa.p, file: b.lock },
        { pid: pb.adapter, file: a.lock },
      ]),
    ).toEqual([true, true, false, false]);
  });

  it("admits the thread through the daemon's real attest, then refuses a replay", async () => {
    const { home, rollout, lock } = codexHome({ rollout: meta() });
    const { p, adapter } = await fakeCodex(lock);
    // Written after the fake codex started, as Codex writes its calls.
    appendFileSync(rollout, call("call_1"));
    const h = await daemonHarness({ attest: undefined, codex: { home } });
    const at = (call_id: string) =>
      codexHello({ call_id, ppid: p }, { pid: adapter });
    await h.adapter(THREAD, at("call_1"));
    expect(h.daemon.agents.byRef(THREAD)).toMatchObject({
      kind: "codex",
      pid: p,
      cwd: CWD,
      live: true,
    });
    appendFileSync(rollout, AFTER + call("call_2"));
    await h.adapter(THREAD, at("call_2"));
    await expect(h.adapter(THREAD, at("call_2"))).rejects.toThrow(
      CODEX_REFUSALS.callNotFound,
    );
  });

  it("refuses an adapter whose codex parent does not hold the lock", async () => {
    const { home, lock } = codexHome();
    await fakeCodex(lock);
    const other = await fakeCodex();
    expect(
      attest(codexHello({ ppid: other.p }, { pid: other.adapter }), {
        codex: codexAttestor({ home }),
      }),
    ).toEqual({ ok: false, reason: CODEX_REFUSALS.notLoaded });
  });

  it("refuses a forged ppid: the claimed codex is not the caller's parent", async () => {
    const { home, lock } = codexHome();
    const { p } = await fakeCodex(lock);
    expect(
      attest(codexHello({ ppid: p }, { pid: process.pid }), {
        codex: codexAttestor({ home }),
      }),
    ).toEqual({ ok: false, reason: CODEX_REFUSALS.notCodex });
  });
});

describe("a codex connection serves one call (C26c I1)", () => {
  it("answers one request, then refuses another on the same connection", async () => {
    const h = await daemonHarness();
    const c = await h.adapter(THREAD, codexHello());
    expect((await c.request({ type: "self" })).type).toBe("agent");
    await expect(c.request({ type: "list" })).rejects.toThrow();
    // A fresh connection, with its own call, is served.
    const d = await h.adapter(THREAD, codexHello({ call_id: "call_2" }));
    expect((await d.request({ type: "self" })).type).toBe("agent");
  });
});

describe("codex liveness and moves in the daemon (C26c I2, M4)", () => {
  const twoCalls = () =>
    codexHome({ rollout: AT_CALL + call("call_2") + call("call_3") });

  it("moves a thread to another codex only once the old one no longer holds the lock", async () => {
    const { home } = twoCalls();
    let holder = 100;
    const h = await daemonHarness({
      attest: undefined,
      codex: { home, ...fakeProcs({ holds: (pid) => pid === holder }) },
    });
    await h.adapter(THREAD, codexHello());
    expect(h.daemon.agents.byRef(THREAD)?.pid).toBe(100);
    // P2 claims the thread while P still holds the lock: refused, not moved.
    const p2 = (call_id: string) =>
      codexHello({ call_id, ppid: 300 }, { pid: 201 });
    await expect(h.adapter(THREAD, p2("call_2"))).rejects.toThrow(
      CODEX_REFUSALS.notLoaded,
    );
    holder = 300;
    await h.adapter(THREAD, p2("call_3"));
    expect(h.daemon.agents.byRef(THREAD)?.pid).toBe(300);
  });

  it("refuses a move while the old process still holds the lock", async () => {
    const { home } = twoCalls();
    const h = await daemonHarness({
      attest: undefined,
      // On macOS lsof sees an open file: both may look like holders.
      codex: {
        home,
        ...fakeProcs({ holds: (pid) => pid === 100 || pid === 300 }),
      },
    });
    await h.adapter(THREAD, codexHello());
    await expect(
      h.adapter(
        THREAD,
        codexHello({ call_id: "call_2", ppid: 300 }, { pid: 201 }),
      ),
    ).rejects.toThrow("agent_ref is in use by another session");
    expect(h.daemon.agents.byRef(THREAD)?.pid).toBe(100);
  });

  it("marks the thread down once its lock is no longer held", async () => {
    const { home } = twoCalls();
    let held = true;
    const h = await daemonHarness({
      attest: undefined,
      claude: { syncMs: 20 },
      codex: {
        home,
        relockEvery: 1,
        ...fakeProcs({ holds: (pid) => held && pid === 100 }),
      },
    });
    await h.adapter(THREAD, codexHello());
    expect(h.daemon.agents.byRef(THREAD)?.live).toBe(true);
    held = false;
    await vi.waitFor(() =>
      expect(h.daemon.agents.byRef(THREAD)?.live).toBe(false),
    );
  });
});

describe("the absent-call retry is asynchronous, once per call (C26c N3)", () => {
  it("admits a call that lands during the wait", async () => {
    const { home, rollout } = codexHome({ rollout: meta() });
    const waits: number[] = [];
    const check = codexAttestor({
      home,
      ...fakeProcs({
        retryMs: 50,
        sleep: async (ms) => {
          waits.push(ms);
          appendFileSync(rollout, call("call_1"));
        },
      }),
    });
    const r = check.attest(codexHello());
    expect(r).toBeInstanceOf(Promise);
    expect(await r).toEqual({ ok: true, cwd: CWD, pid: 100 });
    expect(waits).toEqual([50]);
  });

  it("waits once per call id: a second try is refused at once", async () => {
    const { home } = codexHome({ rollout: meta() });
    let waits = 0;
    const check = codexAttestor({
      home,
      ...fakeProcs({
        retryMs: 50,
        sleep: async () => {
          waits += 1;
        },
      }),
    });
    const no = { ok: false, reason: CODEX_REFUSALS.callNotFound };
    expect(await check.attest(codexHello())).toEqual(no);
    expect(check.attest(codexHello())).toEqual(no);
    expect(waits).toBe(1);
  });

  it("keeps the daemon serving while it waits", async () => {
    const { home, rollout } = codexHome({ rollout: meta() });
    const h = await daemonHarness({
      attest: undefined,
      codex: { home, ...fakeProcs({ retryMs: 200 }) },
    });
    // Only a free event loop runs this timer before the retry reads again.
    setTimeout(() => appendFileSync(rollout, call("call_1")), 20);
    await h.adapter(THREAD, codexHello());
    expect(h.daemon.agents.byRef(THREAD)).toMatchObject({ pid: 100, cwd: CWD });
  });
});
