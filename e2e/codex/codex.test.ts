// C26g: Codex end to end, with no API key and no network. The pinned Codex CLI
// runs in a temp CODEX_HOME against a fake Responses model (fake-model.ts),
// with `[mcp_servers.openbus]` running `open-bus mcp codex` from the CLI
// bundle; the real daemon from the same bundle; the real server under
// `wrangler dev`. A Pi-kind peer on the daemon's socket is the other end.
//
//   pnpm e2e:codex
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CODEX_REFUSALS } from "@ob/daemon";
import { connectDaemon, Hello, HelloRefused } from "@ob/ipc";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  inject,
  it,
} from "vitest";
import {
  assertNoOuterConfig,
  eventually,
  SENTINEL_HOME,
  sentinelWrites,
} from "../staging/harness.ts";
import { type FakeAnthropic, fakeAnthropic } from "./fake-anthropic.ts";
import { type FakeModel, fakeModel } from "./fake-model.ts";
import {
  type AppServer,
  appServer,
  childPath,
  codexEnv,
  codexWorkspace,
  exited,
  type Homes,
  logTail,
  nativeCodexPid,
  type Peer,
  pastFirstSecond,
  peer,
  RUN,
  scratch,
  start,
  startDaemon,
  startServer,
  stop,
  stopAll,
  trackPids,
  writeCodexConfig,
} from "./stack.ts";

const codexBin = inject("codexBin");
const claudeBin = inject("claudeBin");
const cliBundle = inject("cliBundle");
trackPids(inject("pidFile"));

let model: FakeModel;
let homes: Homes;
let socket: string;
let env: NodeJS.ProcessEnv;
const peers: Peer[] = [];

