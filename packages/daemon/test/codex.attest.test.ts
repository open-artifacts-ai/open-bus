// C26c: a codex hello is admitted only when its parent is a codex process
// pinned by start time, that process holds the thread's writer lock, the
// rollout has this call id as an unanswered openbus call, and the thread is
// not a subagent. Fixtures copy the probe's redacted shapes (docs/probes/codex.md §2).
import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hello } from "@ob/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { attest } from "../src/attest.ts";
import {
  CODEX_REFUSALS,
  type CodexAttestDeps,
  callState,
  codexAttestor,
  holdsFileLinux,
} from "../src/codex-attest.ts";
import { daemonHarness, hello, stopAll } from "./helpers.ts";

const THREAD = "01a184e8-eba5-7561-aed8-9bffaa2355fb";
const CWD = "/work/project";

const procs: ChildProcess[] = [];
afterEach(async () => {
  // Only our own pids.
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  await stopAll();
});

const line = (type: string, payload: object) =>
  `${JSON.stringify({ timestamp: "2026-10-29T00:47:00.000Z", type, payload })}\n`;
const meta = (over: object = {}) =>
  line("session_meta", {
    id: THREAD,
    session_id: THREAD,
    timestamp: "2026-10-29T00:46:59.000Z",
    cwd: CWD,
    originator: "codex_exec",
    cli_version: "0.165.0",
    source: "exec",
    thread_source: "user",
    model_provider: "stub",
    ...over,
  });
const call = (call_id: string, namespace = "mcp__openbus") =>
  line("response_item", {
    type: "function_call",
    id: "fc_1",
    name: "send_message",
    namespace,
    arguments: "{}",
    call_id,
  });
const output = (call_id: string) =>
  line("response_item", {
    type: "function_call_output",
    id: "fco_1",
    call_id,
    output: [{ type: "input_text", text: "ok" }],
  });

