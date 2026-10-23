import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApiErrorSchema } from "../errors.js";
import { LIMITS } from "../limits.js";
import {
  AgentSchema,
  AgentsResponseSchema,
  BusEventSchema,
  CSRF_HEADER,
  CSRF_VALUE,
  MachineSchema,
  MachinesResponseSchema,
  MeSchema,
} from "../rest.js";
import { agents, machines, me } from "./fixtures.js";
import { handlers, resetMocks } from "./handlers.js";

const B = "https://bus.test";
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("missing fixture");
  return v;
};
const server = setupServer(...handlers);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => resetMocks());
afterAll(() => server.close());

const del = (id: string, csrf = true) =>
  fetch(`${B}/api/v1/machines/${id}`, {
    method: "DELETE",
    headers: csrf ? { [CSRF_HEADER]: CSRF_VALUE } : {},
  });
const list = async () =>
  MachinesResponseSchema.parse(
    await (await fetch(`${B}/api/v1/machines`)).json(),
  ).machines;

describe("fixtures", () => {
  it("parse with the contract schemas", () => {
    for (const m of machines) MachineSchema.parse(m);
    for (const a of agents) AgentSchema.parse(a);
    MeSchema.parse(me);
  });
  it("cover live, queued and revoked", () => {
    expect(agents.some((a) => a.state === "live")).toBe(true);
    expect(agents.some((a) => a.state === "queued")).toBe(true);
    expect(machines.some((m) => m.revokedAt !== null)).toBe(true);
    expect(machines.some((m) => m.revokedAt === null)).toBe(true);
  });
});

describe("handlers", () => {
  it("serves me", async () => {
    const r = MeSchema.parse(await (await fetch(`${B}/api/v1/me`)).json());
    expect(r.user.email).toContain("@");
  });

  it("lists active and revoked machines, newest first, within the cap", async () => {
    const ms = await list();
    expect(ms).toHaveLength(machines.length);
    expect(ms.length).toBeLessThanOrEqual(LIMITS.maxMachinesListed);
    expect(ms.some((m) => m.revokedAt)).toBe(true);
    const created = ms.map((m) => m.createdAt);
    expect(created).toEqual([...created].sort().reverse());
  });

  it("filters agents by namespace, keeping global ones", async () => {
    const ns = must(agents.find((a) => !a.global)).namespace;
    const r = AgentsResponseSchema.parse(
      await (
        await fetch(`${B}/api/v1/agents?namespace=${encodeURIComponent(ns)}`)
      ).json(),
    );
    expect(r.agents.length).toBeGreaterThan(0);
    expect(r.agents.every((a) => a.namespace === ns || a.global)).toBe(true);
    const all = AgentsResponseSchema.parse(
      await (await fetch(`${B}/api/v1/agents`)).json(),
    );
    expect(all.agents).toHaveLength(agents.length);
  });

  it("revokes once (204), keeps the row listed, then 404s", async () => {
    const id = must(machines.find((m) => !m.revokedAt)).id;
    expect((await del(id)).status).toBe(204);
    const after = (await list()).find((m) => m.id === id);
    expect(after?.revokedAt).not.toBeNull();
    const again = await del(id);
    expect(again.status).toBe(404);
    ApiErrorSchema.parse(await again.json());
  });

  it("404s an unknown or already-revoked machine with a valid envelope", async () => {
    for (const id of [
      must(machines.find((m) => m.revokedAt)).id,
      "zzzzzzzzzzzzzzzz",
    ]) {
      const r = await del(id);
      expect(r.status).toBe(404);
      expect(ApiErrorSchema.parse(await r.json()).error.code).toBe("not_found");
    }
  });

  it("403s DELETE without the CSRF header and does not revoke", async () => {
    const id = must(machines.find((m) => !m.revokedAt)).id;
    const r = await del(id, false);
    expect(r.status).toBe(403);
    expect(ApiErrorSchema.parse(await r.json()).error.code).toBe("csrf");
    expect((await list()).find((m) => m.id === id)?.revokedAt).toBeNull();
  });

  it("resetMocks undoes mutations between tests", async () => {
    const id = must(machines.find((m) => !m.revokedAt)).id;
    await del(id);
    resetMocks();
    expect((await list()).find((m) => m.id === id)?.revokedAt).toBeNull();
    expect((await del(id)).status).toBe(204);
  });

  it("streams hello, machines, agents as data-only frames", async () => {
    const res = await fetch(`${B}/api/v1/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = must(res.body ?? undefined).getReader();
    const dec = new TextDecoder();
    let buf = "";
    while ((buf.match(/\n\n/g) ?? []).length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    // Not awaited: msw's interceptor never settles cancel() on an open stream.
    void reader.cancel();
    expect(buf).not.toMatch(/^event:/m);
    const frames = buf
      .split("\n\n")
      .filter(Boolean)
      .map((f) => {
        expect(f.startsWith("data: ")).toBe(true);
        return BusEventSchema.parse(JSON.parse(f.slice(6)));
      });
    expect(frames.map((f) => f.type)).toEqual(["hello", "machines", "agents"]);
    const ms = frames[1];
    if (ms?.type === "machines")
      expect(ms.machines.some((m) => m.revokedAt)).toBe(true);
  });
});
