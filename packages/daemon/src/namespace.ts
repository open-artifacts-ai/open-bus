import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  CONFIG_FILE,
  mergeConfigs,
  namespaceFrom,
  normalizeRemote,
  type OpenBusConfig,
  OpenBusConfigSchema,
} from "@ob/shared";
import { globalFile, isGlobalDir, readGlobalDirs } from "./global.ts";

export type Namespace = {
  namespace: string;
  global: boolean;
  source: "config" | "git" | "dir" | "cwd";
};

export type NamespaceDeps = {
  gitRemote?: (dir: string) => string | null;
  gitRoot?: (dir: string) => string | null;
  log?: (msg: string) => void;
  /** Owner a config file must have; defaults to this process's uid. */
  uid?: number;
  /** A cwd that no longer exists is used unresolved instead of throwing. */
  allowMissing?: boolean;
  /** The user's allowlist; default `<OPENBUS_HOME>/global.json`. */
  globalFile?: string;
};

const warned = new Set<string>();

/** Logs `msg` once per key for the life of the process. */
const once = (deps: NamespaceDeps, key: string, msg: string) => {
  if (warned.has(key)) return;
  warned.add(key);
  deps.log?.(msg);
};

/**
 * The namespace: every `.openbus.json` from the real cwd up (nearest wins per
 * key); else the shared fallback chain. Global comes only from the user's
 * allowlist; a `global` in `.openbus.json` is ignored. Throws if cwd does not
 * resolve, unless allowMissing.
 */
export function resolveNamespace(
  start: string,
  deps: NamespaceDeps = {},
): Namespace {
  let cwd: string;
  try {
    cwd = realpathSync(start);
  } catch (e) {
    if (!deps.allowMissing) throw e;
    cwd = resolve(start);
    if (!warned.has(cwd)) {
      warned.add(cwd);
      deps.log?.(`${cwd} does not resolve; using it as given`);
    }
  }
  const uid = deps.uid ?? process.getuid?.();
  const configs: OpenBusConfig[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    const file = join(dir, CONFIG_FILE);
    let text: string | undefined;
    let fd: number | undefined;
    try {
      // Another user could plant one in a shared parent such as /tmp. One
      // open, never following a symlink: the file checked is the file read.
      // Non-blocking, so a planted FIFO cannot hang the open.
      fd = openSync(
        file,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      const st = fstatSync(fd);
      if ((uid !== undefined && st.uid !== uid) || st.mode & 0o022) {
        if (!warned.has(file)) {
          warned.add(file);
          deps.log?.(
            `ignoring ${file}: not owned by you or writable by others`,
          );
        }
      } else if (st.isFile()) text = readFileSync(fd, "utf8");
    } catch {
      /* absent, a symlink, or unreadable */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (text !== undefined) {
      let parsed: ReturnType<typeof OpenBusConfigSchema.safeParse> | undefined;
      try {
        parsed = OpenBusConfigSchema.safeParse(JSON.parse(text));
      } catch {}
      if (parsed?.success) {
        configs.push(parsed.data);
        // A repo anyone can write to must not widen what its agents see.
        if (parsed.data.global === true)
          once(
            deps,
            `global:${file}`,
            `ignoring global in ${file}: only \`npx @open-bus/cli global add\` makes a directory global`,
          );
      } else deps.log?.(`ignoring invalid ${file}`);
    }
    if (dirname(dir) === dir) break;
  }
  const cfg = mergeConfigs(configs);
  const list = readGlobalDirs(deps.globalFile ?? globalFile());
  if (list.error)
    once(
      deps,
      `allowlist:${list.error}`,
      `${list.error}: no directory is global`,
    );
  const global = isGlobalDir(cwd, list.dirs);
  if (cfg.namespace)
    return { namespace: cfg.namespace, global, source: "config" };

  const remoteUrl = (deps.gitRemote ?? gitRemote)(cwd);
  const root = (deps.gitRoot ?? gitRoot)(cwd);
  const namespace = namespaceFrom({
    remoteUrl,
    gitRootName: root ? basename(root) : null,
    cwd,
  });
  const source =
    remoteUrl && normalizeRemote(remoteUrl) ? "git" : root ? "dir" : "cwd";
  return { namespace, global, source };
}

const git = (cwd: string, args: string[]): string | null => {
  try {
    return (
      execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
};
const gitRemote = (cwd: string) => git(cwd, ["remote", "get-url", "origin"]);
const gitRoot = (cwd: string) => git(cwd, ["rev-parse", "--show-toplevel"]);
