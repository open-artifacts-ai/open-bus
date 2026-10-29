// AC5a: set_status and card, from the adapter through the daemon to a stub hub.
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { daemonStatus, LineDecoder } from "@ob/ipc";
import { AGENT_CARD_MIN_CLIENT, CARD_REFUSAL_CODES } from "@ob/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CARD_COPY } from "../src/card.ts";
import type { DaemonDeps } from "../src/index.ts";
import * as V0441 from "./fixtures/ipc-v0.44.1.ts";
import * as V0540 from "./fixtures/ipc-v0.54.0.ts";
import { daemonHarness, stopAll } from "./helpers.ts";

afterEach(stopAll);

const GATE = AGENT_CARD_MIN_CLIENT;
const AUD = "https://artifacts.example.com";
const NONCE = "nonce_0123456789-AB";
/** A compact JWS shape; its value must never reach a log or a file. */
const JWT = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJTRUNSRVRDQVJEIn0.c2lnU0VDUkVUU0lH";

/** A daemon at the gate, with an adapter (marker at the gate) for agent A. */
async function bus(over: Partial<DaemonDeps> = {}) {
  const h = await daemonHarness({
    version: GATE,
    ...over,
    card: { statusSettleMs: 30, ...over.card },
  });
  const a = await h.adapter("A", { client_version: GATE });
  return { h, a };
}

describe("set_status (AC5a)", () => {
  it("sends the hub a status frame from the attested agent, answered once the hub stays silent", async () => {
    const { h, a } = await bus();
    const reply = await a.request({
      type: "set_status",
      state: "working",
      label: "writing tests",
    });
    expect(reply).toMatchObject({ type: "status_set" });
    expect(await h.next("status")).toMatchObject({
      type: "status",
      from_ref: "A",
      state: "working",
      label: "writing tests",
    });
  });

  it.each(["bad_frame", "not_registered"])(
    "maps the hub's %s for that id onto the reply",
    async (code) => {
      const { h, a } = await bus({ card: { statusSettleMs: 5000 } });
      const reply = a.request({ type: "set_status", state: "idle" });
      const sent = await h.next("status");
      h.toDaemon({ id: sent.id, type: "error", code, message: "x" });
      expect(await reply).toMatchObject({
        type: "error",
        code,
        message: CARD_COPY[code as keyof typeof CARD_COPY],
      });
    },
  );

  it("refuses an invalid status locally: nothing reaches the hub", async () => {
    const { h, a } = await bus();
    for (const bad of [
      { state: "done" },
      { state: "idle", label: "x".repeat(65) },
      { state: "idle", label: "a\u0007b" },
    ])
      expect(await a.request({ type: "set_status", ...bad })).toMatchObject({
        type: "error",
        code: "bad_frame",
      });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.of("status")).toHaveLength(0);
  });

  it("the local guard: one frame per agent per window, the latest kept", async () => {
    const { h, a } = await bus({
      card: { statusEveryMs: 300, statusSettleMs: 20 },
    });
    const states = ["working", "blocked", "idle", "waiting_on_owner"] as const;
    const replies = states.map((state, i) =>
      a.request({ type: "set_status", state, label: `step ${i}` }),
    );
    // Every call is answered, the superseded ones included.
    for (const r of await Promise.all(replies))
      expect(r).toMatchObject({ type: "status_set" });
    const sent = h.of("status");
    expect(sent.map((f) => [f.state, f.label])).toEqual([
      ["working", "step 0"],
      ["waiting_on_owner", "step 3"],
    ]);
    // Nothing else goes once the window closes with nothing queued.
    await new Promise((r) => setTimeout(r, 400));
    expect(h.of("status")).toHaveLength(2);
    // Each agent has its own window.
    const b = await h.adapter("B", { client_version: GATE });
    await b.request({ type: "set_status", state: "idle" });
    expect(h.of("status").at(-1)).toMatchObject({ from_ref: "B" });
  });
});

