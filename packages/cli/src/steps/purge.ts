import { lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Files OpenBus writes at the top of its home. */
const FILES = [
  "machine.json",
  "install.json",
  "daemon.sock",
  "sent.json",
  "claude-held.json",
  "opencode-uncertain.json",
  "revoked",
];
/** Leftovers of an interrupted atomic write or socket close. */
const TEMP = [
  /^\.machine\.json\.[0-9a-f]+\.tmp$/,
  /^(install|sent|claude-held|opencode-uncertain)\.json\.\d+\.tmp$/,
  // The adapters' atomic writes: <file>.<pid>.<hex>.tmp.
  /^install\.json\.\d+\.[0-9a-f]+\.tmp$/,
  /^daemon\.sock\.keep-\d+$/,
];
/**
 * Folders OpenBus creates, and what in them is OpenBus's. A folder goes only
 * once that leaves it empty; anything else in it stays.
 */
const FOLDERS: {
  path: string;
  ours: (name: string, path: string) => boolean;
}[] = [
  { path: "logs", ours: (n) => /^daemon(\.err)?\.log(\.\d+)?$/.test(n) },
  { path: "integrations/opencode", ours: (n) => n === "openbus" },
  { path: "integrations", ours: () => false },
  { path: "opencode-tui", ours: (n) => /^\d+\.json(\.\d+\.tmp)?$/.test(n) },
  {
    path: "claude-return",
    ours: (_n, p) => kind(p) === "socket",
  },
];

function kind(path: string): "dir" | "socket" | "other" | undefined {
  try {
    const st = lstatSync(path);
    return st.isDirectory() ? "dir" : st.isSocket() ? "socket" : "other";
  } catch {
    return undefined;
  }
}

const remove = (path: string, k: "dir" | "socket" | "other") =>
  rmSync(path, { recursive: k === "dir", force: true });

const rmdirIfEmpty = (path: string) => {
  try {
    rmdirSync(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * Removes only what OpenBus created in `home`, then `home` if that left it
 * empty. A home that is not the default ~/.openbus must hold machine.json or
 * install.json, or it is refused: it may be someone's folder.
 */
export function purge(
  home: string,
  opts: { isDefault: boolean },
): { refused: true } | { removed: string[]; leftDir: boolean } {
  let entries: string[];
  try {
    entries = readdirSync(home);
  } catch {
    return { removed: [], leftDir: false };
  }
  if (
    !opts.isDefault &&
    !entries.includes("machine.json") &&
    !entries.includes("install.json")
  )
    return { refused: true };
  const removed: string[] = [];
  for (const name of [
    ...FILES,
    ...entries.filter((n) => TEMP.some((re) => re.test(n))),
  ]) {
    const path = join(home, name);
    const k = kind(path);
    // A known file name that is a directory is not ours; a symlink is removed, never followed.
    if (k === undefined || k === "dir") continue;
    remove(path, k);
    removed.push(name);
  }
  for (const folder of FOLDERS) {
    const dir = join(home, folder.path);
    // A symlinked folder is someone's: never followed, never removed.
    if (kind(dir) !== "dir") continue;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const k = kind(path);
      if (k === undefined || !folder.ours(name, path)) continue;
      remove(path, k);
      removed.push(join(folder.path, name));
    }
    if (rmdirIfEmpty(dir)) removed.push(folder.path);
  }
  return { removed, leftDir: !rmdirIfEmpty(home) };
}
