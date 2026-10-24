import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { home } from "./config.ts";

/**
 * The user's global allowlist, `<OPENBUS_HOME>/global.json`: `{"dirs": [...]}`,
 * each an absolute realpath. The only source of `global`: a repo's
 * `.openbus.json` never grants it, so an untrusted clone cannot widen its reach.
 */
export const globalFile = (h = home()): string => join(h, "global.json");

export type GlobalDirs = { dirs: string[]; error?: string };

/** The allowlist; none when the file is missing, and none with `error` when it cannot be used. */
export function readGlobalDirs(file = globalFile()): GlobalDirs {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { dirs: [] }
      : { dirs: [], error: `cannot read ${file} (${code ?? String(e)})` };
  }
  try {
    const raw = JSON.parse(text) as { dirs?: unknown } | null;
    const dirs = raw?.dirs;
    if (
      !Array.isArray(raw) &&
      Array.isArray(dirs) &&
      dirs.every((d) => typeof d === "string" && isAbsolute(d))
    )
      return { dirs: dirs as string[] };
  } catch {}
  return { dirs: [], error: `${file} is malformed` };
}

/** Whether `dir` (a realpath) is an entry or lies under one, on a path-segment boundary. */
export const isGlobalDir = (dir: string, dirs: string[]): boolean =>
  dirs.some(
    (e) => dir === e || dir.startsWith(e.endsWith(sep) ? e : `${e}${sep}`),
  );

/** Replaces the allowlist: 0600, written to a new file then renamed, never through a symlink. */
export function writeGlobalDirs(dirs: string[], h = home()): void {
  mkdirSync(h, { recursive: true, mode: 0o700 });
  chmodSync(h, 0o700);
  const tmp = join(h, `.global.json.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ dirs }, null, 2)}\n`);
  } catch (e) {
    closeSync(fd);
    unlinkSync(tmp);
    throw e;
  }
  closeSync(fd);
  try {
    chmodSync(tmp, 0o600);
    // rename replaces a symlink at global.json rather than following it.
    renameSync(tmp, globalFile(h));
  } catch (e) {
    unlinkSync(tmp);
    throw e;
  }
}
