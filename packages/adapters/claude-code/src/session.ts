import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fitName, Hello } from "@ob/ipc";

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

/** The one place the Claude sessions dir is chosen: MCP server, attestation and liveness. */
export const claudeSessionsDir = (
  env: Record<string, string | undefined> = process.env,
): string =>
  env.OPENBUS_CLAUDE_SESSIONS_DIR || join(homedir(), ".claude", "sessions");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The peerToken Claude published for this pid and socket, or null. The key
 * must name the session's own procStart: one left by an earlier process is stale.
 */
export function peerTokenFor(
  pid: number,
  socketPath: string,
  dir: string,
  procStart: string,
  hash: (s: string) => string = sha256,
): string | null {
  try {
    const key = JSON.parse(
      readFileSync(join(dir, `${pid}.${hash(socketPath)}.key`), "utf8"),
    ) as { peerToken?: unknown; procStart?: unknown };
    return typeof key.peerToken === "string" &&
      key.peerToken &&
      key.procStart === procStart
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
    // No procStart, no way to tell this process from a reused pid.
    if (typeof rec.procStart !== "string") return null;
    const start = deps.procStart(anc);
    if (!start || rec.procStart !== start) return null;
    const socketPath =
      typeof rec.messagingSocketPath === "string"
        ? rec.messagingSocketPath
        : null;
    const peerToken =
      socketPath &&
      peerTokenFor(anc, socketPath, deps.sessionsDir, start, deps.sha256);
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

/** The MCP server's hello for its session; a name that cannot go on the wire is fitted, never fatal. */
export function sessionHello(
  session: ClaudeSession,
  pid: number,
  cwd: string,
): Hello {
  return Hello.parse({
    v: 1,
    id: "hello",
    type: "hello",
    kind: "claude-code",
    agent_ref: session.sessionId,
    pid,
    cwd,
    proposed_name: fitName(session.name, 64) || undefined,
    attest: {
      session_id: session.sessionId,
      socket_path: session.socketPath ?? undefined,
    },
  });
}
