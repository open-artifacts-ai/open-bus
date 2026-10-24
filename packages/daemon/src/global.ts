import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { home } from "./config.ts";
import { readOwnFile } from "./own-file.ts";

/**
 * The user's global allowlist, `<OPENBUS_HOME>/global.json`: `{"dirs": [...]}`,
 * each an absolute realpath. The only source of `global`: a repo's
 * `.openbus.json` never grants it, so an untrusted clone cannot widen its reach.
 */
export const globalFile = (h = home()): string => join(h, "global.json");

/** `error` completes "<file> …": why the file grants nothing. */
export type GlobalDirs = { dirs: string[]; error?: string };

/**
 * One form for every comparison: the volume's own case and spelling
 * (`realpathSync.native`), in NFC. Throws when `path` does not resolve.
 */
export const canonicalPath = (path: string): string =>
  realpathSync.native(path).normalize("NFC");

/**
 * The allowlist. None when the file is missing; none with `error` (why it
 * cannot be used) when it is unreadable, malformed, or not safely ours: a
 * symlink, a FIFO, another user's, or writable by others.
 */
export function readGlobalDirs(file = globalFile()): GlobalDirs {
  const own = readOwnFile(file);
  if (own.state === "none") return { dirs: [] };
  if (own.state === "unsafe") return { dirs: [], error: own.why };
  try {
    const raw = JSON.parse(own.text) as { dirs?: unknown } | null;
    const dirs = raw?.dirs;
    if (
      !Array.isArray(raw) &&
      Array.isArray(dirs) &&
      dirs.every((d) => typeof d === "string" && isAbsolute(d))
    )
      return { dirs: dirs as string[] };
  } catch {}
  return { dirs: [], error: "is not valid JSON" };
}

/** Whether `dir` (a canonicalPath) is an entry or lies under one, on a path-segment boundary. */
export const isGlobalDir = (dir: string, dirs: string[]): boolean => {
  const d = dir.normalize("NFC");
  return dirs.some((entry) => {
    const e = entry.normalize("NFC");
    return d === e || d.startsWith(e.endsWith(sep) ? e : `${e}${sep}`);
  });
};

/**
 * Replaces the allowlist: 0600, written to a new file then renamed, never
 * through a symlink. Readers always see a whole file; two `global add`s at
 * once may lose one, since the last rename wins.
 */
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
