import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// The block between the markers is copied byte for byte into the Pi
// extension (assets/openbus.ts), which cannot import it; a test keeps them equal.
// <socket-path>
/** sun_path holds 104 bytes on macOS and 108 on Linux, NUL included. */
export const MAX_SOCKET_PATH = process.platform === "linux" ? 107 : 103;

/** `p` with its deepest existing ancestor resolved: the same before and after `p` exists. */
function realish(p: string): string {
  const rest: string[] = [];
  for (let cur = p; ; cur = dirname(cur)) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch {
      if (dirname(cur) === cur) return p;
      rest.unshift(basename(cur));
    }
  }
}

/**
 * The short per-user folder for sockets that would not fit under `home`.
 * Always /tmp, never $TMPDIR: a launchd daemon and an MCP server started
 * from a terminal see different TMPDIRs, and both must name the same path.
 */
export function shortSocketDir(home: string): string {
  const hash = createHash("sha256").update(realish(home)).digest("hex");
  return join("/tmp", `openbus-${process.getuid?.() ?? 0}-${hash.slice(0, 8)}`);
}

/** Where the daemon listens: `<home>/daemon.sock`, unless that is too long for a unix socket. */
export function daemonSocketPath(home: string): string {
  const plain = join(home, "daemon.sock");
  return Buffer.byteLength(plain) <= MAX_SOCKET_PATH
    ? plain
    : join(shortSocketDir(home), "daemon.sock");
}

/**
 * Why a short socket folder must not be used ("is a symlink"), or null when it is safe.
 * Another local user could create it first, so it must be a real folder,
 * ours, and 0700. A missing folder is safe: the daemon creates it.
 */
export function unsafeSocketDir(dir: string): string | null {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dir);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return "is a symlink";
  if (!st.isDirectory()) return "is not a folder";
  if (st.uid !== process.getuid?.()) return "belongs to another user";
  if ((st.mode & 0o777) !== 0o700)
    return `is open to other users (mode ${(st.mode & 0o777).toString(8)})`;
  return null;
}

/** Why the daemon socket for `home` must not be dialed or bound, or null. */
export function socketDirProblem(home: string): string | null {
  const dir = shortSocketDir(home);
  if (dirname(daemonSocketPath(home)) !== dir) return null;
  const why = unsafeSocketDir(dir);
  return why && `${dir} ${why}`;
}
// </socket-path>
