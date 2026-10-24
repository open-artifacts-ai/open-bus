// B11: structured, secret-free logs and the RL_AUTH rate-limit seam.

import { env } from "cloudflare:workers";
import {
  formatUserCode,
  newDeviceSecret,
  newMachineToken,
  newUserCode,
} from "@ob/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { Env } from "../src/env.js";
import { ApiError, toErrorResponse } from "../src/http/errors.js";
import {
  clientIp,
  enforceRateLimit,
  resetRateLimitWarning,
} from "../src/http/rate-limit.js";
import { logError, logEvent } from "../src/util/log.js";

afterEach(() => vi.restoreAllMocks());

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

/** Every line a console spy saw, parsed as JSON. */
const lines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => {
    expect(c).toHaveLength(1);
    return JSON.parse(String(c[0])) as Record<string, unknown>;
  });

describe("logEvent / logError", () => {
  it("one JSON line with the event name and fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("machine_revoked", { machineId: "AbCdEfGh12345678", n: 3 });
    expect(lines(spy)).toEqual([
      { evt: "machine_revoked", machineId: "AbCdEfGh12345678", n: 3 },
    ]);
  });

  it("no field ever carries a token-shaped value", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const token = newMachineToken();
    const secret = newDeviceSecret();
    const code = formatUserCode(newUserCode());
    const hash = "a".repeat(64);
    logEvent("hub_reject", {
      code: "bad_frame",
      a: token,
      b: `Bearer ${token}`,
      c: secret,
      d: code,
      e: "someone@example.com",
      f: hash,
      g: `prefix ${secret} suffix`,
    });
    const [line] = lines(spy);
    const text = JSON.stringify(line);
    for (const bad of [token, secret, code, "someone@example.com", hash])
      expect(text).not.toContain(bad);
    expect(line?.code).toBe("bad_frame");
    expect(line?.evt).toBe("hub_reject");
  });

  it("caps string fields and error messages at 200 characters", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    logEvent("x", { s: "y".repeat(500) });
    logError("boom", new Error(`z`.repeat(500)));
    logError("boom2", "not an error");
    expect(String(lines(log)[0]?.s).length).toBeLessThanOrEqual(200);
    const [e1, e2] = lines(err);
    expect(e1?.evt).toBe("boom");
    expect(String(e1?.message).length).toBeLessThanOrEqual(200);
    expect(e2).toEqual({ evt: "boom2", message: "unknown" });
  });

  it("logError redacts a token inside an error message", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const token = newMachineToken();
    logError("oidc_fail", new Error(`bad token ${token}`));
    expect(JSON.stringify(lines(err))).not.toContain(token);
  });
});

describe("RL_AUTH seam (enforceRateLimit)", () => {
  const req = (ip?: string) =>
    new Request("https://app.localhost/auth/login", {
      headers: ip ? { "CF-Connecting-IP": ip } : {},
    });

  it("an unbound limiter (tests, dev) lets the request through", async () => {
    await expect(
      enforceRateLimit(undefined, "auth", clientIp(req("1.2.3.4"))),
    ).resolves.toBeUndefined();
  });

  it("keys on CF-Connecting-IP and passes under the limit", async () => {
    const keys: string[] = [];
    const rl = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: true };
      },
    } as RateLimit;
    await enforceRateLimit(rl, "auth", clientIp(req("1.2.3.4")));
    expect(keys).toEqual(["auth:1.2.3.4"]);
  });

  it("over the limit: 429 rate_limited, logged with its kind only", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const rl = { limit: async () => ({ success: false }) } as RateLimit;
    const err = await enforceRateLimit(
      rl,
      "auth",
      clientIp(req("9.9.9.9")),
    ).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(ApiError);
    const res = toErrorResponse(err);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "rate_limited",
    );
    const out = lines(log);
    expect(out).toEqual([{ evt: "rate_limited", kind: "auth" }]);
  });

  it("unbound, throwing or rejecting: falls back (the in-DO cap), logged rate_limit_unavailable once per isolate", async () => {
    resetRateLimitWarning();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const throws = {
      limit: () => {
        throw new Error("binding down");
      },
    } as unknown as RateLimit;
    const rejects = {
      limit: async () => {
        throw new Error("binding down");
      },
    } as unknown as RateLimit;
    for (const rl of [undefined, throws, rejects, throws, undefined])
      await expect(
        enforceRateLimit(rl, "auth", clientIp(req("1.2.3.4"))),
      ).resolves.toBeUndefined();
    const out = lines(err).filter((l) => l.evt === "rate_limit_unavailable");
    expect(out).toHaveLength(1);
  });

  it("a binding stub that throws does not change the response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp(
      (a) =>
        a.get("/t", async (c) => {
          await enforceRateLimit(c.env.RL_AUTH, "auth", clientIp(c.req.raw));
          return c.json({ ok: true });
        }),
      { "GET /t": { public: "test" } },
    );
    const base = env as unknown as Env;
    const call = (e: Env) =>
      app.fetch(
        new Request("https://app.localhost/t", {
          headers: { "CF-Connecting-IP": "1.2.3.4" },
        }),
        e,
        ctx,
      );
    const unbound = await call({ ...base, RL_AUTH: undefined });
    const throwing = await call({
      ...base,
      RL_AUTH: {
        limit: async () => {
          throw new Error("down");
        },
      } as unknown as RateLimit,
    });
    expect(throwing.status).toBe(unbound.status);
    expect(await throwing.text()).toBe(await unbound.text());
    expect(unbound.status).toBe(200);
  });

  it("no CF-Connecting-IP keys on a fixed bucket", () => {
    expect(clientIp(req())).toBe("unknown");
  });
});
