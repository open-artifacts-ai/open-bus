import { lstatSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Files OpenBus writes in its home, and the directories it owns outright. */
const FILES = [
  "machine.json",
  "config.json",
  "install.json",
  "daemon.sock",
  "sent.json",
  "claude-held.json",
  "opencode-uncertain.json",
];
const DIRS = ["integrations", "logs", "claude-return", "opencode-tui"];
/** Leftovers of an interrupted atomic write or socket close. */
const TEMP = [
  /^\.machine\.json\.[0-9a-f]+\.tmp$/,
  /^(install|sent|claude-held|opencode-uncertain)\.json\.\d+\.tmp$/,
  /^daemon\.sock\.keep-\d+$/,
];

const kind = (path: string) => {
  try {
    const st = lstatSync(path);
    return st.isDirectory() ? "dir" : "other";
  } catch {
    return undefined;
  }
};

/**
 * Removes only what OpenBus created in `home`, then `home` itself if that
 * left it empty. Never removes a directory it does not own: an
 * OPENBUS_HOME pointed at a real folder keeps everything else.
 */
export function purge(home: string): { removed: string[]; leftDir: boolean } {
  const removed: string[] = [];
  const names = new Set([...FILES, ...DIRS]);
  let entries: string[] = [];
  try {
    entries = readdirSync(home);
  } catch {
    return { removed, leftDir: false };
  }
  for (const name of entries)
    if (TEMP.some((re) => re.test(name))) names.add(name);
  for (const name of names) {
    const path = join(home, name);
    const k = kind(path);
    if (k === undefined) continue;
    // A known file name that is a directory is not ours; a symlink is removed, never followed.
    if (k === "dir" && !DIRS.includes(name)) continue;
    rmSync(path, { recursive: k === "dir", force: true });
    removed.push(name);
  }
  try {
    rmdirSync(home);
    return { removed, leftDir: false };
  } catch {
    return { removed, leftDir: true };
  }
}
