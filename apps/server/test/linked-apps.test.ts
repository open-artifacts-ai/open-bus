import { runInDurableObject, SELF } from "cloudflare:test";
import {
  ApiErrorSchema,
  CSRF_HEADER,
  type LinkedApp,
  LinkedAppsResponseSchema,
  MAX_LINKED_APPS,
  R,
} from "@ob/shared";
import { describe, expect, it } from "vitest";
import { ROUTE_POLICY } from "../src/auth/route-policy.js";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { Hub, type HubStub } from "../src/hub/do.js";
import { isLinked } from "../src/hub/linked-apps.js";
import { hub } from "../src/hub/stub.js";
import { e, machine } from "./helpers.js";

// AC4b Task 7: linked_apps on the hub and the owner-only linked-apps REST.

const ORIGIN = `https://${e.APP_HOST}`;
const cookie = async () => `${sessionCookieName(e)}=${await signSession(e)}`;
const okHeaders = async () => ({
  cookie: await cookie(),
  origin: ORIGIN,
  [CSRF_HEADER]: "1",
});

const list = (headers: Record<string, string> = {}) =>
  SELF.fetch(`${ORIGIN}${R.linkedApps}`, { headers });
const del = (path: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, { method: "DELETE", headers });
const okDelete = async (path: string) => del(path, await okHeaders());

async function error(r: Response) {
  return ApiErrorSchema.parse(await r.json()).error;
}
async function listed(): Promise<LinkedApp[]> {
  const r = await list({ cookie: await cookie() });
  expect(r.status).toBe(200);
  return LinkedAppsResponseSchema.parse(await r.json()).apps;
}

let seq = 0;
const app = () => `https://oa-${++seq}-${Date.now()}.example.com`;

const freshHub = (): HubStub =>
  e.HUB.get(e.HUB.newUniqueId()) as unknown as HubStub;
const inHub = <T>(h: HubStub, fn: (i: Hub, s: DurableObjectState) => T) =>
  runInDurableObject(h as unknown as DurableObjectStub<Hub>, fn);

describe("hub linked_apps", () => {
  it("links (idempotently), lists newest first and unlinks once", async () => {
    const h = freshHub();
    await inHub(h, (i) => Hub.setTestClock(i, 1_000));
    expect(await h.linkApp("https://a.example")).toBe(true);
    await inHub(h, (i) => Hub.setTestClock(i, 2_000));
    expect(await h.linkApp("https://b.example")).toBe(true);
    await inHub(h, (i) => Hub.setTestClock(i, 3_000));
    // Already linked: kept, linked_at unchanged.
    expect(await h.linkApp("https://a.example")).toBe(true);
    expect(await h.listLinkedApps()).toEqual([
      { aud: "https://b.example", linkedAt: 2_000 },
      { aud: "https://a.example", linkedAt: 1_000 },
    ]);
    await inHub(h, (_, s) => {
      expect(isLinked(s.storage.sql, "https://a.example")).toBe(true);
      expect(isLinked(s.storage.sql, "https://c.example")).toBe(false);
    });
    expect(await h.unlinkApp("https://a.example")).toBe(true);
    expect(await h.unlinkApp("https://a.example")).toBe(false);
    expect(await h.unlinkApp("https://c.example")).toBe(false);
    await inHub(h, (_, s) =>
      expect(isLinked(s.storage.sql, "https://a.example")).toBe(false),
    );
    expect((await h.listLinkedApps()).map((a) => a.aud)).toEqual([
      "https://b.example",
    ]);
  });

  it("refuses a non-canonical or malformed aud", async () => {
    const h = freshHub();
    for (const aud of [
      "HTTPS://X",
      "https://x:443",
      "https://x/",
      "http://x",
      "https://x.",
      "",
      42,
      null,
    ] as string[]) {
      expect(await h.linkApp(aud), String(aud)).toBe(false);
      expect(await h.unlinkApp(aud), String(aud)).toBe(false);
    }
    expect(await h.listLinkedApps()).toEqual([]);
  });

  it("refuses a new app at the cap, still accepts a relink, and frees a slot on unlink", async () => {
    const h = freshHub();
    for (let n = 0; n < MAX_LINKED_APPS; n++)
      expect(await h.linkApp(`https://a${n}.example`)).toBe(true);
    expect(await h.linkApp("https://over.example")).toBe(false);
    expect(await h.linkApp("https://a0.example")).toBe(true);
    expect(await h.listLinkedApps()).toHaveLength(MAX_LINKED_APPS);
    expect(await h.unlinkApp("https://a5.example")).toBe(true);
    expect(await h.linkApp("https://over.example")).toBe(true);
    const apps = await h.listLinkedApps();
    expect(apps).toHaveLength(MAX_LINKED_APPS);
    expect(apps.map((a) => a.aud)).not.toContain("https://a5.example");
  });
});

