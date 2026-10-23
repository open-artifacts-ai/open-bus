import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ClaudeSession = {
  pid: number;
  sessionId: string;
  /** Null when cross-session messaging is off: the session can send, not receive. */
  socketPath: string | null;
  peerToken: string | null;
  name: string;
};

export type SessionDeps = {
  sessionsDir: string;
  ancestors: (pid: number) => number[];
  procStart: (pid: number) => string | null;
  sha256?: (s: string) => string;
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The peerToken Claude published for this pid and socket, or null. */
export function peerTokenFor(
  pid: number,
  socketPath: string,
  dir: string,
  hash: (s: string) => string = sha256,
): string | null {
  try {
    const key = JSON.parse(
      readFileSync(join(dir, `${pid}.${hash(socketPath)}.key`), "utf8"),
    ) as { peerToken?: unknown };
    return typeof key.peerToken === "string" && key.peerToken
      ? key.peerToken
      : null;
  } catch {
    return null;
  }
}

/**
 * The Claude session this process runs under. Like the daemon's attestation,
 * the nearest ancestor with a session file owns it; an outer one never does.
 */
export function findSession(
  pid: number,
  deps: SessionDeps,
): ClaudeSession | null {
  for (const anc of deps.ancestors(pid)) {
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(
        readFileSync(join(deps.sessionsDir, `${anc}.json`), "utf8"),
      );
    } catch {
      continue;
    }
    if (typeof rec?.sessionId !== "string") continue;
    const start = deps.procStart(anc);
    if (!start || (rec.procStart && rec.procStart !== start)) return null;
    const socketPath =
      typeof rec.messagingSocketPath === "string"
        ? rec.messagingSocketPath
        : null;
    const peerToken =
      socketPath &&
      peerTokenFor(anc, socketPath, deps.sessionsDir, deps.sha256);
    return {
      pid: anc,
      sessionId: rec.sessionId,
      socketPath,
      peerToken,
      name: typeof rec.name === "string" ? rec.name : `claude-${anc}`,
    };
  }
  return null;
}

const ps = (field: string, pid: number): string | null => {
  try {
    return (
      execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        // Claude writes procStart as `TZ=UTC LC_ALL=C ps -o lstart=`.
        env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
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
