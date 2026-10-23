import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  ancestorChain,
  claudeSessionsDir,
  procStartOf,
} from "@ob/adapter-claude-code";
import type { Hello } from "@ob/ipc";
import { isRunning } from "./liveness/claude.ts";
import {
  lstartEpoch,
  opencodePresenceDir,
  openSessions,
} from "./presence/opencode.ts";

export { ancestorChain, procStartOf };

export type AttestDeps = {
  sessionsDir?: string;
  ancestors?: (pid: number) => number[];
  procStart?: (pid: number) => string | null;
  openSessions?: () => Set<string>;
};

/**
 * `cwd` is the session's own working directory, when the harness records one;
 * `pid` is the session's process when it is not the adapter (Claude's MCP server).
 */
export type Attest =
  | { ok: true; cwd?: string; pid?: number }
  | { ok: false; reason: string };

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
      if (!hello.attest.proc_start) {
        return { ok: false, reason: "pi hello has no proc_start" };
      }
      const start = (deps.procStart ?? procStartOf)(hello.pid);
      if (!start) return { ok: false, reason: "pi process is not running" };
      if (hello.attest.proc_start !== start) {
        return { ok: false, reason: "pi process start time moved" };
      }
      return { ok: true };
    }
  }
}

function attestClaude(hello: Hello, deps: AttestDeps): Attest {
  const dir = deps.sessionsDir ?? claudeSessionsDir();
  for (const pid of (deps.ancestors ?? ancestorChain)(hello.pid)) {
    let raw:
      | { sessionId?: unknown; procStart?: unknown; cwd?: unknown }
      | undefined;
    try {
      raw = JSON.parse(readFileSync(join(dir, `${pid}.json`), "utf8"));
    } catch {
      continue;
    }
    if (typeof raw?.sessionId !== "string") continue;
    // The nearest session owns this process; an outer (ancestor) session is never claimable.
    if (raw.sessionId !== hello.agent_ref) {
      return {
        ok: false,
        reason: "agent_ref does not match a live Claude session",
      };
    }
    // Without procStart a reused pid is indistinguishable from the session.
    if (typeof raw.procStart !== "string") {
      return { ok: false, reason: "Claude session has no procStart" };
    }
    const start = (deps.procStart ?? procStartOf)(pid);
    if (!start) return { ok: false, reason: "session process is not running" };
    if (raw.procStart !== start) {
      return { ok: false, reason: "session process start time moved" };
    }
    if (typeof raw.cwd !== "string" || !isAbsolute(raw.cwd)) {
      return { ok: false, reason: "Claude session has no absolute cwd" };
    }
    return { ok: true, cwd: raw.cwd, pid };
  }
  return { ok: false, reason: "no Claude session in the ancestry" };
}

function defaultOpenSessions(): Set<string> {
  return openSessions(opencodePresenceDir(), {
    isRunning,
    procStartEpoch: (pid) => lstartEpoch(procStartOf(pid)),
  });
}
