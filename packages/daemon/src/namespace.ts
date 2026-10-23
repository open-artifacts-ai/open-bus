import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  CONFIG_FILE,
  mergeConfigs,
  namespaceFrom,
  normalizeRemote,
  type OpenBusConfig,
  OpenBusConfigSchema,
} from "@ob/shared";

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
};

const warned = new Set<string>();

/**
 * Every `.openbus.json` from the real cwd up (nearest wins per key); else the
 * shared fallback chain. Throws if cwd does not resolve, unless allowMissing.
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
    try {
      // Another user could plant one in a shared parent such as /tmp.
      const st = statSync(file);
      if ((uid !== undefined && st.uid !== uid) || st.mode & 0o022) {
        if (!warned.has(file)) {
          warned.add(file);
          deps.log?.(
            `ignoring ${file}: not owned by you or writable by others`,
          );
        }
      } else text = readFileSync(file, "utf8");
    } catch {
      /* absent or unreadable */
    }
    if (text !== undefined) {
      let parsed: ReturnType<typeof OpenBusConfigSchema.safeParse> | undefined;
      try {
        parsed = OpenBusConfigSchema.safeParse(JSON.parse(text));
      } catch {}
      if (parsed?.success) configs.push(parsed.data);
      else deps.log?.(`ignoring invalid ${file}`);
    }
    if (dirname(dir) === dir) break;
  }
  const cfg = mergeConfigs(configs);
  const global = cfg.global === true;
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
