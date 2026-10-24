import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
 * How an entry is stored and shown: the volume's own case and spelling
 * (`realpathSync.native`). Never compared as a string: membership is by
 * identity (isGlobalDir). Throws when `path` does not resolve.
 */
export const canonicalPath = (path: string): string =>
  realpathSync.native(path);

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

/** A directory's identity: the same folder however its path is spelled. */
const idOf = (path: string): string | undefined => {
  try {
    const st = statSync(path);
    return st.isDirectory() ? `${st.dev}:${st.ino}` : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether `dir` is an entry or lies under one: `dir` or one of its ancestors
 * is the same directory (device and inode) as an entry. No string folding,
 * so two folders a case- or normalization-sensitive volume keeps apart never
 * match. A missing entry covers nothing.
 */
export function isGlobalDir(dir: string, dirs: string[]): boolean {
  const ids = new Set(dirs.map(idOf).filter((id) => id !== undefined));
  if (ids.size === 0) return false;
  for (let d = resolve(dir); ; d = dirname(d)) {
    const id = idOf(d);
    if (id !== undefined && ids.has(id)) return true;
    if (dirname(d) === d) return false;
  }
}

/** Whether `a` and `b` are the same directory. */
export const sameDir = (a: string, b: string): boolean => {
  const id = idOf(a);
  return id !== undefined && id === idOf(b);
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