let failed = false;
/** Every process's log tail and what the fake models saw; the temp root is kept. */
function dump(why: string): void {
  failed = true;
  const seen = (xs: object[] | undefined) =>
    (xs ?? [])
      .slice(-20)
      .map((x) => JSON.stringify(x).slice(0, 300))
      .join("\n");
  console.error(
    [
      `${why}; temp root kept: ${RUN}`,
      logTail(),
      `── fake model (last 20) ──\n${seen(model?.seen)}`,
      `── fake anthropic (last 20) ──\n${seen(anthropicSeen)}`,
    ].join("\n"),
  );
}
/** A beforeAll whose failure dumps first: afterEach never runs for it. */
const setUp = (fn: () => Promise<void>) =>
  beforeAll(async () => {
    try {
      await fn();
    } catch (e) {
      dump(`setup failed: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  });
let anthropicSeen: object[] | undefined;

setUp(async () => {
  assertNoOuterConfig();
  homes = {
    home: scratch("home"),
    obHome: scratch("ob"),
    codexHome: scratch("codex"),
  };
  model = await fakeModel();
  writeCodexConfig(homes, { model: model.url, cliBundle });
  env = codexEnv(homes, codexBin);
  const server = await startServer();
  ({ socket } = await startDaemon(cliBundle, codexBin, server.machine, homes));
});

afterEach((ctx) => {
  if (ctx.task.result?.state === "fail") dump(`failed: ${ctx.task.name}`);
});

afterAll(async () => {
  for (const p of peers) p.client.close();
  await stopAll();
  await model?.close();
  // Nothing went to the harness's sentinel HOME: every path was threaded.
  expect(sentinelWrites(), SENTINEL_HOME).toEqual([]);
  if (!failed) rmSync(RUN, { recursive: true, force: true });
  else console.error(`temp root kept: ${RUN}`);
});

const onThread = (thread: string) =>
  model.seen.filter((s) => s.thread === thread);
/** The output Codex handed the model for this thread's `tool` call. */
const outputOf = (thread: string, tool: string) =>
  onThread(thread).find((s) => s.answers === tool)?.output ?? "";

/** Rows `codex queue` wrote for `thread` (read-only: Codex owns the file). */
function queuedFor(thread: string): number {
  const file = join(homes.codexHome, "queue_1.sqlite");
  if (!existsSync(file)) return 0;
  const db = new DatabaseSync(file, {
    readOnly: true,
  });
  try {
    const row = db
      .prepare("SELECT count(*) AS n FROM queued_items WHERE thread_id = ?")
      .get(thread) as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

async function joinPeer(ns: string, name: string, cwd: string) {
  const p = await peer(socket, `${name}-${ns}`, name, cwd);
  peers.push(p);
  return p;
}

describe("codex exec", () => {
  let thread: string;
  let p: Peer;
  let ws: string;

  it("joins as codex, is attested, lists agents and delivers to the peer", async () => {
    ws = codexWorkspace("cx-exec");
    p = await joinPeer("exec", "peer", ws);
    const run = start(
      "codex-exec",
      codexBin,
      ["exec", "ob-e2e send peer hello from exec"],
      { cwd: ws, env },
    );
    const ready = pastFirstSecond(run.pid as number);
    // Its failure surfaces through hold; never as an unhandled rejection.
    ready.catch(() => {});
    let during: unknown;
    model.hold = async (tool) => {
      await ready;
      // Mid-turn, after list_agents admitted the thread: the peer's view of it.
      if (tool === "send_message")
        during = await p.client.request({ type: "list" });
    };
    expect(await exited(run)).toBe(0);

    const turn = model.seen.filter((s) => s.user.startsWith("ob-e2e send"));
    thread = turn[0]?.thread ?? "";
    expect(thread).not.toBe("");
    // list_agents went through the daemon and the hub: the roster has both.
    expect(outputOf(thread, "list_agents")).toMatch(/^- peer \(pi, cx-exec,/m);
    expect(during).toMatchObject({
      type: "roster",
      agents: expect.arrayContaining([
        expect.objectContaining({ name: "codex", kind: "codex", live: true }),
      ]),
    });
    // send_message: attested (a refused thread gets "did not accept"), then Delivered.
    expect(outputOf(thread, "send_message")).toMatch(/Delivered to peer/);
    expect(p.delivered).toEqual([
      expect.objectContaining({
        from_name: "codex",
        namespace: "cx-exec",
        body: "hello from exec",
      }),
    ]);
  });

  it("is not woken after exit: offline semantics, and no codex queue runs", async () => {
    const before = onThread(thread).length;
    const r = await p.client.request({
      type: "send",
      to: "codex",
      body: "after exit",
    });
    // The thread closed with its process: the hub expires mail to it.
    expect(r).toMatchObject({
      type: "receipt",
      state: "expired",
      reason: "recipient_closed",
    });
    // A wake would come after the receipt: watch a bounded window for one.
    const until = Date.now() + 3_000;
    while (Date.now() < until) {
      expect(queuedFor(thread)).toBe(0);
      expect(onThread(thread).length).toBe(before);
      await new Promise((r) => setTimeout(r, 100));
    }
    // No `codex queue` ran at all: the daemon writes codex-queued.json at its
    // first one, and this is the first Codex delivery this daemon has seen.
    expect(
      existsSync(join(homes.obHome, "codex-queued.json")),
      "codex-queued.json: a codex queue ran",
    ).toBe(false);
  });
});

describe("codex app-server (the desktop app's mode)", () => {
  let app: AppServer;
  let thread: string;
  let p: Peer;
  let ws: string;

  setUp(async () => {
    ws = codexWorkspace("cx-app");
    p = await joinPeer("app", "peer", ws);
    app = await appServer(codexBin, ws, env);
    const ready = pastFirstSecond(app.child.pid as number);
    ready.catch(() => {});
    model.hold = () => ready;
    // As the desktop app starts a user's thread (app.asar: threadSource `user`).
    thread = (
      await app.request<{ thread: { id: string } }>("thread/start", {
        cwd: ws,
        threadSource: "user",
      })
    ).thread.id;
  });
  afterAll(async () => {
    if (app) await stop(app.child);
  });

  it("joins as codex and delivers to the peer", async () => {
    const from = app.notes.length;
    await app.request("turn/start", {
      threadId: thread,
      input: [
        {
          type: "text",
          text: "ob-e2e send peer hello from app",
          text_elements: [],
        },
      ],
    });
    await app.next((n) => n.method === "turn/completed", from);
    expect(outputOf(thread, "list_agents")).toMatch(/^- peer \(pi, cx-app,/m);
    expect(await p.client.request({ type: "list" })).toMatchObject({
      type: "roster",
      agents: expect.arrayContaining([
        expect.objectContaining({ name: "codex", kind: "codex", live: true }),
      ]),
    });
    expect(outputOf(thread, "send_message")).toMatch(/Delivered to peer/);
    expect(p.delivered).toEqual([
      expect.objectContaining({ from_name: "codex", body: "hello from app" }),
    ]);
  });

  it("an idle thread is woken by codex queue: a turn starts with the message", async () => {
    const from = app.notes.length;
    const r = await p.client.request({
      type: "send",
      to: "codex",
      body: "wake up, codex",
    });
    expect(r).toMatchObject({ type: "receipt", state: "delivered" });
    const started = await app.next((n) => n.method === "turn/started", from);
    expect(started.params?.threadId).toBe(thread);
    const woke = await eventually(
      () => {
        const s = onThread(thread).find((x) =>
          x.user.includes("wake up, codex"),
        );
        if (!s) throw new Error("the model has not seen the message");
        return s;
      },
      { timeoutMs: 30_000 },
    );
    expect(woke.user).toMatch(/^\[openbus\] Message from peer/);
    await app.next((n) => n.method === "turn/completed", from);
  });

  it("refuses a forged caller: a process that is not codex's child claims the thread", async () => {
    const callId = onThread(thread).find((s) => s.answers === "send_message")
      ?.last.call_id;
    const hello = Hello.parse({
      v: 1,
      id: "forged",
      type: "hello",
      kind: "codex",
      agent_ref: thread,
      pid: process.pid,
      cwd: ws,
      proposed_name: "codex",
      codex: {
        thread_id: thread,
        call_id: callId ?? "call_1",
        ppid: nativeCodexPid(app.child.pid as number),
        thread_source: "user",
      },
    });
    const err = await connectDaemon({ path: socket, hello }).then(
      (c) => {
        c.close();
        return undefined;
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HelloRefused);
    expect((err as HelloRefused).reason).toContain(CODEX_REFUSALS.notCodex);
  });
});

// Claude Code, the same way: `claude -p` against a fake Messages API with a
// dummy key (no login, no network), `open-bus mcp claude` from the bundle.
describe("claude -p", () => {
  let anthropic: FakeAnthropic;
  afterAll(async () => {
    await anthropic?.close();
  });

  it("joins as claude-code, lists agents and delivers to the peer", async () => {
    anthropic = await fakeAnthropic();
    anthropicSeen = anthropic.seen;
    const ws = codexWorkspace("cc");
    const p = await joinPeer("cc", "peer", ws);
    const config = join(scratch("claude"), "mcp.json");
    writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          openbus: {
            command: process.execPath,
            args: [cliBundle, "mcp", "claude"],
            env: { OPENBUS_HOME: homes.obHome },
          },
        },
      }),
    );
    const run = start(
      "claude",
      claudeBin,
      [
        "-p",
        "ob-e2e send peer hello from claude",
        "--mcp-config",
        config,
        "--strict-mcp-config",
        "--allowedTools",
        "mcp__openbus__list_agents,mcp__openbus__send_message",
        "--max-turns",
        "5",
      ],
      {
        cwd: ws,
        env: {
          // The daemon's HOME: it reads this Claude's ~/.claude/sessions.
          HOME: homes.home,
          PATH: childPath(codexBin),
          ANTHROPIC_BASE_URL: anthropic.url,
          ANTHROPIC_API_KEY: "sk-ant-e2e-not-a-key",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
        },
      },
    );
    expect(await exited(run)).toBe(0);
    const out = (tool: string) =>
      anthropic.seen.find((s) => s.answers === tool)?.output ?? "";
    // Itself (named for its directory) and the peer.
    expect(out("list_agents")).toMatch(/\(claude-code, cc,/);
    expect(out("list_agents")).toMatch(/^- peer \(pi, cc,/m);
    expect(out("send_message")).toMatch(/Delivered to peer/);
    expect(p.delivered).toEqual([
      expect.objectContaining({ namespace: "cc", body: "hello from claude" }),
    ]);
  });
});
