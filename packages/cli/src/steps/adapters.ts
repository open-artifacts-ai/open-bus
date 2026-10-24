import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  type Doc,
  jsoncValue,
  parseJsonc,
  removeIfEmpty,
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
    // OpenCode reads both; edit the one the user has, else create .json.
    opencodeConfigs: [
      join(opencode, "opencode.json"),
      join(opencode, "opencode.jsonc"),
    ],
    opencodeCli: join(opencode, "cli.json"),
    record: join(openbus, "install.json"),
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

/** True for anything at `path`, a dangling symlink included. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a write to `path` lands: through symlinks, dangling ones included. A
 * link whose target directory is missing is refused, never replaced.
 */
function target(path: string): string {
  let p = path;
  for (let hops = 0; hops < 40; hops++) {
    if (!present(p) || !lstatSync(p).isSymbolicLink()) {
      if (p !== path && !existsSync(dirname(p)))
        throw new Error(
          `${path} is a dangling symlink to ${p}; left it untouched`,
        );
      return p;
    }
    p = resolve(dirname(p), readlinkSync(p));
  }
  throw new Error(`${path}: too many symlinks; left it untouched`);
}

/** Temp + rename beside the real file (through a symlink), keeping its mode. */
function writeAtomic(path: string, data: string, mode?: number) {
  const dest = target(path);
  mkdirSync(dirname(dest), { recursive: true });
  let m = mode ?? 0o644;
  if (mode === undefined)
    try {
      m = statSync(dest).mode & 0o777;
    } catch {}
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: m, flag: "wx" });
    chmodSync(tmp, m);
    renameSync(tmp, dest);
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

/**
 * Writes `next` only when it differs; true if it did. The last guard against
 * a bad edit: `next` must parse cleanly and pass `ok`, or nothing is written.
 */
function saveText(
  path: string,
  before: string,
  next: string,
  ok: (doc: Doc) => boolean,
): boolean {
  if (next === before) return false;
  if (!ok(parseJsonc(next, path)))
    throw new Error(`editing ${path} went wrong; left it untouched`);
  writeAtomic(path, next);
  return true;
}

/** Containers install created per file, so uninstall can drop them if empty. */
type Created = Record<string, (string | number)[][]>;

function readRecord(path: string): Created {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    const c = (v as { created?: unknown } | null)?.created;
    if (typeof c === "object" && c !== null) return c as Created;
  } catch {}
  return {};
}

function writeRecord(path: string, before: Created, created: Created) {
  if (isDeepStrictEqual(before, created)) return;
  writeAtomic(path, json({ created }), 0o600);
}

/** The containers among `paths` that `text` lacks: install will create them. */
const missing = (text: string, paths: (string | number)[][]) =>
  paths.filter((p) => jsoncValue(text, p) === undefined);

const servers = (doc: Doc) =>
  (doc.mcp as { servers?: Doc } | undefined)?.servers;
const listed = (doc: Doc, plugin: string) =>
  Array.isArray(doc.plugins) &&
  doc.plugins.some(
    (e) =>
      e === plugin ||
      (typeof e === "object" && e !== null && e.package === plugin),
  );

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
    // Without a version the config shape is a guess; never write v2 blind.
    if (version === undefined)
      throw new Error(
        "could not read the OpenCode version from `opencode --version`; skipped OpenCode",
      );
    if ((compareVersions(version, "2.0.0") ?? -1) < 0)
      throw new Error(`OpenBus needs OpenCode v2; found ${version}`);
    const p = paths(deps);
    const configPath =
      p.opencodeConfigs.find(present) ?? (p.opencodeConfigs[0] as string);
    const config = readJsonc(configPath);
    const cli = readJsonc(p.opencodeCli);
    const server = {
      type: "local",
      command: [deps.openBusBin, "mcp", "opencode"],
    };
    const nextConfig = upsertOpencodeMcp(config, NAME, server);
    const nextCli = upsertPlugin(cli, p.opencodePlugin);
    // Refuse a dangling link before writing anything.
    target(configPath);
    target(p.opencodeCli);
    const record = readRecord(p.record);
    const add = (file: string, made: (string | number)[][]) => {
      const all = [...(record[file] ?? []), ...made];
      return all.filter(
        (x, i) => all.findIndex((y) => isDeepStrictEqual(x, y)) === i,
      );
    };
    const created: Created = { ...record };
    const madeConfig = missing(config, [["mcp"], ["mcp", "servers"]]);
    const madeCli = missing(cli, [["plugins"]]);
    if (madeConfig.length > 0)
      created[configPath] = add(configPath, madeConfig);
    if (madeCli.length > 0)
      created[p.opencodeCli] = add(p.opencodeCli, madeCli);
    writeRecord(p.record, record, created);
    writeAtomic(
      join(p.opencodePlugin, "tui.js"),
      deps.assets.opencodePlugin,
      0o644,
    );
    saveText(configPath, config, nextConfig, (d) =>
      isDeepStrictEqual(servers(d)?.[NAME], server),
    );
    saveText(p.opencodeCli, cli, nextCli, (d) => listed(d, p.opencodePlugin));
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
    const record = readRecord(p.record);
    // Drop what install created once it is empty again, deepest first.
    const prune = (file: string, text: string) =>
      [...(record[file] ?? [])]
        .sort((a, b) => b.length - a.length)
        .reduce(removeIfEmpty, text);
    const edits = [...p.opencodeConfigs.filter(present), p.opencodeCli].map(
      (file) => {
        const before = readJsonc(file);
        const next = prune(
          file,
          file === p.opencodeCli
            ? removePlugin(before, p.opencodePlugin)
            : removeOpencodeMcp(before, NAME),
        );
        return { file, before, next };
      },
    );
    // Configs first, the plugin folder last: a failed save must not leave
    // cli.json pointing at a folder that is gone.
    const saved = edits.map(({ file, before, next }) =>
      saveText(file, before, next, (d) =>
        file === p.opencodeCli
          ? !listed(d, p.opencodePlugin)
          : servers(d)?.[NAME] === undefined &&
            (d.mcp as Doc | undefined)?.[NAME] === undefined,
      ),
    );
    const left = { ...record };
    for (const { file } of edits) delete left[file];
    writeRecord(p.record, record, left);
    const hadPlugin = existsSync(p.opencodePlugin);
    rmSync(p.opencodePlugin, { recursive: true, force: true });
    if (!saved.some(Boolean) && !hadPlugin) return "none";
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
