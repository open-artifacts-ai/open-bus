/**
 * Pure merges for harness config files. Each returns a new document, touches
 * only the one entry it names, and throws rather than clobber a key whose
 * shape it does not understand.
 */
export type Doc = Record<string, unknown>;
export type McpServer = Record<string, unknown>;

const isRecord = (v: unknown): v is Doc =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function record(doc: Doc, key: string, where = key): Doc | undefined {
  const v = doc[key];
  if (v === undefined) return undefined;
  if (!isRecord(v)) throw new Error(`${where} is not an object`);
  return v;
}

/** Claude Code: `mcpServers.<name>`. */
export function upsertMcpServer(
  doc: Doc,
  name: string,
  server: McpServer,
): Doc {
  return {
    ...doc,
    mcpServers: { ...record(doc, "mcpServers"), [name]: server },
  };
}

export function removeMcpServer(doc: Doc, name: string): Doc {
  const servers = record(doc, "mcpServers");
  if (servers === undefined) return doc;
  const { [name]: _, ...rest } = servers;
  return { ...doc, mcpServers: rest };
}

/**
 * OpenCode v2: `mcp.servers.<name>`. A top-level `mcp.<name>` is the
 * deprecated v1 shape; ours is dropped so the server is never listed twice.
 */
export function upsertOpencodeMcp(
  doc: Doc,
  name: string,
  server: McpServer,
): Doc {
  const { [name]: _, ...mcp } = record(doc, "mcp") ?? {};
  const servers = record(mcp, "servers", "mcp.servers");
  return { ...doc, mcp: { ...mcp, servers: { ...servers, [name]: server } } };
}

export function removeOpencodeMcp(doc: Doc, name: string): Doc {
  const current = record(doc, "mcp");
  if (current === undefined) return doc;
  const { [name]: _, ...mcp } = current;
  const servers = record(mcp, "servers", "mcp.servers");
  if (servers === undefined) return { ...doc, mcp };
  const { [name]: __, ...rest } = servers;
  return { ...doc, mcp: { ...mcp, servers: rest } };
}

function plugins(doc: Doc): unknown[] | undefined {
  const v = doc.plugins;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error("plugins is not an array");
  return v;
}

const names = (entry: unknown, path: string) =>
  entry === path || (isRecord(entry) && entry.package === path);

/** OpenCode v2 `cli.json` plugins: strings or `{ package }` entries. */
export function upsertPlugin(doc: Doc, pluginPath: string): Doc {
  const list = plugins(doc) ?? [];
  if (list.some((e) => names(e, pluginPath))) return doc;
  return { ...doc, plugins: [...list, pluginPath] };
}

export function removePlugin(doc: Doc, pluginPath: string): Doc {
  const list = plugins(doc);
  if (list === undefined) return doc;
  return { ...doc, plugins: list.filter((e) => !names(e, pluginPath)) };
}
