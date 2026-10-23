/**
 * OpenCode's configs are JSONC. These edits go through jsonc-parser so the
 * user's comments, formatting and other keys stay byte-for-byte; each takes
 * and returns the file's text, and returns it unchanged when there is nothing
 * to do.
 */
import {
  findNodeAtLocation,
  type JSONPath,
  type Node,
  type ParseError,
  parse,
  parseTree,
} from "jsonc-parser";
import type { Doc, McpServer } from "./index.ts";

const isRecord = (v: unknown): v is Doc =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Empty text is an empty object; anything jsonc-parser rejects throws. */
export function parseJsonc(text: string, where: string): Doc {
  if (text.trim() === "") return {};
  const errors: ParseError[] = [];
  const doc: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(doc))
    throw new Error(`${where} is not a JSON object; left it untouched`);
  return doc;
}

const eol = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");

const nest = (path: JSONPath, value: unknown) =>
  path.reduceRight<unknown>(
    (v, k) => (typeof k === "number" ? [v] : { [k]: v }),
    value,
  );

const splice = (text: string, from: number, to: number, content = "") =>
  text.slice(0, from) + content + text.slice(to);

/** The node itself, or for an object member the whole `"key": value`. */
const member = (node: Node) =>
  node.parent?.type === "property" ? node.parent : node;

/** Leading whitespace of the line `offset` is on, and whether it starts it. */
function lineAt(text: string, offset: number) {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const lead = text.slice(start, offset);
  const indent = /^[ \t]*/.exec(lead)?.[0] ?? "";
  return { indent, starts: indent === lead };
}

/**
 * Sets `path` to `value`. New text goes only after the last sibling (or into
 * an empty parent), so `removeAt` of the same path restores the input
 * exactly; neighbouring members, comments and spacing are never reformatted.
 */
function insert(text: string, path: JSONPath, value: unknown): string {
  const nl = eol(text);
  const root = parseTree(text);
  if (root === undefined)
    return `${JSON.stringify(nest(path, value), null, 2)}${nl}`;
  const found = findNodeAtLocation(root, path);
  if (found !== undefined)
    return splice(
      text,
      found.offset,
      found.offset + found.length,
      JSON.stringify(value),
    );
  // Attach under the deepest ancestor that exists; build the rest here.
  let depth = path.length - 1;
  while (
    depth > 0 &&
    findNodeAtLocation(root, path.slice(0, depth)) === undefined
  )
    depth--;
  const parent =
    depth === 0
      ? root
      : (findNodeAtLocation(root, path.slice(0, depth)) as Node);
  const key = path[depth];
  const head = parent.type === "object" ? `${JSON.stringify(key)}: ` : "";
  const v = nest(path.slice(depth + 1), value);
  const render = (indent: string) =>
    head +
    JSON.stringify(v, null, 2)
      .split("\n")
      .join(nl + indent);
  const last = parent.children?.at(-1);
  if (last === undefined) {
    const outer = lineAt(text, parent.offset).indent;
    const indent = `${outer}  `;
    const inner = text.slice(
      parent.offset + 1,
      parent.offset + parent.length - 1,
    );
    // Keep comments in an otherwise empty parent.
    if (inner.trim() !== "")
      return splice(
        text,
        parent.offset + 1,
        parent.offset + 1,
        `${nl}${indent}${render(indent)},`,
      );
    return splice(
      text,
      parent.offset + 1,
      parent.offset + parent.length - 1,
      `${nl}${indent}${render(indent)}${nl}${outer}`,
    );
  }
  const end = last.offset + last.length;
  const at = lineAt(text, last.offset);
  return splice(
    text,
    end,
    end,
    at.starts
      ? `,${nl}${at.indent}${render(at.indent)}`
      : `, ${head}${JSON.stringify(v)}`,
  );
}

/** Deletes the member at `path`: the exact inverse of `insert`. */
function removeAt(text: string, path: JSONPath): string {
  const root = parseTree(text);
  const found = root && findNodeAtLocation(root, path);
  if (found === undefined) return text;
  const node = member(found);
  const parent = node.parent as Node;
  const kids = parent.children ?? [];
  const i = kids.indexOf(node);
  const end = node.offset + node.length;
  const prev = kids[i - 1];
  if (prev !== undefined) return splice(text, prev.offset + prev.length, end);
  const next = kids[i + 1];
  if (next !== undefined) return splice(text, node.offset, next.offset);
  const open = parent.offset + 1;
  const close = parent.offset + parent.length - 1;
  const rest = text.slice(open, node.offset) + text.slice(end, close);
  if (rest.replace(",", "").trim() === "") return splice(text, open, close);
  // Only comments left: take our line, which `insert` put first.
  const lead = /\s*$/.exec(text.slice(0, node.offset))?.[0].length ?? 0;
  const comma = /^\s*,/.exec(text.slice(end))?.[0].length ?? 0;
  return splice(text, node.offset - lead, end + comma);
}

function record(v: unknown, where: string): Doc | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw new Error(`${where} is not an object`);
  return v;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * OpenCode v2: `mcp.servers.<name>`. A top-level `mcp.<name>` is the
 * deprecated v1 shape; ours is dropped so the server is never listed twice.
 */
export function upsertOpencodeMcp(
  text: string,
  name: string,
  server: McpServer,
): string {
  const mcp = record(parseJsonc(text, "config").mcp, "mcp");
  const servers = record(mcp?.servers, "mcp.servers");
  let out = text;
  if (mcp?.[name] !== undefined) out = removeAt(out, ["mcp", name]);
  if (!same(servers?.[name], server))
    out = insert(out, ["mcp", "servers", name], server);
  return out;
}

export function removeOpencodeMcp(text: string, name: string): string {
  const mcp = record(parseJsonc(text, "config").mcp, "mcp");
  const servers = record(mcp?.servers, "mcp.servers");
  let out = text;
  if (servers?.[name] !== undefined)
    out = removeAt(out, ["mcp", "servers", name]);
  if (mcp?.[name] !== undefined) out = removeAt(out, ["mcp", name]);
  return out;
}

function plugins(text: string): unknown[] | undefined {
  const v = parseJsonc(text, "config").plugins;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error("plugins is not an array");
  return v;
}

const names = (entry: unknown, path: string) =>
  entry === path || (isRecord(entry) && entry.package === path);

/** OpenCode v2 `cli.json` plugins: strings or `{ package }` entries. */
export function upsertPlugin(text: string, pluginPath: string): string {
  const list = plugins(text);
  if (list?.some((e) => names(e, pluginPath))) return text;
  return insert(text, ["plugins", list?.length ?? 0], pluginPath);
}

export function removePlugin(text: string, pluginPath: string): string {
  const list = plugins(text) ?? [];
  let out = text;
  for (let i = list.length - 1; i >= 0; i--)
    if (names(list[i], pluginPath)) out = removeAt(out, ["plugins", i]);
  return out;
}
