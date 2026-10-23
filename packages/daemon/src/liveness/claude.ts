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

/**
 * Claude sessions that can take a message now, from `~/.claude/sessions`: a
 * running process whose start time matches, with a wire-valid id. One with no
 * socket (cross-session messaging off) can still send; it just cannot receive.
 */
export function liveClaudeSessions(deps: ClaudeLivenessDeps): LiveClaude[] {
  const out: LiveClaude[] = [];
  let names: string[];
  try {
    names = readdirSync(deps.dir);
  } catch {
    return out;
  }
  for (const fn of names) {
    if (!/^\d+\.json$/.test(fn)) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(readFileSync(join(deps.dir, fn), "utf8"));
    } catch {
      continue;
    }
    const pid = Number(rec?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    if (rec.parkedJobId !== undefined || rec.agentBus) continue;
    if (!AgentRefSchema.safeParse(rec.sessionId).success) continue;
    if (!deps.isRunning(pid)) continue;
    const start = deps.procStart(pid);
    if (!start || (rec.procStart && rec.procStart !== start)) continue;
    out.push({
      ref: String(rec.sessionId),
      name: typeof rec.name === "string" ? rec.name : `claude-${pid}`,
      pid,
      socketPath:
        typeof rec.messagingSocketPath === "string"
          ? rec.messagingSocketPath
          : "",
      cwd: typeof rec.cwd === "string" ? rec.cwd : "",
    });
  }
  return out;
}

/** Where to inject for a live session, read fresh each time; null when it is gone. */
export function claudeTarget(
  ref: string,
  deps: ClaudeLivenessDeps,
): { socketPath: string; peerToken: string } | null {
  const s = liveClaudeSessions(deps).find((x) => x.ref === ref);
  if (!s?.socketPath) return null;
  const peerToken = peerTokenFor(s.pid, s.socketPath, deps.dir, deps.sha256);
  return peerToken ? { socketPath: s.socketPath, peerToken } : null;
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
