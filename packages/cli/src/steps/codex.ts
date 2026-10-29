import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { codexAppBin, resolveCodexBin } from "@ob/daemon";
import { parse } from "smol-toml";

/**
 * Codex (C26e). Its MCP servers live in `${CODEX_HOME:-~/.codex}/config.toml`,
 * which the desktop app also writes (`[desktop]`), so install edits only our
 * own table, as text, and never re-serializes the file. Install owns that
 * table whole: keys added to it by hand do not survive the next install.
 * The wake binary's file and lookup are the daemon's (transports/codex.ts).
 */

/**
 * Our entry's name. The tool namespace (`mcp__openbus`) comes from it, and
 * the daemon's attestation looks for that namespace in the rollout.
 */
export const CODEX_ENTRY = "openbus";

type Env = Record<string, string | undefined>;

/** `${CODEX_HOME:-~/.codex}`, absolute. */
export const codexHome = (home: string, env: Env): string =>
  env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, ".codex");

/** CODEX_HOME when it is set and not the default: the daemon's service needs it. */
export function codexHomeEnv(
  home: string,
  env: Env,
): { CODEX_HOME: string } | Record<string, never> {
  const dir = codexHome(home, env);
  return dir === join(home, ".codex") ? {} : { CODEX_HOME: dir };
}

export const codexConfig = (home: string, env: Env): string =>
  join(codexHome(home, env), "config.toml");

/** Codex is here: on PATH, its home exists, or the app is installed. */
export function hasCodex(o: {
  home: string;
  env: Env;
  which: (cmd: string) => boolean;
  /** The app's bundle; undefined looks for none. */
  app?: string;
}): boolean {
  if (o.which("codex")) return true;
  try {
    lstatSync(codexHome(o.home, o.env));
    return true;
  } catch {}
  return o.app !== undefined && codexAppBin(o.app) !== undefined;
}

/**
 * The `codex` the daemon would wake threads with, by the daemon's own lookup:
 * the pin in `configFile` (when given), PATH, then the app (undefined: none).
 */
export const findCodexBin = (o: {
  configFile?: string;
  path?: string;
  app?: string;
}): string | undefined => resolveCodexBin({ ...o, app: o.app ?? null })?.path;

export type CodexEntry = {
  command: string;
  args: string[];
  default_tools_approval_mode: "approve";
  env?: Record<string, string>;
};

type Doc = Record<string, unknown>;

/** The config as text and parsed: missing is empty, invalid TOML throws. */
export function readToml(path: string): { text: string; doc: Doc } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      return { text: "", doc: {} };
    throw e;
  }
  try {
    return { text, doc: parse(text) as Doc };
  } catch {
    throw new Error(`${path} is not valid TOML`);
  }
}

/** Plain JSON values: smol-toml's tables have no prototype. */
const plain = (v: unknown): unknown =>
  v === undefined ? undefined : JSON.parse(JSON.stringify(v));

const servers = (doc: Doc) => doc.mcp_servers as Doc | undefined;
/** Our entry as parsed, if any. */
export const codexEntryOf = (doc: Doc): unknown =>
  plain(servers(doc)?.[CODEX_ENTRY]);

/** Whether the entry runs `open-bus mcp codex` with tool approval on (D3). */
export function entryOk(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as Partial<CodexEntry>;
  return (
    typeof e.command === "string" &&
    Array.isArray(e.args) &&
    e.args.slice(-2).join(" ") === "mcp codex" &&
    e.default_tools_approval_mode === "approve"
  );
}

/** The sandbox the config asks for by default (`sandbox_mode`). */
export const sandboxMode = (doc: Doc): unknown => doc.sandbox_mode;

const str = (s: string) => JSON.stringify(s);
const key = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : str(k));

/** Our table as TOML lines. */
export function renderEntry(e: CodexEntry): string[] {
  const env = Object.entries(e.env ?? {});
  return [
    `[mcp_servers.${CODEX_ENTRY}]`,
    `command = ${str(e.command)}`,
    `args = [${e.args.map(str).join(", ")}]`,
    ...(env.length
      ? [`env = { ${env.map(([k, v]) => `${key(k)} = ${str(v)}`).join(", ")} }`]
      : []),
    `default_tools_approval_mode = ${str(e.default_tools_approval_mode)}`,
  ];
}

/**
 * Each line's kind, outside strings: a table header (and its dotted name),
 * blank or comment, or other. A multi-line string's lines are "other".
 */
function scan(lines: string[]): ("blank" | "other" | { header: string })[] {
  let open: '"""' | "'''" | undefined;
  return lines.map((line) => {
    const startsInString = open !== undefined;
    let i = 0;
    let code = false;
    while (i < line.length) {
      if (open) {
        const end = line.indexOf(open, i);
        if (end < 0) {
          i = line.length;
          break;
        }
        // A closing run may carry up to two more quotes of the string.
        i = end + 3;
        while (line[i] === open[0]) i++;
        open = undefined;
        continue;
      }
      const c = line[i] as string;
      if (c === "#") break;
      if (c === '"' || c === "'") {
        code = true;
        const triple = line.startsWith(c.repeat(3), i);
        if (triple) {
          open = c === '"' ? '"""' : "'''";
          i += 3;
          continue;
        }
        i++;
        while (i < line.length && line[i] !== c)
          i += c === '"' && line[i] === "\\" ? 2 : 1;
        i++;
        continue;
      }
      if (c !== " " && c !== "\t" && c !== "\r") code = true;
      i++;
    }
    if (startsInString) return "other";
    const m = /^[ \t]*\[\[?([^\]]*)\]\]?[ \t]*(#.*)?\r?$/.exec(line);
    if (m) return { header: m[1] as string };
    return code ? "other" : "blank";
  });
}

