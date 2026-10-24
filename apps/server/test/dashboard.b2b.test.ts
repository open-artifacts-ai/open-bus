import { SELF } from "cloudflare:test";
import {
  AgentsResponseSchema,
  ApiErrorSchema,
  BusEventSchema,
  MeSchema,
  R,
} from "@ob/shared";
import { describe, expect, it } from "vitest";
import { sessionCookieName, signSession } from "../src/auth/session.js";
import { hub } from "../src/hub/stub.js";
import { e } from "./helpers.js";

// End to end through the deployed entry point: the real policy gate reads the
// session cookie (B2b) and sets `session`; the dashboard routes read it.

const ORIGIN = `https://${e.APP_HOST}`;
const cookie = async () => `${sessionCookieName(e)}=${await signSession(e)}`;
const get = (path: string, headers: Record<string, string> = {}) =>
  SELF.fetch(`${ORIGIN}${path}`, { headers });

async function code(r: Response) {
  return ApiErrorSchema.parse(await r.json()).error.code;
}

describe("dashboard routes behind the real session gate", () => {
  it.each([R.me, R.agents, R.events])("401s %s without a cookie", async (p) => {
    const r = await get(p, { Upgrade: "websocket", Origin: ORIGIN });
    expect(r.status).toBe(401);
    expect(await code(r)).toBe("unauthorized");
  });

  it("serves /me and /agents with a valid cookie", async () => {
    const c = await cookie();
    const me = await get(R.me, { cookie: c });
    expect(me.status).toBe(200);
    expect(MeSchema.parse(await me.json()).user).toEqual({
      id: "owner",
      email: e.OWNER_EMAIL.trim(),
      name: null,
    });
    const agents = await get(R.agents, { cookie: c });
    expect(agents.status).toBe(200);
    AgentsResponseSchema.parse(await agents.json());
  });

  it("upgrades /events to the hub's socket, hello first", async () => {
    const r = await get(R.events, {
      cookie: await cookie(),
      Upgrade: "websocket",
      Origin: ORIGIN,
    });
    expect(r.status).toBe(101);
    const ws = r.webSocket;
    if (!ws) throw new Error("no webSocket");
    ws.accept();
    const first = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no frame")), 3000);
      ws.addEventListener("message", (ev) => {
        clearTimeout(t);
        resolve(String(ev.data));
      });
    });
    expect(BusEventSchema.parse(JSON.parse(first))).toEqual({ type: "hello" });
    ws.close(1000, "done");
  });

  it("403s /events with a valid cookie and a foreign Origin", async () => {
    const r = await get(R.events, {
      cookie: await cookie(),
      Upgrade: "websocket",
      Origin: "https://evil.test",
    });
    expect(r.status).toBe(403);
    expect(await code(r)).toBe("csrf");
  });

  it("401s a session minted before a generation bump", async () => {
    const c = await cookie();
    expect((await get(R.me, { cookie: c })).status).toBe(200);
    await hub(e).bumpSessionGeneration();
    for (const p of [R.me, R.agents, R.events]) {
      const r = await get(p, {
        cookie: c,
        Upgrade: "websocket",
        Origin: ORIGIN,
      });
      expect(r.status, p).toBe(401);
      expect(await code(r)).toBe("unauthorized");
    }
    // A fresh session works again.
    expect((await get(R.me, { cookie: await cookie() })).status).toBe(200);
  });
});