describe("card (AC5a)", () => {
  it("round trip: card_request out, the JWS back untouched", async () => {
    const { h, a } = await bus();
    const reply = a.request({ type: "card", aud: AUD, nonce: NONCE });
    const req = await h.next("card_request");
    expect(req).toMatchObject({ from_ref: "A", aud: AUD, nonce: NONCE });
    h.toDaemon({ id: req.id, type: "card", jwt: JWT });
    expect(await reply).toMatchObject({ type: "card", jwt: JWT });
  });

  it.each([...CARD_REFUSAL_CODES])("maps card_refused %s", async (code) => {
    const { h, a } = await bus();
    const reply = a.request({ type: "card", aud: AUD, nonce: NONCE });
    const req = await h.next("card_request");
    h.toDaemon({ id: req.id, type: "card_refused", code });
    expect(await reply).toMatchObject({
      type: "error",
      code,
      message: CARD_COPY[code],
    });
  });

  it("maps the hub's not_registered and bad_frame errors", async () => {
    const { h, a } = await bus();
    for (const [n, code] of [
      [1, "not_registered"],
      [2, "bad_frame"],
    ] as const) {
      const reply = a.request({ type: "card", aud: AUD, nonce: NONCE });
      const req = await h.next("card_request", n);
      h.toDaemon({ id: req.id, type: "error", code, message: "x" });
      expect(await reply).toMatchObject({ type: "error", code });
    }
  });

  it("times out after the wait and never retries: a nonce is single use", async () => {
    const { h, a } = await bus({ card: { timeoutMs: 100 } });
    const reply = await a.request({ type: "card", aud: AUD, nonce: NONCE });
    expect(reply).toMatchObject({
      type: "error",
      code: "timeout",
      message: CARD_COPY.timeout,
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(h.of("card_request")).toHaveLength(1);
    // A late answer is dropped: no stray frame reaches the adapter.
    const req = await h.next("card_request");
    h.toDaemon({ id: req.id, type: "card", jwt: JWT });
    expect(await a.request({ type: "self" })).toMatchObject({ type: "agent" });
  });

  it("validates aud and nonce locally", async () => {
    const { h, a } = await bus();
    for (const bad of [
      { aud: "https://a.example/path", nonce: NONCE },
      { aud: "http://a.example", nonce: NONCE },
      { aud: AUD, nonce: "short" },
    ])
      expect(await a.request({ type: "card", ...bad })).toMatchObject({
        type: "error",
        code: "bad_frame",
      });
    expect(h.of("card_request")).toHaveLength(0);
  });

  it("a dropped hub link answers hub_unavailable, not a timeout", async () => {
    const { h, a } = await bus();
    const reply = a.request({ type: "card", aud: AUD, nonce: NONCE });
    await h.next("card_request");
    h.hubSock()?.terminate();
    expect(await reply).toMatchObject({
      type: "error",
      code: "hub_unavailable",
    });
  });

  it("the JWS is never logged, stored or in status", async () => {
    const lines: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "ob-card-"));
    const { h, a } = await bus({
      debug: true,
      log: (m) => lines.push(m),
      sentFile: join(dir, "sent.json"),
    });
    // Its parts too: a log line must not carry any of them.
    const secret = [JWT, ...JWT.split(".").slice(1)];
    const reply = a.request({ type: "card", aud: AUD, nonce: NONCE });
    const req = await h.next("card_request");
    h.toDaemon({ id: req.id, type: "card", jwt: JWT });
    expect(await reply).toMatchObject({ jwt: JWT });
    // A card frame the decoder rejects is logged, by type only.
    h.toDaemon({ id: "zz", type: "card", jwt: `${JWT}!` });
    await vi.waitFor(() =>
      expect(lines.some((l) => l.includes("dropped"))).toBe(true),
    );
    const st = await daemonStatus({ path: h.socketPath, timeoutMs: 3000 });
    const files = [dir, dirname(h.socketPath)].flatMap((d) =>
      readdirSync(d).map((f) => join(d, f)),
    );
    const written = files
      .filter((p) => statSync(p).isFile())
      .map((p) => readFileSync(p, "utf8"));
    for (const s of secret) {
      expect(JSON.stringify(st)).not.toContain(s);
      for (const l of lines) expect(l).not.toContain(s);
      for (const w of written) expect(w).not.toContain(s);
    }
  });
});

describe("the gate (AC5a)", () => {
  it("a daemon below the gate refuses both, sends nothing, and self says its version", async () => {
    const { h, a } = await bus({ version: "0.53.0" });
    for (const f of [
      { type: "set_status" as const, state: "idle" },
      { type: "card" as const, aud: AUD, nonce: NONCE },
    ])
      expect(await a.request(f)).toMatchObject({
        type: "error",
        code: "unsupported",
        message: CARD_COPY.unsupported,
      });
    expect(h.of("status")).toHaveLength(0);
    expect(h.of("card_request")).toHaveLength(0);
    expect(await a.request({ type: "self" })).toMatchObject({
      daemon_version: "0.53.0",
    });
  });

  it("a hub below the gate is refused cleanly with update the hub", async () => {
    const { h, a } = await bus({ card: { statusEveryMs: 1 } });
    h.toDaemon({
      id: "w",
      type: "hello_ok",
      machine_id: "1".repeat(16),
      machine_label: "laptop",
      server_version: "0.53.0",
    });
    await vi.waitFor(async () =>
      expect(
        await a.request({ type: "set_status", state: "idle" }),
      ).toMatchObject({
        code: "hub_outdated",
        message: CARD_COPY.hub_outdated,
      }),
    );
    expect(
      await a.request({ type: "card", aud: AUD, nonce: NONCE }),
    ).toMatchObject({ code: "hub_outdated" });
    expect(h.of("status")).toHaveLength(0);
    expect(h.of("card_request")).toHaveLength(0);
    // At the gate, and a dev hub, both go through.
    for (const server_version of [GATE, "dev"]) {
      h.toDaemon({
        id: "w",
        type: "hello_ok",
        machine_id: "1".repeat(16),
        machine_label: "laptop",
        server_version,
      });
      await vi.waitFor(async () =>
        expect(
          await a.request({ type: "set_status", state: "idle" }),
        ).toMatchObject({ type: "status_set" }),
      );
    }
  });
});

