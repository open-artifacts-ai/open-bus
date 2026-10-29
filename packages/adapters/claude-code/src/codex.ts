import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CLIENT_VERSION,
  type DaemonClient,
  Hello,
  HelloRefused,
  SPAWNED_SOURCES,
} from "@ob/ipc";
import { callTool, TOOLS, type ToolResult } from "./tools.ts";

/** Codex sets this on every tools/call, next to `threadId` and `callId`; the model does not control it. */
export const TURN_META = "x-codex-turn-metadata";

/** The omp copy (pi/assets/openbus.ts), for Codex. */
export const SUBAGENT_REFUSAL =
  "openbus: a subagent is not on the bus; only the main Codex thread can use OpenBus";

const NO_IDENTITY =
  "openbus: this Codex version did not send the thread's identity.";

export type CodexCall = {
  threadId: string;
  callId: string;
  threadSource: string;
  cwd: string;
};

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : undefined;

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * The thread's directory. The turn metadata Codex 0.165 sends has no `cwd`
 * key, only `workspaces` keyed by root, so one root is the cwd; several are
 * ambiguous. A `cwd` string wins if a later Codex sends one.
 */
function cwdOf(turn: Record<string, unknown>): string | undefined {
  const cwd = str(turn.cwd);
  if (cwd) return cwd.startsWith("/") ? cwd : undefined;
  const roots = Object.keys(record(turn.workspaces) ?? {});
  return roots.length === 1 && roots[0]?.startsWith("/") ? roots[0] : undefined;
}

/**
 * Who is calling, from a tools/call's `_meta`, or the refusal to give. The
 * thread id must agree in both places Codex writes it. A thread Codex spawned
 * (a subagent) is refused, as omp does.
 */
export function codexCall(meta: unknown): CodexCall | { refuse: string } {
  const m = record(meta);
  let turn: unknown = m?.[TURN_META];
  // Header-shaped: some builds may send it as JSON text.
  if (typeof turn === "string")
    try {
      turn = JSON.parse(turn);
    } catch {
      turn = undefined;
    }
  const t = record(turn);
  const threadId = str(m?.threadId);
  const callId = str(m?.callId);
  if (!m || !t || !threadId || !callId) return { refuse: NO_IDENTITY };
  if (t.thread_id !== undefined && t.thread_id !== threadId)
    return { refuse: NO_IDENTITY };
  const source = str(t.thread_source);
  if (!source) return { refuse: NO_IDENTITY };
  if (SPAWNED_SOURCES.has(source)) return { refuse: SUBAGENT_REFUSAL };
  const cwd = cwdOf(t);
  if (!cwd)
    return {
      refuse: `openbus: Codex did not say which directory thread ${threadId} is in.`,
    };
  return { threadId, callId, threadSource: source, cwd };
}

/**
 * The hello for one call: the daemon re-proves the thread and this call id
 * each time. Undefined when a fact cannot go on the wire.
 */
export function codexHello(
  call: CodexCall,
  pid: number,
  ppid: number,
): Hello | undefined {
  const hello = Hello.safeParse({
    v: 1,
    id: "hello",
    type: "hello",
    kind: "codex",
    client_version: CLIENT_VERSION,
    agent_ref: call.threadId,
    pid,
    cwd: call.cwd,
    proposed_name: "codex",
    codex: {
      thread_id: call.threadId,
      call_id: call.callId,
      ppid,
      thread_source: call.threadSource,
    },
  });
  return hello.success ? hello.data : undefined;
}

const refused = (t: string): ToolResult => ({
  content: [{ type: "text", text: t }],
  isError: true,
});

export type CodexDeps = {
  connect: (hello: Hello) => Promise<DaemonClient>;
  pid?: number;
  ppid?: number;
};

/**
 * The claude-code TOOLS for Codex. Codex gives its MCP server no session env,
 * so nothing is said to the daemon until a tools/call brings `_meta`; then one
 * connection per call, closed after it. One process serves one thread: a
 * call from another thread is refused, never re-identified.
 */
export function codexServer(deps: CodexDeps): Server {
  const pid = deps.pid ?? process.pid;
  const ppid = deps.ppid ?? process.ppid;
  let thread: string | undefined;
  const server = new Server(
    { name: "openbus", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    try {
      const call = codexCall(req.params._meta);
      if ("refuse" in call) return refused(call.refuse);
      const hello = codexHello(call, pid, ppid);
      if (!hello) return refused(NO_IDENTITY);
      // Pinned only by a call whose hello is valid: a bad first call claims nothing.
      thread ??= call.threadId;
      if (call.threadId !== thread)
        return refused(
          `openbus: this OpenBus server belongs to Codex thread ${thread}, not ${call.threadId}.`,
        );
      let client: DaemonClient;
      try {
        client = await deps.connect(hello);
      } catch (e) {
        const reason =
          e instanceof HelloRefused && e.reason
            ? e.reason
            : e instanceof Error
              ? e.message
              : String(e);
        return refused(`OpenBus did not accept this thread: ${reason}`);
      }
      try {
        return await callTool(
          req.params.name,
          (req.params.arguments ?? {}) as Record<string, unknown>,
          client,
          extra.signal,
        );
      } finally {
        client.close();
      }
    } catch (e) {
      return refused(`openbus: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return server;
}