describe("route policy", () => {
  it("lists both routes as plain session rows (header CSRF)", () => {
    expect(ROUTE_POLICY["GET /api/v1/linked-apps"]).toEqual({
      session: expect.any(String),
    });
    expect(ROUTE_POLICY["DELETE /api/v1/linked-apps/:aud"]).toEqual({
      session: expect.any(String),
    });
  });
});

describe("GET /api/v1/linked-apps", () => {
  it("401s without a session and for a machine token", async () => {
    const m = await machine("linked-apps-get");
    for (const headers of [
      {},
      { authorization: `Bearer ${m.token}` },
    ] as Record<string, string>[]) {
      const r = await list(headers);
      expect(r.status).toBe(401);
      expect((await error(r)).code).toBe("unauthorized");
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("is no-store and lists the hub's apps newest first as ISO times", async () => {
    const a = app();
    const b = app();
    expect(await hub(e).linkApp(a)).toBe(true);
    expect(await hub(e).linkApp(b)).toBe(true);
    const r = await list({ cookie: await cookie() });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = (await r.json()) as object;
    expect(Object.keys(body)).toEqual(["apps"]);
    const apps = LinkedAppsResponseSchema.parse(body).apps;
    const ia = apps.findIndex((x) => x.aud === a);
    const ib = apps.findIndex((x) => x.aud === b);
    expect(ib).toBeGreaterThanOrEqual(0);
    expect(ib).toBeLessThan(ia);
    expect(Object.keys(apps[ia] as object)).toEqual(["aud", "linkedAt"]);
    expect(new Date((apps[ia] as LinkedApp).linkedAt).getTime()).toEqual(
      expect.any(Number),
    );
  });
});

describe("DELETE /api/v1/linked-apps/:aud", () => {
  it("R.linkedApp round-trips through Hono's param decoding", async () => {
    const aud = "https://oa.example.com:8443";
    expect(await hub(e).linkApp(aud)).toBe(true);
    expect(R.linkedApp(aud)).toBe(
      "/api/v1/linked-apps/https%3A%2F%2Foa.example.com%3A8443",
    );
    expect((await okDelete(R.linkedApp(aud))).status).toBe(204);
    expect((await listed()).map((x) => x.aud)).not.toContain(aud);
  });

  it("204 on the first unlink, then 404 not_found", async () => {
    const a = app();
    await hub(e).linkApp(a);
    const first = await okDelete(R.linkedApp(a));
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    expect(first.headers.get("cache-control")).toBe("no-store");
    const second = await okDelete(R.linkedApp(a));
    expect(second.status).toBe(404);
    expect((await error(second)).code).toBe("not_found");
    const unknown = await okDelete(R.linkedApp(app()));
    expect(unknown.status).toBe(404);
  });

  it("400 bad_request with field aud for a non-origin", async () => {
    for (const raw of [
      "HTTPS://X",
      "https://x:443",
      "https://x/",
      "https://u@x",
      "http://x",
      "https://x?q",
      "https://x#f",
      "https://x.",
      "not-an-origin",
    ]) {
      const r = await okDelete(
        `/api/v1/linked-apps/${encodeURIComponent(raw)}`,
      );
      expect(r.status, raw).toBe(400);
      const err = await error(r);
      expect(err.code, raw).toBe("bad_request");
      expect(err.details, raw).toMatchObject({ field: "aud" });
    }
  });

  it("401 without a session or with a machine token; 403 without CSRF", async () => {
    const a = app();
    await hub(e).linkApp(a);
    const path = R.linkedApp(a);
    const m = await machine("linked-apps-del");
    for (const headers of [
      { origin: ORIGIN, [CSRF_HEADER]: "1" },
      {
        authorization: `Bearer ${m.token}`,
        origin: ORIGIN,
        [CSRF_HEADER]: "1",
      },
    ] as Record<string, string>[]) {
      const r = await del(path, headers);
      expect(r.status).toBe(401);
      expect((await error(r)).code).toBe("unauthorized");
    }
    const c = await cookie();
    for (const headers of [
      { cookie: c, origin: ORIGIN },
      { cookie: c, origin: "https://evil.example", [CSRF_HEADER]: "1" },
      { cookie: c, origin: "null", [CSRF_HEADER]: "1" },
    ] as Record<string, string>[]) {
      const r = await del(path, headers);
      expect(r.status).toBe(403);
      expect((await error(r)).code).toBe("csrf");
    }
    // None of the refusals unlinked it.
    expect((await listed()).map((x) => x.aud)).toContain(a);
  });
});
