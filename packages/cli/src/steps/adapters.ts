import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type Doc,
  parseJsonc,
  removeMcpServer,
  removeOpencodeMcp,
  removePlugin,
  upsertMcpServer,
  upsertOpencodeMcp,
  upsertPlugin,
} from "@ob/adapter-mcp-json";
import {
  compareVersions,
  OPENCODE_TUI_PLUGIN,
  opencodeVersion,
} from "@ob/adapter-opencode";
import { PI_EXTENSION } from "@ob/adapter-pi";

export type Exec = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type Harness = "claude" | "opencode" | "pi";

export type AdapterDeps = {
  /** The user's home: harness configs live under it. */
  home: string;
  /** OpenBus home; defaults to `<home>/.openbus`. */
  openbusHome?: string;
  /** CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME, OPENCODE_CONFIG_DIR, PI_CODING_AGENT_DIR. */
  env?: Record<string, string | undefined>;
  openBusBin: string;
  assets: { pi: string; opencodePlugin: string };
  which: (cmd: string) => boolean;
  exec: Exec;
};

export type Skipped = { harness: Harness; reason: string };
export type InstallResult = {
  installed: Harness[];
  absent: Harness[];
  skipped: Skipped[];
  notes: string[];
};
export type UninstallResult = {
  removed: Harness[];
  skipped: Skipped[];
  notes: string[];
};

const NAME = "openbus";
const HARNESSES: Harness[] = ["claude", "opencode", "pi"];

/** The shipped Pi extension and OpenCode TUI plugin. */
export const readAssets = (): AdapterDeps["assets"] => ({
  pi: readFileSync(PI_EXTENSION, "utf8"),
  opencodePlugin: readFileSync(OPENCODE_TUI_PLUGIN, "utf8"),
});

const paths = (deps: AdapterDeps) => {
  const env = deps.env ?? {};
  const opencode =
    env.OPENCODE_CONFIG_DIR ??
    join(env.XDG_CONFIG_HOME ?? join(deps.home, ".config"), "opencode");
  const openbus = deps.openbusHome ?? join(deps.home, ".openbus");
  return {
    claude: join(env.CLAUDE_CONFIG_DIR ?? deps.home, ".claude.json"),
    opencodeConfig: join(opencode, "opencode.json"),
    opencodeCli: join(opencode, "cli.json"),
    // OpenCode registers the folder that holds tui.js.
    opencodePlugin: join(openbus, "integrations/opencode", NAME),
    pi: join(
      env.PI_CODING_AGENT_DIR ?? join(deps.home, ".pi/agent"),
      "extensions/openbus.ts",
    ),
  };
};

/** A missing file is an empty document; anything but a JSON object is refused. */
function readDoc(path: string): Doc {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  try {
    const doc: unknown = JSON.parse(text);
    if (typeof doc === "object" && doc !== null && !Array.isArray(doc))
      return doc as Doc;
  } catch {}
  throw new Error(`${path} is not a JSON object; left it untouched`);
}

/** Temp + rename beside the real file (through a symlink), keeping its mode. */
function writeAtomic(path: string, data: string, mode?: number) {
  const target = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true });
  let m = mode ?? 0o644;
  if (mode === undefined)
    try {
      m = statSync(target).mode & 0o777;
    } catch {}
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: m, flag: "wx" });
    chmodSync(tmp, m);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** OpenCode's JSONC configs as text: missing is empty, unparsable throws. */
function readJsonc(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
  parseJsonc(text, path);
  return text;
}

