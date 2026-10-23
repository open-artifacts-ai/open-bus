import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { peerTokenFor } from "@ob/adapter-claude-code";
import { AgentRefSchema } from "@ob/shared";

export type LiveClaude = {
  ref: string;
  name: string;
  pid: number;
  socketPath: string;
  cwd: string;
};

export type ClaudeLivenessDeps = {
  dir: string;
  procStart: (pid: number) => string | null;
  isRunning: (pid: number) => boolean;
  sha256?: (s: string) => string;
};

type SessionFile = LiveClaude & { procStart: string };

/** Every well-formed session file, without asking the OS anything. */
function sessionFiles(dir: string): SessionFile[] {
  const out: SessionFile[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const fn of names) {
    if (!/^\d+\.json$/.test(fn)) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(readFileSync(join(dir, fn), "utf8"));
    } catch {
      continue;
    }
    const pid = Number(rec?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    if (rec.parkedJobId !== undefined || rec.agentBus) continue;
    if (!AgentRefSchema.safeParse(rec.sessionId).success) continue;
    // Without procStart a reused pid is indistinguishable from the session.
    if (typeof rec.procStart !== "string") continue;
    out.push({
      ref: String(rec.sessionId),
      name: typeof rec.name === "string" ? rec.name : `claude-${pid}`,
      pid,
      socketPath:
        typeof rec.messagingSocketPath === "string"
          ? rec.messagingSocketPath
          : "",
      cwd: typeof rec.cwd === "string" ? rec.cwd : "",
      procStart: rec.procStart,
    });
  }
  return out;
}

const alive = (s: SessionFile, deps: ClaudeLivenessDeps) =>
  deps.isRunning(s.pid) && deps.procStart(s.pid) === s.procStart;

const strip = ({ procStart: _, ...s }: SessionFile): LiveClaude => s;

/**
 * Claude sessions that are running now, from `~/.claude/sessions`: the process
 * is up and its start time matches. One with no socket (cross-session
 * messaging off) can still send; it just cannot receive.
 */
export function liveClaudeSessions(deps: ClaudeLivenessDeps): LiveClaude[] {
  return sessionFiles(deps.dir)
    .filter((s) => alive(s, deps))
    .map(strip);
}

/** Where to inject for one session, read fresh each time; null when it is gone. Asks the OS about that session only. */
export function claudeTarget(
  ref: string,
  deps: ClaudeLivenessDeps,
): { socketPath: string; peerToken: string } | null {
  const s = sessionFiles(deps.dir).find(
    (x) => x.ref === ref && x.socketPath && alive(x, deps),
  );
  if (!s) return null;
  const peerToken = peerTokenFor(
    s.pid,
    s.socketPath,
    deps.dir,
    s.procStart,
    deps.sha256,
  );
  return peerToken ? { socketPath: s.socketPath, peerToken } : null;
}

/** One `ps` per process lifetime: the start of a running pid never changes. */
export function cachedProcStart(
  procStart: (pid: number) => string | null,
  running: (pid: number) => boolean,
): (pid: number) => string | null {
  const cache = new Map<number, string>();
  return (pid) => {
    if (!running(pid)) {
      cache.delete(pid);
      return null;
    }
    let start = cache.get(pid);
    if (start === undefined) {
      start = procStart(pid) ?? undefined;
      if (start !== undefined) cache.set(pid, start);
    }
    return start ?? null;
  };
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