/** A raw IPC client: writes `frames` in order and returns every line the daemon wrote. */
function talk(
  path: string,
  frames: object[],
  want: number,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    const decoder = new LineDecoder();
    const got: unknown[] = [];
    sock.once("error", reject);
    sock.once("connect", () => {
      for (const f of frames) sock.write(`${JSON.stringify(f)}\n`);
    });
    sock.on("data", (chunk) => {
      got.push(...decoder.push(chunk));
      if (got.length >= want) {
        sock.destroy();
        resolve(got);
      }
    });
  });
}
const helloOf = (agent_ref: string, marker?: string) => ({
  v: 1,
  id: "hello",
  type: "hello",
  kind: "claude-code",
  agent_ref,
  pid: process.pid,
  cwd: "/w",
  proposed_name: agent_ref,
  attest: {},
  ...(marker ? { client_version: marker } : {}),
});

/** A hub that answers list with a role holder and a send to `lane-6` with role_vacant. */
async function cardHub() {
  const h = await daemonHarness({ version: GATE });
  h.hubSock()?.on("message", (d) => {
    const f = JSON.parse(String(d));
    if (f.type === "list")
      h.toDaemon({
        id: f.id,
        type: "roster",
        agents: [
          {
            bus_name: "code-96",
            kind: "claude-code",
            namespace: "ns",
            global: false,
            state: "live",
            role: "lane-6",
            status: "working",
            status_label: "writing tests",
            status_at: "2026-10-29T12:00:00.000Z",
          },
        ],
      });
    if (f.type === "send")
      h.toDaemon({
        id: f.id,
        type: "receipt",
        msg_id: "mmmmmmmmmmmmmmm1",
        state: "refused",
        reason: f.to_name === "lane-6" ? "role_vacant" : "ambiguous",
        to_name: "code-96",
      });
  });
  return h;
}
const asks = [
  { v: 1, id: "l", type: "list" },
  { v: 1, id: "s", type: "send", to: "lane-6", body: "hi" },
];

describe("roster role and status, receipt to_name, role_vacant (AC5a)", () => {
  it("a client at the gate sees them all", async () => {
    const h = await cardHub();
    const [, roster, receipt] = (await talk(
      h.socketPath,
      [helloOf("ses_new", GATE), ...asks],
      3,
    )) as [unknown, { agents: object[] }, object];
    expect(roster.agents[0]).toMatchObject({
      name: "code-96",
      role: "lane-6",
      status: "working",
      status_label: "writing tests",
      status_at: "2026-10-29T12:00:00.000Z",
    });
    expect(receipt).toMatchObject({
      state: "refused",
      reason: "role_vacant",
      to_name: "code-96",
    });
  });

  it.each([
    ["0.54.0's frozen decoder, marker below the gate", "0.53.0", V0540],
    ["0.44.1's frozen decoder, no marker", undefined, V0441],
  ])("%s decodes every reply, with none of them", async (_, marker, V) => {
    const h = await cardHub();
    const frames = await talk(
      h.socketPath,
      [helloOf("ses_old", marker), ...asks],
      3,
    );
    const decoded = frames.map((f) => V.DaemonFrame.parse(f));
    const [, roster, receipt] = frames as [
      unknown,
      { agents: object[] },
      object,
    ];
    expect(roster.agents[0]).not.toHaveProperty("role");
    expect(roster.agents[0]).not.toHaveProperty("status");
    expect(receipt).not.toHaveProperty("to_name");
    expect(decoded[2]).toMatchObject({
      type: "receipt",
      reason: "unknown_agent",
    });
  });

  it("control: role_vacant unmapped fails the frozen decoders", () => {
    const r = {
      v: 1,
      id: "s",
      type: "receipt",
      msg_id: "m",
      state: "refused",
      reason: "role_vacant",
    };
    expect(V0540.DaemonFrame.safeParse(r).success).toBe(false);
    expect(V0441.DaemonFrame.safeParse(r).success).toBe(false);
  });
});
