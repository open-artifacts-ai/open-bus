import { SELF } from "cloudflare:test";
import {
  ApiErrorSchema,
  CSRF_HEADER,
  type Machine,
  MachinesResponseSchema,
  R,
} from "@ob/shared";
import { describe, expect, it } from "vitest";
import { machines as mockMachines } from "../../../packages/shared/src/mocks/fixtures.js";
import { ROUTE_POLICY } from "../src/auth/route-policy.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { machineDto } from "../src/hub/dto.js";
import { hub } from "../src/hub/stub.js";
import { e, machine, ready } from "./helpers.js";

// B9-rest: GET /api/v1/machines and DELETE /api/v1/machines/:id through the
// deployed entry point and the real session gate (B2b).

const ORIGIN = `https://${e.APP_HOST}`;
const cookie = async () => `${sessionCookieName(e)}=${await signSession(e)}`;

const list = async (headers: Record<string, string> = {}) =>
  SELF.fetch(`${ORIGIN}${R.machines}`, { headers });

const del = async (id: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`${ORIGIN}/api/v1/machines/${id}`, {
    method: "DELETE",
    headers,
  });

const okDelete = async (id: string) =>
  del(id, { cookie: await cookie(), origin: ORIGIN, [CSRF_HEADER]: "1" });

async function code(r: Response) {
  return ApiErrorSchema.parse(await r.json()).error.code;
}

async function listed(): Promise<Machine[]> {
  const r = await list({ cookie: await cookie() });
  expect(r.status).toBe(200);
  return MachinesResponseSchema.parse(await r.json()).machines;
}

describe("route policy", () => {
  it("lists both routes as plain session rows (header CSRF)", () => {
    expect(ROUTE_POLICY["GET /api/v1/machines"]).toEqual({
      session: expect.any(String),
    });
    expect(ROUTE_POLICY["DELETE /api/v1/machines/:id"]).toEqual({
      session: expect.any(String),
    });
  });
});

describe("GET /api/v1/machines", () => {
  it("401s without a session", async () => {
    const r = await list();
    expect(r.status).toBe(401);
    expect(await code(r)).toBe("unauthorized");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("is no-store and returns exactly the hub's rows through machineDto", async () => {
    await machine("shape-check");
    const r = await list({ cookie: await cookie() });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    // The app-wide default; only the approval page overrides it.
    expect(r.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    const body = (await r.json()) as unknown;
    expect(Object.keys(body as object)).toEqual(["machines"]);
    const parsed = MachinesResponseSchema.parse(body);
    expect(parsed.machines).toEqual(
      (await hub(e).listMachines()).map(machineDto),
    );
  });

  it("lists active machines first, then revoked, each newest first, with connected", async () => {
    const a = await machine("order-a");
    const b = await machine("order-b");
    const c = await machine("order-c");
    const d = await ready(c.token);
    expect(await hub(e).revokeMachine(b.id)).toBe(true);

    const ms = await listed();
    const ids = ms.map((m) => m.id);
    const pos = (id: string) => ids.indexOf(id);
    expect(pos(c.id)).toBeGreaterThanOrEqual(0);
    expect(pos(c.id)).toBeLessThan(pos(a.id));
    expect(pos(a.id)).toBeLessThan(pos(b.id));
    // Every active machine precedes every revoked one.
    const firstRevoked = ms.findIndex((m) => m.revokedAt !== null);
    expect(ms.slice(firstRevoked).every((m) => m.revokedAt !== null)).toBe(
      true,
    );

    const byId = new Map(ms.map((m) => [m.id, m]));
    expect(byId.get(c.id)).toMatchObject({
      label: "order-c",
      revokedAt: null,
      connected: true,
    });
    expect(byId.get(a.id)).toMatchObject({ revokedAt: null, connected: false });
    expect(byId.get(b.id)?.revokedAt).toEqual(expect.any(String));
    expect(byId.get(b.id)?.connected).toBe(false);
    d.close();
  });

  it("the shared mocks agree with the real output", async () => {
    // The fixture the dashboard's mocks serve is a valid response...
    expect(
      MachinesResponseSchema.safeParse({ machines: mockMachines }).success,
    ).toBe(true);
    // ...with exactly the keys, in the order, the Worker sends.
    await machine("keys-check");
    const real = await listed();
    const keys = (m: object) => Object.keys(m);
    for (const m of real)
      expect(keys(m)).toEqual(keys(mockMachines[0] as Machine));
    for (const m of mockMachines)
      expect(keys(m)).toEqual(keys(real[0] as Machine));
  });
});

describe("DELETE /api/v1/machines/:id", () => {
  it("401s without a session", async () => {
    const m = await machine("no-session");
    const r = await del(m.id, { origin: ORIGIN, [CSRF_HEADER]: "1" });
    expect(r.status).toBe(401);
    expect(await code(r)).toBe("unauthorized");
  });

  it("403s without X-OB-Request or from another origin", async () => {
    const m = await machine("csrf");
    const c = await cookie();
    const noHeader = await del(m.id, { cookie: c, origin: ORIGIN });
    expect(noHeader.status).toBe(403);
    expect(await code(noHeader)).toBe("csrf");
    const cross = await del(m.id, {
      cookie: c,
      origin: "https://evil.example",
      [CSRF_HEADER]: "1",
    });
    expect(cross.status).toBe(403);
    expect(await code(cross)).toBe("csrf");
    const nullOrigin = await del(m.id, {
      cookie: c,
      origin: "null",
      [CSRF_HEADER]: "1",
    });
    expect(nullOrigin.status).toBe(403);
    expect(await code(nullOrigin)).toBe("csrf");
    // Still active: none of the refusals revoked it.
    expect((await listed()).find((x) => x.id === m.id)?.revokedAt).toBeNull();
  });

  it("204 on the first revoke, then 404 not_found", async () => {
    const m = await machine("revoke-twice");
    const first = await okDelete(m.id);
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    const second = await okDelete(m.id);
    expect(second.status).toBe(404);
    expect(await code(second)).toBe("not_found");
  });

  it("404 not_found for an unknown or malformed id", async () => {
    for (const id of ["aaaaaaaaaaaaaaaa", "m1", "not-an-id!", "x".repeat(40)]) {
      const r = await okDelete(id);
      expect(r.status, id).toBe(404);
      expect(await code(r), id).toBe("not_found");
    }
  });

  it("closes the machine's socket with 4403; GET then shows it revoked and disconnected", async () => {
    const m = await machine("revoke-live");
    const d = await ready(m.token);
    expect((await listed()).find((x) => x.id === m.id)?.connected).toBe(true);
    expect((await okDelete(m.id)).status).toBe(204);
    expect((await d.closed).code).toBe(4403);
    const after = (await listed()).find((x) => x.id === m.id);
    expect(after?.revokedAt).toEqual(expect.any(String));
    expect(after?.connected).toBe(false);
  });
});
