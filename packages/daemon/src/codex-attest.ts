import { execFileSync } from "node:child_process";
import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { procStartOf } from "@ob/adapter-claude-code";
import { type Hello, SPAWNED_SOURCES } from "@ob/ipc";

/**
 * Refusal reasons for a codex hello. DRAFT: copy awaits Design's OK.
 * The adapter shows each as "the daemon did not accept this thread (<reason>)".
 */
export const CODEX_REFUSALS = {
  notCodex: "it is not running under a Codex process",
  restarted: "the Codex process restarted; call the tool again",
  notLoaded: "Codex does not have this thread loaded",
  callNotFound: "this tool call is not an open OpenBus call in the thread",
  subagent:
    "a subagent is not on the bus; only the main Codex thread can use OpenBus",
} as const;

/** The tool namespace Codex gives our MCP entry (`[mcp_servers.openbus]`). */
export const OPENBUS_NAMESPACE = "mcp__openbus";

/** The open call is near the end; past this many bytes from it, it is not open. */
const TAIL_CAP = 8 * 1024 * 1024;
/** session_meta carries base_instructions, so its line can be long. */
const META_CAP = 4 * 1024 * 1024;
const CHUNK = 64 * 1024;

export type CodexAttestDeps = {
  /** Codex's home; default `${CODEX_HOME:-~/.codex}` as the daemon sees it. */
  home?: string;
  /** The real parent of a pid (`ps -o ppid=`), null when it cannot be told. */
  parent?: (pid: number) => number | null;
  /** The executable a pid runs (`ps -o comm=`). */
  comm?: (pid: number) => string | null;
  /** `ps -o lstart=` in UTC. */
  procStart?: (pid: number) => string | null;
  /** Whether `pid` holds `file` open: `lsof -t` on macOS, /proc on Linux. */
  holds?: (pid: number, file: string) => boolean;
};

export type CodexAttest =
  | { ok: true; cwd: string; pid: number }
  | { ok: false; reason: string };

/** What a thread proved under one (P, start): run once, not per call. */
type Proof = { rollout: string; cwd: string };

export const codexHome = (): string =>
  process.env.CODEX_HOME || join(homedir(), ".codex");

/**
 * The codex check (D1): the adapter's parent P is a `codex` process whose
 * start is pinned at its first hello, P holds the thread's writer lock, the
 * thread's rollout has this call id as an unanswered `mcp__openbus`
 * function_call, and the thread is not a subagent. Stateful: one per daemon.
 *
 * Liveness is "P holds the lock", proven once per (P, start, thread): it means
 * Codex has the thread loaded, not that a user is watching it.
 */
