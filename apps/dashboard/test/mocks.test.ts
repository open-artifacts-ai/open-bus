import { expect, test } from "vitest";
import { fixtures } from "../src/mocks/fixtures";
import { createMockBus, handlersFor } from "../src/mocks/handlers";
import { installHarness, server } from "./harness";

installHarness();

const live = fixtures.machines.find((m) => !m.revokedAt);
const dead = fixtures.machines.find((m) => m.revokedAt);
if (!live || !dead)
  throw new Error("fixtures need a live and a revoked machine");
const CSRF = { "X-OB-Request": "1" };

test("the fixtures cover two namespaces, a global agent and a revoked machine", () => {
  expect(fixtures.machines).toHaveLength(2);
  expect(new Set(fixtures.agents.map((a) => a.namespace)).size).toBe(2);
  expect(fixtures.agents.some((a) => a.global)).toBe(true);
  expect(fixtures.machines.some((m) => m.revokedAt)).toBe(true);
});

test("revoking a machine drops its agents and tells the stream", async () => {
  const bus = createMockBus();
  const seen: unknown[] = [];
  const off = bus.subscribe((e) => seen.push(e));

  const res = await bus.revoke(live.id);
  expect(res.status).toBe(204);
  expect(
    bus.machines().find((m) => m.id === live.id)?.revokedAt,
  ).not.toBeNull();
  expect(bus.agents().some((a) => a.machineId === live.id)).toBe(false);
  expect(seen).toEqual([
    { type: "agents", agents: bus.agents() },
    { type: "machines", machines: bus.machines() },
  ]);

  expect((await bus.revoke(live.id)).status).toBe(404);
  expect((await bus.revoke(dead.id)).status).toBe(404);
  expect((await bus.revoke("nope")).status).toBe(404);
  off();
});

test("events are per subscriber and unsubscribe cleanly", () => {
  const bus = createMockBus();
  const a: unknown[] = [];
  const b: unknown[] = [];
  const offA = bus.subscribe((e) => a.push(e));
  bus.subscribe((e) => b.push(e));
  bus.push({ type: "hello" });
  offA();
  bus.push({ type: "hello" });
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(2);
});

test("GET endpoints answer from the fixtures, the agents list filters by namespace", async () => {
  const bus = createMockBus();
  server.use(...handlersFor(bus));
  const machines = await (await fetch("/api/v1/machines")).json();
  expect(machines.machines).toHaveLength(2);
  expect((await (await fetch("/api/v1/me")).json()).user.email).toContain("@");
  const all = await (await fetch("/api/v1/agents")).json();
  expect(all.agents).toHaveLength(fixtures.agents.length);
  const ns = fixtures.agents[0]?.namespace ?? "";
  const some = await (
    await fetch(`/api/v1/agents?namespace=${encodeURIComponent(ns)}`)
  ).json();
  expect(
    some.agents.every((a: { namespace: string }) => a.namespace === ns),
  ).toBe(true);
});

test("DELETE needs X-OB-Request, then 204 once, then 404", async () => {
  const bus = createMockBus();
  server.use(...handlersFor(bus));
  const url = `/api/v1/machines/${live.id}`;

  const noCsrf = await fetch(url, { method: "DELETE" });
  expect(noCsrf.status).toBe(403);
  expect((await noCsrf.json()).error.code).toBe("csrf");
  expect(bus.machines().find((m) => m.id === live.id)?.revokedAt).toBeNull();

  expect((await fetch(url, { method: "DELETE", headers: CSRF })).status).toBe(
    204,
  );
  const again = await fetch(url, { method: "DELETE", headers: CSRF });
  expect(again.status).toBe(404);
  expect((await again.json()).error.code).toBe("not_found");
  const after = await (await fetch("/api/v1/agents")).json();
  expect(
    after.agents.some((a: { machineId: string }) => a.machineId === live.id),
  ).toBe(false);
});

test("the events stream opens with hello, then carries pushed frames as data: lines", async () => {
  const bus = createMockBus();
  server.use(...handlersFor(bus));
  const res = await fetch("/api/v1/events");
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let buf = "";
  // Chunks may coalesce frames, so read until the wanted text has arrived.
  const until = async (text: string) => {
    while (!buf.includes(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
  };
  const frame = (e: unknown) => `data: ${JSON.stringify(e)}\n\n`;

  await until(frame({ type: "hello" }));
  expect(buf).toBe(frame({ type: "hello" }));
  const del = await fetch(`/api/v1/machines/${live.id}`, {
    method: "DELETE",
    headers: CSRF,
  });
  expect(del.status).toBe(204);
  const agents = frame({ type: "agents", agents: bus.agents() });
  const machines = frame({ type: "machines", machines: bus.machines() });
  await until(machines);
  expect(buf).toBe(frame({ type: "hello" }) + agents + machines);
  // Not awaited: msw's node interceptor never settles a cancel on a live stream.
  void reader.cancel();
});