/** Writes `next` only when it differs; true if it did. */
function saveText(path: string, before: string, next: string): boolean {
  if (next === before) return false;
  writeAtomic(path, next);
  return true;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Writes `next` only when it differs; true if it did. */
function save(path: string, before: Doc, next: Doc): boolean {
  if (JSON.stringify(before) === JSON.stringify(next)) return false;
  writeAtomic(path, json(next));
  return true;
}

async function run(deps: AdapterDeps, cmd: string, args: string[]) {
  try {
    return await deps.exec(cmd, args);
  } catch (e) {
    return {
      code: -1,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
    };
  }
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

async function restartOpencode(deps: AdapterDeps, notes: string[]) {
  const r = await run(deps, "opencode", ["service", "restart"]);
  if (r.code !== 0)
    notes.push(`opencode service restart failed: ${firstLine(r.stderr)}`);
}

type Step = (
  deps: AdapterDeps,
  notes: string[],
) => Promise<"done" | "absent" | "none">;

const install: Record<Harness, Step> = {
  // Claude rewrites ~/.claude.json while it runs, so its own CLI does the edit.
  async claude(deps, notes) {
    if (!deps.which("claude")) return "absent";
    await run(deps, "claude", ["mcp", "remove", "--scope", "user", NAME]);
    const add = await run(deps, "claude", [
      "mcp",
      "add",
      "--scope",
      "user",
      NAME,
      "--",
      deps.openBusBin,
      "mcp",
      "claude",
    ]);
    if (add.code === 0) return "done";
    const path = paths(deps).claude;
    const doc = readDoc(path);
    save(
      path,
      doc,
      upsertMcpServer(doc, NAME, {
        type: "stdio",
        command: deps.openBusBin,
        args: ["mcp", "claude"],
        env: {},
      }),
    );
    notes.push(
      `claude mcp add failed (${firstLine(add.stderr)}); wrote ${path} directly`,
    );
    return "done";
  },

  async opencode(deps, notes) {
    if (!deps.which("opencode")) return "absent";
    const version = await opencodeVersion(deps.exec);
    if (version && (compareVersions(version, "2.0.0") ?? 0) < 0)
      throw new Error(`OpenBus needs OpenCode v2; found ${version}`);
    const p = paths(deps);
    const config = readJsonc(p.opencodeConfig);
    const cli = readJsonc(p.opencodeCli);
    const nextConfig = upsertOpencodeMcp(config, NAME, {
      type: "local",
      command: [deps.openBusBin, "mcp", "opencode"],
    });
    const nextCli = upsertPlugin(cli, p.opencodePlugin);
    writeAtomic(
      join(p.opencodePlugin, "tui.js"),
      deps.assets.opencodePlugin,
      0o644,
    );
    saveText(p.opencodeConfig, config, nextConfig);
    saveText(p.opencodeCli, cli, nextCli);
    await restartOpencode(deps, notes);
    return "done";
  },

  async pi(deps) {
    if (!deps.which("pi")) return "absent";
    writeAtomic(paths(deps).pi, deps.assets.pi, 0o644);
    return "done";
  },
};

// Uninstall works from the files, so it also cleans up after a harness the
// user removed first; the binaries are used only when present.
const uninstall: Record<Harness, Step> = {
  async claude(deps, notes) {
    if (deps.which("claude")) {
      const r = await run(deps, "claude", [
        "mcp",
        "remove",
        "--scope",
        "user",
        NAME,
      ]);
      if (r.code === 0) return "done";
    }
    const path = paths(deps).claude;
    const doc = readDoc(path);
    if (!save(path, doc, removeMcpServer(doc, NAME))) return "none";
    notes.push(`removed openbus from ${path} directly`);
    return "done";
  },

  async opencode(deps, notes) {
    const p = paths(deps);
    const config = readJsonc(p.opencodeConfig);
    const cli = readJsonc(p.opencodeCli);
    const nextConfig = removeOpencodeMcp(config, NAME);
    const nextCli = removePlugin(cli, p.opencodePlugin);
    const hadPlugin = existsSync(p.opencodePlugin);
    rmSync(p.opencodePlugin, { recursive: true, force: true });
    const changed = [
      saveText(p.opencodeConfig, config, nextConfig),
      saveText(p.opencodeCli, cli, nextCli),
    ].some(Boolean);
    if (!changed && !hadPlugin) return "none";
    if (deps.which("opencode")) await restartOpencode(deps, notes);
    return "done";
  },

  async pi(deps) {
    const path = paths(deps).pi;
    if (!existsSync(path)) return "none";
    rmSync(path, { force: true });
    return "done";
  },
};

async function each(
  steps: Record<Harness, Step>,
  deps: AdapterDeps,
  notes: string[],
) {
  const done: Harness[] = [];
  const absent: Harness[] = [];
  const skipped: Skipped[] = [];
  for (const h of HARNESSES) {
    try {
      const r = await steps[h](deps, notes);
      if (r === "done") done.push(h);
      if (r === "absent") absent.push(h);
    } catch (e) {
      skipped.push({
        harness: h,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { done, absent, skipped };
}

/** Registers OpenBus with every harness on PATH; a broken one is skipped, never clobbered. */
export async function installAdapters(
  deps: AdapterDeps,
): Promise<InstallResult> {
  const notes: string[] = [];
  const { done, absent, skipped } = await each(install, deps, notes);
  return { installed: done, absent, skipped, notes };
}

/** Removes exactly what install added: our entry names and our files. */
export async function uninstallAdapters(
  deps: AdapterDeps,
): Promise<UninstallResult> {
  const notes: string[] = [];
  const { done, skipped } = await each(uninstall, deps, notes);
  return { removed: done, skipped, notes };
}
