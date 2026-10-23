import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
};

/** Every `.openbus.json` from cwd up (nearest wins per key); else the shared fallback chain. */
export function resolveNamespace(
  cwd: string,
  deps: NamespaceDeps = {},
): Namespace {
  const configs: OpenBusConfig[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const file = join(dir, CONFIG_FILE);
    let text: string | undefined;
    try {
      text = readFileSync(file, "utf8");
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
    cwd: resolve(cwd),
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
