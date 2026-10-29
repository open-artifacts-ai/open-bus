import { existsSync } from "node:fs";

/** Where the OS keeps its own tools (macOS lsof is in /usr/sbin, ps in /bin). */
const SYSTEM_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const found = new Map<string, string>();

/**
 * The absolute path of system tool `name` (ps, lsof), found in the OS
 * directories and not on PATH: the launchd service's PATH has no sbin, and a
 * directory earlier on PATH could shadow it. Falls back to the bare name.
 */
export function systemTool(
  name: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const hit = found.get(name);
  if (hit) return hit;
  const path = SYSTEM_DIRS.map((d) => `${d}/${name}`).find(exists);
  if (path) found.set(name, path);
  return path ?? name;
}