export function codexAttestor(
  deps: CodexAttestDeps = {},
): (hello: Hello) => CodexAttest {
  const parent = deps.parent ?? parentOf;
  const comm = deps.comm ?? commOf;
  const procStart = deps.procStart ?? procStartOf;
  const holds = deps.holds ?? holdsFile;
  /** P's start time, pinned at its first hello. */
  const pinned = new Map<number, string>();
  /** Keyed by `${P}\0${start}\0${thread}`. */
  const proofs = new Map<string, Proof>();
  /** Call ids already admitted, per thread: a replay is refused. */
  const used = new Map<string, Set<string>>();
  const no = (reason: string): CodexAttest => ({ ok: false, reason });

  return (hello) => {
    const cx = hello.codex;
    if (!cx || cx.thread_id !== hello.agent_ref)
      return no("codex hello does not name its thread");
    const home = deps.home ?? codexHome();
    const thread = cx.thread_id;
    const p = cx.ppid;
    // 1. Parent: the claimed ppid is the adapter's real parent, and it is codex.
    if (parent(hello.pid) !== p) return no(CODEX_REFUSALS.notCodex);
    if (basename(comm(p) ?? "") !== "codex") return no(CODEX_REFUSALS.notCodex);
    const start = procStart(p);
    if (!start) return no(CODEX_REFUSALS.notCodex);
    const was = pinned.get(p);
    if (was !== undefined && was !== start) {
      // A reused pid: forget the old process, so the next call proves itself afresh.
      pinned.delete(p);
      for (const k of proofs.keys())
        if (k.startsWith(`${p}\0`)) proofs.delete(k);
      return no(CODEX_REFUSALS.restarted);
    }
    const key = `${p}\0${start}\0${thread}`;
    let proof = proofs.get(key);
    if (!proof) {
      // 2. Lock: P has the thread loaded.
      const lock = join(home, "thread-writer-locks", `${thread}.lock`);
      if (!holds(p, lock)) return no(CODEX_REFUSALS.notLoaded);
      // 4. Not a subagent: the db decides; the rollout's session_meta when it can't.
      const row = threadRow(home, thread);
      const rollout = row?.rollout_path ?? globRollout(home, thread);
      if (!rollout) return no(CODEX_REFUSALS.callNotFound);
      const meta = sessionMeta(rollout, thread);
      if (!meta) return no(CODEX_REFUSALS.callNotFound);
      if (
        isSubagent(row ? row.source : meta.source) ||
        isSubagent(meta.source) ||
        SPAWNED_SOURCES.has(String(meta.thread_source))
      )
        return no(CODEX_REFUSALS.subagent);
      // The rollout's cwd is the thread's; the adapter's is a workspace guess.
      if (typeof meta.cwd !== "string" || !isAbsolute(meta.cwd))
        return no(CODEX_REFUSALS.callNotFound);
      proof = { rollout, cwd: meta.cwd };
      // Pinned only once P proved it hosts the thread.
      pinned.set(p, start);
      proofs.set(key, proof);
    }
    // The hint is never enough, but an honest one saying subagent is believed.
    if (SPAWNED_SOURCES.has(cx.thread_source))
      return no(CODEX_REFUSALS.subagent);
    // 3. Call: this call id is in flight in this thread, and new to us.
    const seen = used.get(thread) ?? new Set<string>();
    if (seen.has(cx.call_id)) return no(CODEX_REFUSALS.callNotFound);
    if (callState(proof.rollout, cx.call_id) !== "open")
      return no(CODEX_REFUSALS.callNotFound);
    seen.add(cx.call_id);
    used.set(thread, seen);
    return { ok: true, cwd: proof.cwd, pid: p };
  };
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/** `source` as Codex stores it: a string (`exec`, `cli`), or `{"subagent":…}`, raw or as JSON text. */
export function isSubagent(source: unknown): boolean {
  let s = source;
  if (typeof s === "string" && s.trimStart().startsWith("{"))
    try {
      s = JSON.parse(s);
    } catch {
      return true;
    }
  if (typeof s === "string") return s === "subagent";
  return record(s)?.subagent !== undefined;
}

type ThreadRow = { rollout_path: string | undefined; source: unknown };

/**
 * The thread's row in `state_5.sqlite`, read-only. Not `immutable=1`: the db
 * is in WAL mode and a new thread's row may be only in the WAL. Undefined when
 * the db or the row can't be read; node:sqlite is built in, so no new dependency.
 */
export function threadRow(home: string, thread: string): ThreadRow | undefined {
  try {
    const sqlite = process.getBuiltinModule?.("node:sqlite") as
      | typeof import("node:sqlite")
      | undefined;
    if (!sqlite) return undefined;
    const db = new sqlite.DatabaseSync(join(home, "state_5.sqlite"), {
      readOnly: true,
    });
    try {
      const row = db
        .prepare("SELECT rollout_path, source FROM threads WHERE id = ?")
        .get(thread) as
        | { rollout_path?: unknown; source?: unknown }
        | undefined;
      if (!row) return undefined;
      const path = row.rollout_path;
      return {
        rollout_path:
          typeof path === "string" && isAbsolute(path) ? path : undefined,
        source: row.source,
      };
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** `sessions/YYYY/MM/DD/rollout-*-<thread>.jsonl`, the newest when several. */
export function globRollout(home: string, thread: string): string | undefined {
  const suffix = `-${thread}.jsonl`;
  const dirs = (d: string) => {
    try {
      return readdirSync(d).sort().reverse();
    } catch {
      return [];
    }
  };
  const root = join(home, "sessions");
  for (const y of dirs(root))
    for (const m of dirs(join(root, y)))
      for (const d of dirs(join(root, y, m)))
        for (const f of dirs(join(root, y, m, d)))
          if (f.startsWith("rollout-") && f.endsWith(suffix))
            return join(root, y, m, d, f);
  return undefined;
}

/** The rollout's first line, when it is this thread's session_meta. */
export function sessionMeta(
  path: string,
  thread: string,
): Record<string, unknown> | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const parts: Buffer[] = [];
    let pos = 0;
    while (pos < META_CAP) {
      const buf = Buffer.alloc(CHUNK);
      const n = readSync(fd, buf, 0, CHUNK, pos);
      if (n === 0) break;
      const nl = buf.subarray(0, n).indexOf(10);
      parts.push(buf.subarray(0, nl < 0 ? n : nl));
      if (nl >= 0) break;
      pos += n;
    }
    const line = record(JSON.parse(Buffer.concat(parts).toString("utf8")));
    const payload = record(line?.payload);
    if (line?.type !== "session_meta" || payload?.id !== thread)
      return undefined;
    return payload;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether `callId` is an unanswered openbus function_call in the rollout.
 * Reads backwards from the end, a chunk at a time, and stops at the call: an
 * output seen first (later in the file) means it was answered.
 */
export function callState(
  path: string,
  callId: string,
): "open" | "answered" | "absent" {
  let state: "open" | "answered" | "absent" = "absent";
  const visit = (text: string): boolean => {
    if (!text.includes(callId)) return false;
    let line: Record<string, unknown> | undefined;
    try {
      line = record(JSON.parse(text));
    } catch {
      return false;
    }
    const p = record(line?.payload);
    if (!p || p.call_id !== callId || typeof p.type !== "string") return false;
    if (line?.type === "response_item" && p.type === "function_call") {
      const ours =
        p.namespace === OPENBUS_NAMESPACE ||
        (p.namespace === undefined &&
          typeof p.name === "string" &&
          p.name.startsWith(`${OPENBUS_NAMESPACE}__`));
      state = ours ? "open" : "absent";
      return true;
    }
    if (p.type.endsWith("_output") || p.type.endsWith("_end")) {
      state = "answered";
      return true;
    }
    return false;
  };
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "absent";
  }
  try {
    let pos = fstatSync(fd).size;
    const floor = Math.max(0, pos - TAIL_CAP);
    let carry = Buffer.alloc(0);
    while (pos > floor) {
      const n = Math.min(CHUNK, pos - floor);
      pos -= n;
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, pos);
      const data = carry.length ? Buffer.concat([buf, carry]) : buf;
      let end = data.length;
      for (let i = data.length - 1; i >= 0; i -= 1) {
        if (data[i] !== 10) continue;
        if (end > i + 1 && visit(data.toString("utf8", i + 1, end)))
          return state;
        end = i;
      }
      carry = data.subarray(0, end);
    }
    // The first line has no newline before it.
    if (pos === 0 && carry.length) visit(carry.toString("utf8"));
    return state;
  } finally {
    closeSync(fd);
  }
}

const ps = (field: string, pid: number): string | null => {
  try {
    return (
      execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
};

const parentOf = (pid: number): number | null => {
  const ppid = Number(ps("ppid", pid));
  return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
};

const commOf = (pid: number): string | null => ps("comm", pid);

/** Whether `pid` holds `file` open: `lsof -t` (macOS), or /proc (Linux). */
export function holdsFile(pid: number, file: string): boolean {
  if (process.platform === "linux") return holdsFileLinux(pid, file);
  try {
    const out = execFileSync("lsof", ["-t", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return out.split("\n").some((l) => Number(l.trim()) === pid);
  } catch {
    // lsof exits 1 when no process has it open.
    return false;
  }
}

/**
 * Linux: the file's inode has a lock in /proc/locks, and one of P's fds is
 * that file. /proc/locks' pid is the locker, which may be a forked child, so
 * the fd decides who holds it.
 */
export function holdsFileLinux(
  pid: number,
  file: string,
  procRoot = "/proc",
): boolean {
  try {
    const st = statSync(file);
    const locked = readFileSync(join(procRoot, "locks"), "utf8")
      .split("\n")
      .some((l) => {
        // `1: FLOCK  ADVISORY  WRITE 1234 08:01:131074 0 EOF`
        const dev = l.trim().split(/\s+/)[5];
        return dev?.split(":")[2] === String(st.ino);
      });
    if (!locked) return false;
    const fds = join(procRoot, String(pid), "fd");
    return readdirSync(fds).some((fd) => {
      try {
        const f = statSync(join(fds, fd));
        return f.ino === st.ino && f.dev === st.dev;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