/** A header's dotted name as keys: `mcp_servers . "openbus"` is `["mcp_servers","openbus"]`. */
function headerKeys(name: string): string[] {
  const out: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  while (re.lastIndex < name.length) {
    const m = re.exec(name);
    if (!m) break;
    out.push(
      m[1] !== undefined
        ? (JSON.parse(`"${m[1]}"`) as string)
        : (m[2] ?? m[3] ?? ""),
    );
    if (!m[4]) break;
  }
  return out;
}

/** Whether a header names our table or one of its subtables. */
const ours = (header: string) => {
  try {
    const keys = headerKeys(header);
    return keys[0] === "mcp_servers" && keys[1] === CODEX_ENTRY;
  } catch {
    // An escape JSON does not share (`\U…`): not a name we write.
    return false;
  }
};

/**
 * The lines our table spans, header included, through its last line of
 * content: comments and blanks before the next table belong to that table.
 * Our own subtables (`[mcp_servers.openbus.env]`) are part of it.
 */
function span(lines: string[]): { from: number; to: number } | undefined {
  const kinds = scan(lines);
  const from = kinds.findIndex((k) => typeof k === "object" && ours(k.header));
  if (from < 0) return undefined;
  let to = from;
  for (let i = from + 1; i < lines.length; i++) {
    const k = kinds[i];
    if (typeof k === "object" && !ours(k.header)) break;
    if (k !== "blank") to = i;
  }
  return { from, to };
}

/** Everything but our entry, for the guard; an emptied `mcp_servers` counts as absent. */
function others(doc: Doc): unknown {
  const rest = plain(doc) as Doc;
  const s = rest.mcp_servers as Doc | undefined;
  if (s) {
    delete s[CODEX_ENTRY];
    if (Object.keys(s).length === 0) delete rest.mcp_servers;
  }
  return rest;
}

/** Tables with their keys sorted, all the way down: order is not a value. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : typeof v === "object" && v !== null
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Doc)[k])]),
        )
      : v;

/** Equal values, whatever order a table's keys were parsed in. */
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * The guard on every edit: the result parses, our entry is `want` (or gone),
 * and everything else reads exactly as before. Else nothing is written.
 */
function checked(path: string, before: Doc, next: string, want: unknown) {
  let doc: Doc;
  try {
    doc = parse(next) as Doc;
  } catch {
    throw new Error(`editing ${path} went wrong; left it untouched`);
  }
  if (
    !same(codexEntryOf(doc), plain(want)) ||
    !same(others(doc), others(before))
  )
    throw new Error(`editing ${path} went wrong; left it untouched`);
  return next;
}

/**
 * The config with our table set to `entry`: replaced in place, else appended.
 * Every other byte is kept.
 */
export function upsertCodexEntry(
  path: string,
  text: string,
  doc: Doc,
  entry: CodexEntry,
): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const at = span(lines);
  const block = renderEntry(entry);
  let next: string;
  if (at) {
    if (same(block, lines.slice(at.from, at.to + 1))) return text;
    next = [
      ...lines.slice(0, at.from),
      ...block,
      ...lines.slice(at.to + 1),
    ].join(eol);
  } else {
    // Set some other way (an inline table, dotted keys): not ours to rewrite.
    if (servers(doc)?.[CODEX_ENTRY] !== undefined)
      throw new Error(
        `${path} sets mcp_servers.${CODEX_ENTRY} in a form install can't edit; left it untouched`,
      );
    // A blank line before it; the file's own ending is kept.
    const sep =
      text === "" || text.endsWith(eol + eol)
        ? ""
        : text.endsWith(eol)
          ? eol
          : eol + eol;
    next = `${text}${sep}${block.join(eol)}${eol}`;
  }
  return checked(path, doc, next, entry);
}

/** The config without our table; unchanged when it has none. */
export function removeCodexEntry(path: string, text: string, doc: Doc): string {
  if (servers(doc)?.[CODEX_ENTRY] === undefined) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const at = span(lines);
  if (!at)
    throw new Error(
      `${path} sets mcp_servers.${CODEX_ENTRY} in a form uninstall can't edit; left it untouched`,
    );
  // Our table and the blank lines after it: what install's append added
  // comes off again, and a table that follows keeps its one blank line.
  let to = at.to + 1;
  while (to < lines.length - 1 && lines[to]?.trim() === "") to++;
  let from = at.from;
  if (to >= lines.length - 1)
    // Ours was last: the blank lines before it go too.
    while (from > 0 && lines[from - 1]?.trim() === "") from--;
  const next = [...lines.slice(0, from), ...lines.slice(to)].join(eol);
  return checked(path, doc, next, undefined);
}
