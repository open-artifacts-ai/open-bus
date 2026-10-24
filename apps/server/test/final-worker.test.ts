/**
 * Final whole-track review, Worker findings (ported from
 * final/worker/final-worker.probe.test.ts): W1 /hub rate limit before the
 * hub, W4 /hub refusals as the JSON envelope, W5 HSTS and the SPA's
 * CSP (enforcing since FE9 staging verified it). W2 (OIDC state after redeem) is in signin.test.ts.
 */
import { type ClientFrame, LIMITS, newId, newMachineToken } from "@ob/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { resetRateLimitWarning } from "../src/http/rate-limit.js";
import { FRAME_BUDGET } from "../src/hub/do.js";
import { sha256Hex } from "../src/hub/hash.js";
import { hub } from "../src/hub/stub.js";
import { e, machine, ready, upgrade } from "./helpers.js";

const ORIGIN = `https://${e.APP_HOST}`;
const app = createApp();
afterEach(() => vi.restoreAllMocks());

const limiter = (success: boolean) => {
  const keys: string[] = [];
  const rl = {
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success };
    },
  } as RateLimit;
  return { rl, keys };
};

const countingHub = () => {
  let gets = 0;
  const HUB = {
    idFromName: (n: string) => e.HUB.idFromName(n),
    get: (id: DurableObjectId) => {
      gets++;
      return e.HUB.get(id);
    },
  } as unknown as Env["HUB"];
  return { HUB, gets: () => gets };
};

const hubReq = (env: Env, token = newMachineToken()) =>
  app.request(
    `${ORIGIN}/hub`,
    {
      headers: {
        Upgrade: "websocket",
        Authorization: `Bearer ${token}`,
        "cf-connecting-ip": "203.0.113.77",
      },
    },
    env,
  );

describe("W1: GET /hub is rate-limited per client before the hub", () => {
  it("over the limit: 429 rate_limited envelope, keyed hub:<clientKey>, the hub is never called", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { rl, keys } = limiter(false);
    const { HUB, gets } = countingHub();
    const env = { ...e, HUB, RL_AUTH: rl };
    for (let i = 0; i < 5; i++) {
      const r = await hubReq(env);
      expect(r.status).toBe(429);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
        "rate_limited",
      );
    }
    expect(gets()).toBe(0);
    expect(keys).toEqual(Array(5).fill("hub:203.0.113.77"));
  });

  it("under the limit: the request reaches the hub", async () => {
    const { rl, keys } = limiter(true);
    const { HUB, gets } = countingHub();
    const r = await hubReq({ ...e, HUB, RL_AUTH: rl });
    expect(r.status).toBe(401);
    expect(gets()).toBe(1);
    expect(keys).toEqual(["hub:203.0.113.77"]);
  });

  it("fails open: unbound or throwing binding still reaches the hub", async () => {
    resetRateLimitWarning();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const throws = {
      limit: async () => {
        throw new Error("binding down");
      },
    } as unknown as RateLimit;
    for (const RL_AUTH of [undefined, throws]) {
      const { HUB, gets } = countingHub();
      const r = await hubReq({ ...e, HUB, RL_AUTH });
      expect(r.status).toBe(401);
      expect(gets()).toBe(1);
    }
  });

  it("a real machine still connects (101) under the limit", async () => {
    const m = await machine("RL ok");
    const { rl } = limiter(true);
    const r = await hubReq({ ...e, RL_AUTH: rl }, m.token);
    expect(r.status).toBe(101);
    const ws = r.webSocket as WebSocket;
    ws.accept();
    ws.close(1000, "bye");
  });
});

const junkAck = (): ClientFrame => ({
  v: 1,
  id: newId(),
  type: "ack",
  msg_id: newId(),
});

describe("W4: /hub refusals from the hub get the JSON envelope", () => {
  it("cooldown 429: rate_limited envelope with retryAfterSec, Retry-After kept, no-store", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const m = await machine("Flood");
    const d = await ready(m.token);
    let closed = false;
    void d.closed.then(() => {
      closed = true;
    });
    // Real clock: outrun the 50/s refill until the burst is gone.
    for (let k = 0; k < 4 * FRAME_BUDGET.burst && !closed; k++) {
      d.send(junkAck());
      if (k % 500 === 0) await new Promise((r) => setTimeout(r, 1));
    }
    expect((await d.closed).code).toBe(LIMITS.rateLimitCloseCode);
    const r = await upgrade(m.token);
    expect(r.status).toBe(429);
    expect((r.headers.get("content-type") ?? "").split(";")[0]).toBe(
      "application/json",
    );
    expect(r.headers.get("cache-control")).toBe("no-store");
    const retry = Number(r.headers.get("retry-after"));
    expect(Number.isInteger(retry) && retry >= 0).toBe(true);
    expect(await r.json()).toEqual({
      error: {
        code: "rate_limited",
        message: expect.any(String),
        details: { retryAfterSec: retry },
      },
    });
  }, 60_000);

  it("revoked between the Worker check and the hub: 401 unauthorized envelope, no-store", async () => {
    const m = await machine("Race");
    // The Worker sees the machine as valid; the hub has it revoked.
    const real = hub(e);
    const verified = await real.verifyToken(await sha256Hex(m.token));
    expect(verified).toBeTruthy();
    await real.revokeMachine(m.id);
    const HUB = {
      idFromName: (n: string) => e.HUB.idFromName(n),
      get: (id: DurableObjectId) => ({
        verifyToken: async () => verified,
        fetch: (req: Request) => e.HUB.get(id).fetch(req),
      }),
    } as unknown as Env["HUB"];
    const r = await hubReq({ ...e, HUB }, m.token);
    expect(r.status).toBe(401);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe(
      "unauthorized",
    );
  });
});

const ASSETS = {
  fetch: async () =>
    new Response("<!doctype html><div id=root></div>", {
      headers: { "content-type": "text/html" },
    }),
} as unknown as Fetcher;

const SPA_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const HSTS = "max-age=31536000; includeSubDomains";

describe("W5: HSTS outside dev, enforcing CSP on the SPA", () => {
  it("SPA asset in production: HSTS and an enforcing Content-Security-Policy", async () => {
    const r = await app.request(
      `${ORIGIN}/machines`,
      {},
      { ...e, ASSETS, ENVIRONMENT: "production" },
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("strict-transport-security")).toBe(HSTS);
    expect(r.headers.get("content-security-policy")).toBe(SPA_CSP);
    expect(r.headers.has("content-security-policy-report-only")).toBe(false);
  });

  it("every Worker response in production carries HSTS (JSON, error)", async () => {
    const env = { ...e, ENVIRONMENT: "production" as const };
    for (const path of ["/healthz", "/api/v1/nope"]) {
      const r = await app.request(`${ORIGIN}${path}`, {}, env);
      expect(r.headers.get("strict-transport-security"), path).toBe(HSTS);
      expect(r.headers.has("content-security-policy"), path).toBe(false);
    }
  });

  it("dev: no HSTS; the SPA still gets the enforcing CSP", async () => {
    const r = await app.request(`${ORIGIN}/machines`, {}, { ...e, ASSETS });
    expect(r.headers.has("strict-transport-security")).toBe(false);
    expect(r.headers.get("content-security-policy")).toBe(SPA_CSP);
  });
});
