import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Hello } from "@ob/ipc";

export type AttestDeps = {
  sessionsDir?: string;
  ancestors?: (pid: number) => number[];
  procStart?: (pid: number) => string | null;
  openSessions?: () => Set<string>;
};

export type Attest = { ok: true } | { ok: false; reason: string };

/** Verifies the adapter's claimed identity locally; the hello alone is never trusted. */
export function attest(hello: Hello, deps: AttestDeps = {}): Attest {
  switch (hello.kind) {
    case "claude-code":
      return attestClaude(hello, deps);
    case "opencode":
      return (deps.openSessions ?? defaultOpenSessions)().has(hello.agent_ref)
        ? { ok: true }
        : { ok: false, reason: "opencode session is not open in a TUI" };
    case "pi": {
      const start = (deps.procStart ?? procStartOf)(hello.pid);
      if (!start) return { ok: false, reason: "pi process is not running" };
      if (hello.attest.proc_start && hello.attest.proc_start !== start) {
        return { ok: false, reason: "pi process start time moved" };
      }
      return { ok: true };
    }
  }
}

function attestClaude(hello: Hello, deps: AttestDeps): Attest {
  const dir = deps.sessionsDir ?? join(homedir(), ".claude", "sessions");
  let sawAny = false;
  for (const pid of (deps.ancestors ?? ancestorChain)(hello.pid)) {
    let raw: { sessionId?: unknown; procStart?: unknown } | undefined;
    try {
      raw = JSON.parse(readFileSync(join(dir, `${pid}.json`), "utf8"));
    } catch {
      continue;
    }
    if (typeof raw?.sessionId !== "string") continue;
    sawAny = true;
    if (raw.sessionId !== hello.agent_ref) continue;
    const start = (deps.procStart ?? procStartOf)(pid);
    if (!start) return { ok: false, reason: "session process is not running" };
    if (raw.procStart && raw.procStart !== start) {
      return { ok: false, reason: "session process start time moved" };
    }
    return { ok: true };
  }
  return {
    ok: false,
    reason: sawAny
      ? "agent_ref does not match a live Claude session"
      : "no Claude session in the ancestry",
  };
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

export function ancestorChain(pid: number): number[] {
  const out: number[] = [];
  let cur = pid;
  for (let i = 0; i < 12 && cur > 1; i += 1) {
    out.push(cur);
    const ppid = Number(ps("ppid", cur));
    if (!ppid || ppid === cur) break;
    cur = ppid;
  }
  return out;
}

export const procStartOf = (pid: number): string | null => ps("lstart", pid);

function defaultOpenSessions(): Set<string> {
  // C6 replaces this with the presence reader; until then, no OpenCode session is attested.
  return new Set();
}
