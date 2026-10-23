import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { HubConnection, type HubOptions } from "../src/hub.ts";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

async function listen(wss: WebSocketServer): Promise<string> {
  servers.push(wss);
  if (!wss.address()) {
    await new Promise<void>((r) => wss.once("listening", () => r()));
  }
  const addr = wss.address() as { port: number };
  return `ws://127.0.0.1:${addr.port}/hub`;
}

const types = (seen: unknown[]) =>
  seen.map((f) => (f as { type: string }).type);

function opts(url: string, over: Partial<HubOptions> = {}): HubOptions {
  return {
    url,
    token: "ob_machine_x",
    label: "laptop",
    version: "0.1.0",
    sessions: () => ({ open: ["a1"], closed: ["b2"] }),
    onFrame: () => {},
    onRevoked: () => {},
    onOpen: () => {},
    backoffMs: () => 10,
    ...over,
  };
}

describe("hub connection", () => {
  it("sends hello, then sessions on every reconnect", async () => {
    const seen: unknown[] = [];
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wss.on("connection", (ws, req) => {
      expect(req.headers.authorization).toBe("Bearer ob_machine_x");
      ws.on("message", (d) => seen.push(JSON.parse(String(d))));
    });
    const hub = new HubConnection(opts(await listen(wss)));
    hub.start();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
    expect(seen[0]).toMatchObject({
      v: 1,
      type: "hello",
      machine_label: "laptop",
    });
    expect(seen[1]).toMatchObject({
      v: 1,
      type: "sessions",
      open: ["a1"],
      closed: ["b2"],
    });
    wss.clients.forEach((c) => {
      c.close();
    });
    await vi.waitFor(() =>
      expect(types(seen).filter((t) => t === "hello").length).toBe(2),
    );
    await vi.waitFor(() =>
      expect(types(seen).filter((t) => t === "sessions").length).toBe(2),
    );
    hub.stop();
  });

  it("stops and reports revocation on close 4403", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let connections = 0;
    wss.on("connection", (ws) => {
      connections++;
      ws.close(4403, "revoked");
    });
    const onRevoked = vi.fn();
    const hub = new HubConnection(opts(await listen(wss), { onRevoked }));
    hub.start();
    await vi.waitFor(() => expect(onRevoked).toHaveBeenCalled());
    expect(hub.reconnecting).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(connections).toBe(1);
    hub.stop();
  });

  it("does not reconnect when stop() lands during a backoff timer", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let connections = 0;
    wss.on("connection", (ws) => {
      connections++;
      ws.close();
    });
    const hub = new HubConnection(
      opts(await listen(wss), { backoffMs: () => 60 }),
    );
    hub.start();
    await vi.waitFor(() => expect(hub.reconnecting).toBe(true));
    hub.stop();
    await new Promise((r) => setTimeout(r, 150));
    expect(connections).toBe(1);
  });

  it("delivers decoded frames and survives a throwing onFrame", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wss.on("connection", (ws) => {
      ws.send("not json");
      ws.send(JSON.stringify({ v: 1, id: "x", type: "hello" })); // daemon->hub type
      ws.send(
        JSON.stringify({
          v: 1,
          id: "1",
          type: "roster_changed",
          namespace: "n",
        }),
      );
      ws.send(
        JSON.stringify({
          v: 1,
          id: "2",
          type: "roster_changed",
          namespace: "m",
        }),
      );
    });
    const got: unknown[] = [];
    const log = vi.fn();
    const hub = new HubConnection(
      opts(await listen(wss), {
        log,
        onFrame: (f) => {
          got.push(f);
          throw new Error("consumer bug");
        },
      }),
    );
    hub.start();
    await vi.waitFor(() => expect(got.length).toBe(2));
    expect(got[0]).toMatchObject({ type: "roster_changed", namespace: "n" });
    expect(hub.open).toBe(true);
    expect(JSON.stringify(log.mock.calls)).not.toContain("ob_machine_x");
    hub.stop();
  });
});

describe("a frame the encoder refuses", () => {
  it("is not sent, is logged without its body, and the daemon keeps going", async () => {
    const { encodeFrame } = await import("@ob/shared");
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const url = await listen(wss);
    const seen: { type: string; body?: string }[] = [];
    wss.on("connection", (ws) =>
      ws.on("message", (d) => seen.push(JSON.parse(String(d)))),
    );
    const log = vi.fn();
    let opened!: () => void;
    const open = new Promise<void>((r) => {
      opened = r;
    });
    const hub = new HubConnection(
      opts(url, {
        log,
        onOpen: () => opened(),
        encode: (f) => {
          if (f.type === "send") throw new RangeError("lone surrogate");
          return encodeFrame(f);
        },
      }),
    );
    hub.start();
    await open;
    const ok = hub.send({
      v: 1,
      id: "s1",
      type: "send",
      from_ref: "a1",
      to_name: "peer",
      body: "SECRET-BODY",
    });
    expect(ok).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/could not encode/));
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET-BODY");
    expect(hub.send({ v: 1, id: "l1", type: "list", from_ref: "a1" })).toBe(
      true,
    );
    await vi.waitFor(() => expect(types(seen)).toContain("list"));
    expect(types(seen)).not.toContain("send");
    hub.stop();
  });
});
