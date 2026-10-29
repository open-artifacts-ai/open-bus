// The Codex mode (C26b): a fake MCP client sends probe-shaped `_meta` to a fake daemon.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CLIENT_VERSION,
  connectDaemon,
  type Hello,
  serveDaemon,
} from "@ob/ipc";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexCall,
  codexServer,
  SUBAGENT_REFUSAL,
  TURN_META,
} from "../src/codex.ts";
import { sessionHello } from "../src/session.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

const THREAD = "01a184f2-14eb-73d0-9da0-ffd91d13abd3";
const WORK = "/private/tmp/work";

/** A `_meta` as Codex 0.165 sends it (docs/probes/codex.md §1). */
const meta = (over: { thread?: string; call?: string; turn?: object } = {}) => {
  const thread = over.thread ?? THREAD;
  return {
    callId: over.call ?? "call_3",
    [TURN_META]: {
      session_id: thread,
      thread_id: thread,
      model: "stub-1",
      turn_id: "01a184f2-1569-79a2-8399-f0ac163ff023",
      thread_source: "user",
      turn_trigger: "exec",
      sandbox: "none",
      workspaces: { [WORK]: { has_changes: false } },
      codex_version: "0.165.0",
      ...over.turn,
    },
    threadId: thread,
    sessionId: thread,
    windowId: `${thread}:0`,
    itemId: "fc_3",
    progressToken: 1,
  };
};

/** A daemon that records each hello and answers `list` with an empty roster. */
async function fakeDaemon() {
  const path = join(mkdtempSync(join(tmpdir(), "ob-codex-")), "d.sock");
  const hellos: Hello[] = [];
  const served = await serveDaemon({
    path,
    onHello: (h) => {
      hellos.push(h);
      return { bus_name: "codex", namespace: "ns", global: false };
    },
    onFrame: (f) => ({ id: f.id, type: "roster", agents: [] }),
  });
  closers.push(served.close);
  return { path, hellos };
}

async function codex(path: string) {
  const server = codexServer({
    connect: (hello) => connectDaemon({ path, hello }),
    pid: 4321,
    ppid: 4000,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "codex-mcp-client", version: "0.165.0" });
  await client.connect(b);
  closers.push(() => client.close());
  const call = async (m: unknown) =>
    (await client.callTool({
      name: "list_agents",
      arguments: {},
      ...(m === undefined ? {} : { _meta: m as Record<string, unknown> }),
    })) as { content: { text: string }[]; isError?: boolean };
  return { client, call };
}

describe("the codex MCP adapter", () => {
  it("says nothing to the daemon until the first tools/call", async () => {
    const d = await fakeDaemon();
    const { client } = await codex(d.path);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_agents",
      "send_message",
      "fetch",
      "self",
    ]);
    expect(d.hellos).toEqual([]);
  });

  it("hellos per call with the thread, the call, pid, ppid and the thread's cwd", async () => {
    const d = await fakeDaemon();
    const { call } = await codex(d.path);
    const r = await call(meta());
    expect(r.isError).toBeFalsy();
    expect(r.content[0]?.text).toBe("No agents in your namespace.");
    await call(meta({ call: "call_4" }));
    expect(d.hellos).toEqual([
      {
        v: 1,
        id: "hello",
        type: "hello",
        kind: "codex",
        client_version: CLIENT_VERSION,
        agent_ref: THREAD,
        pid: 4321,
        cwd: WORK,
        proposed_name: "codex",
        attest: {},
        codex: { thread_id: THREAD, call_id: "call_3", ppid: 4000 },
      },
      expect.objectContaining({
        codex: { thread_id: THREAD, call_id: "call_4", ppid: 4000 },
      }),
    ]);
  });

  it("a subagent thread opens no link and every tool refuses", async () => {
    const d = await fakeDaemon();
    const { call } = await codex(d.path);
    const sub = meta({ turn: { thread_source: "subagent" } });
    const r = await call(sub);
    expect(r).toMatchObject({
      isError: true,
      content: [{ text: SUBAGENT_REFUSAL }],
    });
    expect(SUBAGENT_REFUSAL).toBe(
      "openbus: a subagent is not on the bus; only the main Codex thread can use OpenBus",
    );
    expect(d.hellos).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["no _meta", undefined],
    ["an empty _meta", {}],
    ["no turn metadata", { ...meta(), [TURN_META]: undefined }],
    ["turn metadata that is not JSON", { ...meta(), [TURN_META]: "{nope" }],
    ["turn metadata that is an array", { ...meta(), [TURN_META]: [] }],
    ["no threadId", { ...meta(), threadId: undefined }],
    ["a numeric callId", { ...meta(), callId: 3 }],
    ["no thread_source", meta({ turn: { thread_source: undefined } })],
    ["a thread_id that disagrees", meta({ turn: { thread_id: "other" } })],
  ])("%s is refused cleanly, with no hello", async (_, m) => {
    const d = await fakeDaemon();
    const { call } = await codex(d.path);
    const r = await call(m);
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe(
      "openbus: this Codex version did not send the thread's identity.",
    );
    expect(d.hellos).toEqual([]);
    // Still serving.
    expect((await call(meta())).isError).toBeFalsy();
  });

  it.each([
    ["no workspace", {}],
    ["two workspaces", { [WORK]: {}, "/elsewhere": {} }],
    ["a relative workspace", { work: {} }],
  ])("%s gives no cwd, and is refused", async (_, workspaces) => {
    const d = await fakeDaemon();
    const { call } = await codex(d.path);
    const r = await call(meta({ turn: { workspaces } }));
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/did not say which directory/);
    expect(d.hellos).toEqual([]);
  });

  it("refuses a second thread in the same process rather than re-identifying", async () => {
    const d = await fakeDaemon();
    const { call } = await codex(d.path);
    expect((await call(meta())).isError).toBeFalsy();
    const other = "01a184f2-0000-7000-8000-000000000000";
    const r = await call(meta({ thread: other }));
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toBe(
      `openbus: this OpenBus server belongs to Codex thread ${THREAD}, not ${other}.`,
    );
    expect(d.hellos.map((h) => h.agent_ref)).toEqual([THREAD]);
    // The first thread keeps working.
    expect((await call(meta({ call: "call_9" }))).isError).toBeFalsy();
  });

  it("a daemon that is down is a tool error, not a crash", async () => {
    const { call } = await codex(join(tmpdir(), "ob-codex-none", "d.sock"));
    const r = await call(meta());
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/daemon did not accept this thread/);
  });

  it("takes a `cwd` key over workspaces, and turn metadata sent as JSON text", () => {
    expect(
      codexCall(meta({ turn: { cwd: "/repo/sub", workspaces: {} } })),
    ).toEqual({ threadId: THREAD, callId: "call_3", cwd: "/repo/sub" });
    const m = meta();
    expect(
      codexCall({ ...m, [TURN_META]: JSON.stringify(m[TURN_META]) }),
    ).toEqual({ threadId: THREAD, callId: "call_3", cwd: WORK });
  });

  it("leaves Claude's hello as it was: no codex facts", () => {
    const h = sessionHello(
      { pid: 1, sessionId: "s1", socketPath: null, peerToken: null, name: "x" },
      1,
      "/",
    );
    expect(h.kind).toBe("claude-code");
    expect(h).not.toHaveProperty("codex");
  });
});