type Home = { home: string; rollout: string; lock: string };
/** A temp CODEX_HOME: the lock file, a rollout, and optionally a state_5 row. */
function codexHome(
  opts: { rollout?: string; db?: false | { source: string } } = {},
): Home {
  const home = mkdtempSync(join(tmpdir(), "ob-codex-"));
  mkdirSync(join(home, "thread-writer-locks"));
  const lock = join(home, "thread-writer-locks", `${THREAD}.lock`);
  writeFileSync(lock, "");
  const day = join(home, "sessions", "2026", "10", "29");
  mkdirSync(day, { recursive: true });
  const rollout = join(day, `rollout-2026-10-29T00-46-59-${THREAD}.jsonl`);
  writeFileSync(rollout, opts.rollout ?? meta() + call("call_1"));
  if (opts.db !== false) {
    const db = new DatabaseSync(join(home, "state_5.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(
      "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, source TEXT, originator TEXT, cwd TEXT, archived INTEGER, agent_path TEXT)",
    );
    db.prepare(
      "INSERT INTO threads VALUES (?, ?, ?, 'codex_exec', ?, 0, NULL)",
    ).run(THREAD, rollout, opts.db?.source ?? "exec", CWD);
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

/** P = 100 runs codex and holds the lock; the adapter 200 is its child. */
const fakeProcs = (over: Partial<CodexAttestDeps> = {}): CodexAttestDeps => ({
  parent: (pid) => (pid === 200 ? 100 : 1),
  comm: (pid) => (pid === 100 ? "/opt/codex/bin/codex" : "node"),
  procStart: () => "Thu Oct 29 00:46:59 2026",
  holds: (pid) => pid === 100,
  ...over,
});

describe("codex attestation (C26c)", () => {
  it("accepts an open openbus call, with the rollout's cwd and the codex pid", () => {
    const { home } = codexHome();
    const check = codexAttestor({ home, ...fakeProcs() });
    expect(check(codexHello())).toEqual({ ok: true, cwd: CWD, pid: 100 });
  });

  it("refuses a forged parent: the ppid is not the adapter's, or not codex", () => {
    const { home } = codexHome();
    expect(
      codexAttestor({ home, ...fakeProcs({ parent: () => 999 }) })(
        codexHello(),
      ),
    ).toEqual({ ok: false, reason: CODEX_REFUSALS.notCodex });
    expect(
      codexAttestor({ home, ...fakeProcs({ comm: () => "/bin/zsh" }) })(
        codexHello(),
      ),
    ).toEqual({ ok: false, reason: CODEX_REFUSALS.notCodex });
  });

  it("refuses a parent whose start time moved since it was pinned", () => {
    const { home, rollout } = codexHome();
    let start = "Thu Oct 29 00:46:59 2026";
    const check = codexAttestor({
      home,
      ...fakeProcs({ procStart: () => start }),
    });
    expect(check(codexHello()).ok).toBe(true);
    appendFileSync(rollout, call("call_2"));
    start = "Thu Oct 29 09:00:00 2026";
    expect(check(codexHello({ call_id: "call_2" }))).toEqual({
      ok: false,
      reason: CODEX_REFUSALS.restarted,
    });
  });

  it("refuses when another process holds the thread's lock", () => {
    const { home } = codexHome();
    const check = codexAttestor({
      home,
      ...fakeProcs({ holds: (pid) => pid === 555 }),
    });
    expect(check(codexHello())).toEqual({
      ok: false,
      reason: CODEX_REFUSALS.notLoaded,
    });
  });

  it("refuses an unknown, answered, replayed or foreign-namespace call id", () => {
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
    expect(check(codexHello({ call_id: "call_nope" }))).toEqual(no);
    expect(check(codexHello({ call_id: "call_old" }))).toEqual(no);
    expect(check(codexHello({ call_id: "call_probe" }))).toEqual(no);
    expect(check(codexHello()).ok).toBe(true);
    // Replayed while still unanswered, then answered.
    expect(check(codexHello())).toEqual(no);
    appendFileSync(rollout, output("call_1"));
    expect(check(codexHello())).toEqual(no);
  });

  it("refuses a subagent thread by the db, whatever the hello says", () => {
    const { home } = codexHome({
      db: {
        source: JSON.stringify({
          subagent: { thread_spawn: { parent_thread_id: "p" } },
        }),
      },
    });
    expect(codexAttestor({ home, ...fakeProcs() })(codexHello())).toEqual({
      ok: false,
      reason: CODEX_REFUSALS.subagent,
    });
  });

  it("falls back to the rollout's session_meta when there is no db", () => {
    const sub = codexHome({
      db: false,
      rollout:
        meta({ source: { subagent: { thread_spawn: {} } } }) + call("call_1"),
    });
    expect(
      codexAttestor({ home: sub.home, ...fakeProcs() })(codexHello()),
    ).toEqual({ ok: false, reason: CODEX_REFUSALS.subagent });
    const main = codexHome({ db: false });
    expect(
      codexAttestor({ home: main.home, ...fakeProcs() })(codexHello()),
    ).toEqual({ ok: true, cwd: CWD, pid: 100 });
  });

  it("refuses a hello whose agent_ref is not its thread", () => {
    const { home } = codexHome();
    expect(
      codexAttestor({ home, ...fakeProcs() })(
        codexHello({}, { agent_ref: "01a184e8-0000-7561-aed8-9bffaa2355fb" }),
      ),
    ).toEqual({ ok: false, reason: "codex hello does not name its thread" });
  });

  it("finds the call behind more than one read chunk", () => {
    const { rollout } = codexHome({
      rollout: `${meta()}${call("call_1")}${line("event_msg", { type: "token_count", pad: "x".repeat(300_000) })}`,
    });
    expect(callState(rollout, "call_1")).toBe("open");
    appendFileSync(rollout, output("call_1"));
    expect(callState(rollout, "call_1")).toBe("answered");
  });

  it("reads a Linux holder from /proc/locks and the process's fds", () => {
    const { lock } = codexHome();
    const proc = mkdtempSync(join(tmpdir(), "ob-proc-"));
    const { ino } = statSync(lock);
    writeFileSync(
      join(proc, "locks"),
      `1: FLOCK  ADVISORY  WRITE 4242 01:04:${ino} 0 EOF\n`,
    );
    mkdirSync(join(proc, "100", "fd"), { recursive: true });
    symlinkSync(lock, join(proc, "100", "fd", "7"));
    mkdirSync(join(proc, "101", "fd"), { recursive: true });
    expect(holdsFileLinux(100, lock, proc)).toBe(true);
    expect(holdsFileLinux(101, lock, proc)).toBe(false);
    writeFileSync(join(proc, "locks"), "");
    expect(holdsFileLinux(100, lock, proc)).toBe(false);
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
  // The sleep child dies with SIGKILL of its parent only if killed itself.
  procs.push({ kill: () => process.kill(adapter, "SIGKILL") } as ChildProcess);
  return { p: proc.pid as number, adapter };
}

describe("codex attestation against real processes (C26c)", () => {
  it("admits the thread through the daemon's real attest, then refuses a replay", async () => {
    const { home, rollout, lock } = codexHome();
    const { p, adapter } = await fakeCodex(lock);
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
    appendFileSync(rollout, output("call_1") + call("call_2"));
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
