import { runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ClientFrame,
  decodeServerFrame,
  encodeFrame,
  PONG,
  type ServerFrame,
} from "@ob/shared";
import { expect } from "vitest";
import type { Env } from "../src/env.js";
import { FRAME_BUDGET, type Hub } from "../src/hub/do.js";
import { hub } from "../src/hub/stub.js";

export const e = env as unknown as Env;

/** Seeds a machine on the owner hub (no admin route before B1/B4). */
export async function machine(
  label = "MacBook",
): Promise<{ id: string; token: string }> {
  const m = await hub(e).createMachine(label);
  if (!m.ok) throw new Error(`createMachine refused: ${m.code}`);
  return { id: m.id, token: m.token };
}

/** Runs `fn` inside the owner hub (SQL seeding, revokes). */
export const inOwnerHub = <R>(fn: (s: DurableObjectState) => R) =>
  runInDurableObject(
    hub(e) as unknown as DurableObjectStub<Hub>,
    (_: Hub, s: DurableObjectState) => fn(s),
  );

export type Daemon = {
  ws: WebSocket;
  /** Every raw text message received, in order (frames and PONGs). */
  raw: string[];
  next: () => Promise<ServerFrame>;
  send: (f: ClientFrame) => void;
  close: () => void;
  closed: Promise<{ code: number; reason: string }>;
};

/** Upgrades /hub through the Worker entry point, exactly as the daemon does. */
export function upgrade(
  token: string | null,
  extra: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: "websocket", ...extra };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return SELF.fetch("https://app.localhost/hub", { headers });
}

/** A daemon socket. Every frame it receives must parse with decodeServerFrame. */
export async function daemon(
  token: string,
  extra: Record<string, string> = {},
): Promise<Daemon> {
  const res = await upgrade(token, extra);
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  const raw: string[] = [];
  const queue: ServerFrame[] = [];
  const waiting: ((f: ServerFrame) => void)[] = [];
  ws.addEventListener("message", (ev) => {
    const text = String(ev.data);
    raw.push(text);
    if (text === PONG) return;
    const r = decodeServerFrame(text);
    // Recorded, then failed loudly in the test that reads it.
    expect(r.ok, `not a server frame: ${text}`).toBe(true);
    if (!r.ok) return;
    const w = waiting.shift();
    if (w) w(r.frame);
    else queue.push(r.frame);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (ev) =>
      resolve({ code: ev.code, reason: ev.reason }),
    ),
  );
  const next = () => {
    const f = queue.shift();
    if (f) return Promise.resolve(f);
    return new Promise<ServerFrame>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("timed out waiting for a frame")),
        2000,
      );
      waiting.push((frame) => {
        clearTimeout(t);
        resolve(frame);
      });
    });
  };
  return {
    ws,
    raw,
    next,
    send: (f) => ws.send(encodeFrame(f)),
    close: () => ws.close(1000, "bye"),
    closed,
  };
}

/** Consumes frames until one matches `type` (roster broadcasts may interleave). */
export async function waitFor<T extends ServerFrame["type"]>(
  conn: { next: () => Promise<ServerFrame> },
  type: T,
): Promise<Extract<ServerFrame, { type: T }>> {
  for (let i = 0; i < 5000; i++) {
    const f = await conn.next();
    if (f.type === type) return f as Extract<ServerFrame, { type: T }>;
  }
  throw new Error(`no ${type} frame`);
}

/** Every server frame received so far, parsed (PONGs skipped). */
export const framesSeen = (d: Daemon): ServerFrame[] =>
  d.raw
    .filter((t) => t !== PONG)
    .map((t) => {
      const r = decodeServerFrame(t);
      if (!r.ok) throw new Error(`not a server frame: ${t}`);
      return r.frame;
    });

let seq = 0;
/** A namespace no other test uses, so names never collide across tests. */
export const ns = (tag = "ns") => `test.local/${tag}-${++seq}-${Date.now()}`;

export const hello = (id = "h1"): ClientFrame => ({
  v: 1,
  id,
  type: "hello",
  machine_label: "MacBook",
  client_version: "0.1.0",
});

export const up = (
  id: string,
  ref: string,
  name: string,
  namespace: string,
  global = false,
): ClientFrame => ({
  v: 1,
  id,
  type: "agent_up",
  agent_ref: ref,
  kind: "opencode",
  proposed_name: name,
  namespace,
  global,
});

/** Opens a daemon, says hello and registers agents; returns the socket. */
export async function ready(token: string): Promise<Daemon> {
  const d = await daemon(token);
  d.send(hello());
  await waitFor(d, "hello_ok");
  return d;
}

/**
 * Waits out the hub's per-socket frame budget window (B11), so a test that
 * bursts more than FRAME_BUDGET.frames frames on one socket starts a fresh one.
 */
export const nextFrameWindow = () =>
  new Promise((r) => setTimeout(r, FRAME_BUDGET.windowMs + 50));
