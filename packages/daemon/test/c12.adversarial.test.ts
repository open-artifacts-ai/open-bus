import type { ClientFrame } from "@ob/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { HubConnection } from "../src/hub.ts";
import { Outbox } from "../src/outbox.ts";
import { FramePacer } from "../src/pacer.ts";

const f = (type: string, n = 0) =>
  ({ v: 1, id: `${type}-${n}`, type }) as unknown as ClientFrame;

describe("C12 adversarial", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a sessions snapshot does not overtake a send queued before it", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const p = new FramePacer({ send: (d) => out.push(d) > 0 });
    for (let i = 0; i < 10; i++) p.push(f("send", i), `send-${i}`);
    p.push(f("sessions"), "sessions");
    vi.advanceTimersByTime(5_000);
    // A native reply then its session closing: the hub must see the send first.
    expect(out.indexOf("sessions")).toBeGreaterThan(out.indexOf("send-9"));
  });

  it("a user send is not starved past the 10 s pending timeout by a reconnect ack/agent_up backlog", () => {
    vi.useFakeTimers();
    const out: { d: string; at: number }[] = [];
    const t0 = Date.now();
    const p = new FramePacer({ send: (d) => out.push({ d, at: Date.now() }) > 0 });
    for (let i = 0; i < 200; i++) p.push(f("agent_up", i), `up-${i}`);
    for (let i = 0; i < 200; i++) p.push(f("ack", i), `ack-${i}`);
    p.push(f("send"), "user-send");
    vi.advanceTimersByTime(30_000);
    const at = out.find((o) => o.d === "user-send")?.at ?? Infinity;
    expect(at - t0).toBeLessThan(10_000);
  });

  it("an Outbox reply queued in the pacer survives a link drop", async () => {
    const got: string[] = [];
    let conns = 0;
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    wss.on("connection", (ws) => {
      conns++;
      const first = conns === 1;
      ws.on("message", (d) => {
        const fr = JSON.parse(String(d));
        if (fr.type === "send") got.push(fr.id);
        // Drop the first link once a few replies got through.
        if (first && got.length === 3) ws.terminate();
      });
    });
    const port = (wss.address() as { port: number }).port;
    let outbox!: Outbox<ClientFrame>;
    let opened!: () => void;
    const ready = new Promise<void>((r) => {
      opened = r;
    });
    const hub = new HubConnection({
      url: `ws://127.0.0.1:${port}/hub`,
      token: "ob_machine_x",
      label: "l",
      version: "0",
      sessions: () => ({ open: [], closed: [] }),
      onFrame: () => {},
      onRevoked: () => {},
      onOpen: () => {
        outbox?.flush();
        opened();
      },
      backoffMs: () => 10,
    });
    outbox = new Outbox<ClientFrame>({
      send: (fr, unsent) => hub.send(fr, unsent),
    });
    hub.start();
    await ready;
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      ids.push(id);
      outbox.push({
        v: 1,
        id,
        type: "send",
        from_ref: "a1",
        to_name: "peer",
        body: `reply ${i}`,
      } as ClientFrame);
    }
    try {
      await vi.waitFor(() => expect(new Set(got)).toEqual(new Set(ids)), {
        timeout: 4000,
      });
    } finally {
      hub.stop();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });
});
