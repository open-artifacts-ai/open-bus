// B4: the device flow (POST /device/code, POST /device/token), the hub's
// device RPCs and the server-rendered approval page with its form CSRF.
import { runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  CSRF_HEADER,
  DeviceCodeResponseSchema,
  DeviceTokenResponseSchema,
  LIMITS,
  R,
  STATUS_FOR,
} from "@ob/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { approveCsrf } from "../src/auth/approve-csrf.js";
import { ROUTE_POLICY } from "../src/auth/route-policy.js";
import {
  OWNER_UID,
  sessionCookieName,
  sessionGeneration,
  signSession,
} from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { clientKey, resetRateLimitWarning } from "../src/http/rate-limit.js";
import {
  APPROVE_FAIL_CAP,
  APPROVE_FAIL_WINDOW_MS,
  DEVICE_CODES_PER_IP,
  Hub,
  MAX_DEVICE_CODES,
} from "../src/hub/do.js";
import { hub } from "../src/hub/stub.js";
import { daemon } from "./helpers.js";

const e = env as unknown as Env;
const ORIGIN = `https://${e.APP_HOST}`;
const FORM = "application/x-www-form-urlencoded";
const POLL_MS = LIMITS.devicePollIntervalSec * 1000;
type Code = { device_code: string; user_code: string };
type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: { retryAfterSec?: number };
  };
};

// ------------------------------------------------------------------ clock

/** The hub's frozen clock. Each test starts an hour past the last one. */
let clock = Date.now();
const setClock = (ms: number) =>
  runInDurableObject(hub(e) as unknown as DurableObjectStub<Hub>, (h: Hub) =>
    Hub.setTestClock(h, ms),
  );
const advance = (ms: number) => {
  clock += ms;
  return setClock(clock);
};
const inHub = <R>(fn: (s: DurableObjectState) => R) =>
  runInDurableObject(
    hub(e) as unknown as DurableObjectStub<Hub>,
    (_: Hub, s: DurableObjectState) => fn(s),
  );

beforeEach(async () => {
  clock += 3_600_000;
  await setClock(clock);
});
afterEach(() => vi.restoreAllMocks());

// --------------------------------------------------------------- requests

const json = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch(`${ORIGIN}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function newCode(label?: string): Promise<Code> {
  const r = await json(
    "/device/code",
    label === undefined ? {} : { machine_label: label },
  );
  expect(r.status).toBe(201);
  return (await r.json()) as Code;
}

/** Polls once, then moves the hub clock one interval on so the next poll is not slow_down. */
async function poll(code: Code): Promise<Response> {
  const r = await json("/device/token", { device_code: code.device_code });
  await advance(POLL_MS);
  return r;
}
const pollJson = async (code: Code) =>
  (await (await poll(code)).json()) as { status: string; token?: string };

const session = async () => ({
  uid: OWNER_UID,
  gen: await sessionGeneration(e),
});
const cookie = async () => `${sessionCookieName(e)}=${await signSession(e)}`;
const page = async (userCode: string, c?: string) =>
  SELF.fetch(`${ORIGIN}/approve/${userCode}`, {
    headers: c === undefined ? {} : { cookie: c },
    redirect: "manual",
  });

/** The approval form POST exactly as a browser sends it: no X-OB-Request. */
async function decide(
  userCode: string,
  decision: "approve" | "deny",
  opts: {
    csrf?: string | null;
    cookie?: string | null;
    headers?: Record<string, string>;
    extra?: string;
  } = {},
): Promise<Response> {
  const csrf =
    opts.csrf === undefined
      ? await approveCsrf(e, userCode, await session())
      : opts.csrf;
  const c = opts.cookie === undefined ? await cookie() : opts.cookie;
  const parts = [`decision=${decision}`];
  if (csrf !== null) parts.push(`csrf=${encodeURIComponent(csrf)}`);
  if (opts.extra) parts.push(opts.extra);
  return SELF.fetch(`${ORIGIN}/approve/${userCode}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": FORM,
      origin: ORIGIN,
      ...(c === null ? {} : { cookie: c }),
      ...opts.headers,
    },
    body: parts.join("&"),
  });
}

const errorCode = async (r: Response) =>
  ((await r.json()) as ErrorBody).error.code;

// ------------------------------------------------------------------ tests

describe("POST /device/code", () => {
  it("returns a code that parses with the shared schema", async () => {
    const r = await json("/device/code", { machine_label: "MacBook" });
    expect(r.status).toBe(201);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = DeviceCodeResponseSchema.parse(await r.json());
    expect(body.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(body.verification_uri).toBe(`${ORIGIN}/approve/${body.user_code}`);
    expect(body.expires_in).toBe(600);
    expect(body.interval).toBe(5);
  });

  it("stores only the SHA-256 of the device secret", async () => {
    const code = await newCode("hash-only");
    const rows = await inHub((s) =>
      s.storage.sql
        .exec<{ code_hash: string; user_code: string }>(
          "select code_hash, user_code from device_codes where label = 'hash-only'",
        )
        .toArray(),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as { code_hash: string; user_code: string };
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(code.device_code);
    expect(row.user_code).toBe(code.user_code);
  });

  it("sanitizes the label and defaults it", async () => {
    await newCode();
    const labels = await inHub((s) =>
      s.storage.sql
        .exec<{ label: string }>(
          "select label from device_codes order by created_at desc, rowid desc limit 1",
        )
        .toArray(),
    );
    expect(labels[0]?.label).toBe("machine");
  });

  it("refuses bodies that are not the strict schema", async () => {
    for (const body of [
      "not json",
      { machine_label: "x", extra: 1 },
      { machine_label: "bad‮label" },
      { machine_label: "" },
      [],
    ]) {
      const r = await json("/device/code", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(r)).toBe("bad_request");
    }
    const big = await json("/device/code", { machine_label: "x".repeat(5000) });
    expect([400, 413]).toContain(big.status);
  });

  it("is a {public} row and 404s other methods", async () => {
    expect(ROUTE_POLICY["POST /device/code"]).toHaveProperty("public");
    expect(ROUTE_POLICY["POST /device/token"]).toHaveProperty("public");
    expect((await SELF.fetch(`${ORIGIN}/device/code`)).status).toBe(404);
  });
});

describe("the device flow", () => {
  it("code -> pending -> approve -> token -> the machine connects to /hub", async () => {
    const code = await newCode("MacBook");
    expect(await pollJson(code)).toEqual({ status: "pending" });

    const c = await cookie();
    const get = await page(code.user_code, c);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toMatch(/^text\/html/);
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(get.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(get.headers.get("content-security-policy")).toContain(
      "form-action 'self'",
    );
    const html = await get.text();
    expect(html).toContain("MacBook");
    expect(html).toContain(code.user_code);
    expect(html).toContain(`action="/approve/${code.user_code}"`);
    // The form token the page carries is the one that works.
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    expect(csrf).toBeTruthy();

    const approve = await decide(code.user_code, "approve", {
      csrf: csrf as string,
      cookie: c,
    });
    expect(approve.status).toBe(303);
    expect(approve.headers.get("location")).toBe(R.dashboard);
    expect(approve.headers.get("cache-control")).toBe("no-store");

    const granted = DeviceTokenResponseSchema.parse(await pollJson(code));
    if (granted.status !== "approved") throw new Error(granted.status);
    expect(granted.token).toMatch(/^ob_machine_/);
    const machines = await hub(e).listMachines();
    expect(machines.find((m) => m.id === granted.machine_id)?.label).toBe(
      "MacBook",
    );

    const d = await daemon(granted.token);
    d.close();

    // Never redeemed twice.
    expect(await pollJson(code)).toEqual({ status: "expired" });
    expect(await pollJson(code)).toEqual({ status: "expired" });
  });

  it("answers slow_down (429 rate_limited) when polled faster than the interval", async () => {
    const code = await newCode();
    const first = await json("/device/token", {
      device_code: code.device_code,
    });
    expect(await first.json()).toEqual({ status: "pending" });
    const fast = await json("/device/token", { device_code: code.device_code });
    expect(fast.status).toBe(429);
    const body = (await fast.json()) as ErrorBody;
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.details?.retryAfterSec).toBe(
      LIMITS.devicePollIntervalSec,
    );
    await advance(POLL_MS);
    expect(await pollJson(code)).toEqual({ status: "pending" });
  });

  it("expires after the TTL, and the page then shows the error state", async () => {
    const code = await newCode();
    await advance(LIMITS.deviceCodeTtlSec * 1000 + 1);
    expect(await pollJson(code)).toEqual({ status: "expired" });
    const r = await page(code.user_code, await cookie());
    expect(r.status).toBe(404);
    expect(await r.text()).not.toContain('name="csrf"');
    // A token minted before expiry cannot decide it either.
    expect((await decide(code.user_code, "approve")).status).toBe(404);
  });

  it("an approval past the TTL is never redeemed", async () => {
    const code = await newCode();
    expect((await decide(code.user_code, "approve")).status).toBe(303);
    await advance(LIMITS.deviceCodeTtlSec * 1000 + 1);
    expect(await pollJson(code)).toEqual({ status: "expired" });
  });

  it("reports a denial, then the code is used up", async () => {
    const code = await newCode("deny-me");
    const r = await decide(code.user_code, "deny");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const html = await r.text();
    expect(html).toContain("not approved");
    expect(html).toContain("deny-me");
    expect(await pollJson(code)).toEqual({ status: "denied" });
    expect(await pollJson(code)).toEqual({ status: "denied" });
    // Neither decision applies twice.
    expect((await decide(code.user_code, "approve")).status).toBe(404);
    expect(await pollJson(code)).toEqual({ status: "denied" });
  });

  it("an unknown or malformed device_code reads as expired or 400", async () => {
    const other = await newCode();
    const unknown = `${other.device_code.slice(0, -1)}${other.device_code.endsWith("z") ? "y" : "z"}`;
    expect(
      await (await json("/device/token", { device_code: unknown })).json(),
    ).toEqual({
      status: "expired",
    });
    for (const body of [
      {},
      { device_code: "short" },
      { device_code: 1 },
      "x",
    ]) {
      const r = await json("/device/token", body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("mints exactly one machine under concurrent polls", async () => {
    const code = await newCode("race");
    expect((await decide(code.user_code, "approve")).status).toBe(303);
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        json("/device/token", { device_code: code.device_code }).then(
          async (r) => ({
            status: r.status,
            body: (await r.json()) as { status?: string },
          }),
        ),
      ),
    );
    expect(rs.filter((r) => r.body.status === "approved")).toHaveLength(1);
    const machines = await hub(e).listMachines();
    expect(
      machines.filter((m) => m.label === "race" && m.revokedAt === null),
    ).toHaveLength(1);
  });

  it("accepts the user code in any case or spacing on the page", async () => {
    const code = await newCode("cases");
    const lower = code.user_code.toLowerCase();
    const r = await page(lower, await cookie());
    expect(r.status).toBe(200);
    expect(await r.text()).toContain(code.user_code);
    expect((await decide(lower, "approve")).status).toBe(303);
  });
});

describe("the approval page", () => {
  it("sends a signed-out browser to login with next", async () => {
    const code = await newCode();
    const r = await page(code.user_code);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(
      `/auth/login?next=${encodeURIComponent(`/approve/${code.user_code}`)}`,
    );
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("escapes every value: a label full of <script> and quotes", async () => {
    const label = `<script>alert("x")</script>'&"`;
    const code = await newCode(label);
    const html = await (await page(code.user_code, await cookie())).text();
    expect(html).not.toContain("<script");
    expect(html).not.toContain(`alert("x")`);
    expect(html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;&amp;&quot;",
    );
    // "Not you?" is a same-origin form POST to logout, built from APP_HOST.
    expect(html).toContain(
      `<form id="switch" method="post" action="${ORIGIN}/auth/logout?then=login&amp;next=${encodeURIComponent(`/approve/${code.user_code}`)}"></form>`,
    );
    expect(html).toContain('form="switch"');
    const denied = await (await decide(code.user_code, "deny")).text();
    expect(denied).not.toContain("<script");
    expect(denied).toContain("&lt;script&gt;");
  });

  it("builds switch_url and the host from APP_HOST, never from the request", async () => {
    const code = await newCode();
    const html = await (
      await SELF.fetch(`${ORIGIN}/approve/${code.user_code}`, {
        headers: {
          cookie: await cookie(),
          host: "evil.example",
          "x-forwarded-host": "evil.example",
        },
      })
    ).text();
    expect(html).not.toContain("evil.example");
    expect(html).toContain(e.APP_HOST);
  });

  it("renders one identical error page for unknown, expired, used and denied codes", async () => {
    const c = await cookie();
    const unknown = "ZZZZ-ZZZZ";
    const expired = await newCode("expired");
    const used = await newCode("used");
    const denied = await newCode("denied");
    const approved = await newCode("approved");
    expect((await decide(used.user_code, "approve")).status).toBe(303);
    expect((await pollJson(used)).status).toBe("approved");
    expect((await decide(denied.user_code, "deny")).status).toBe(200);
    expect((await decide(approved.user_code, "approve")).status).toBe(303);
    await advance(LIMITS.deviceCodeTtlSec * 1000 - POLL_MS * 3);
    const before = await page(expired.user_code, c);
    expect(before.status).toBe(200);
    await advance(POLL_MS * 4);
    const pages = await Promise.all(
      [unknown, expired.user_code, used.user_code, denied.user_code].map(
        async (u) => {
          const r = await page(u, c);
          return {
            status: r.status,
            body: await r.text(),
            cc: r.headers.get("cache-control"),
          };
        },
      ),
    );
    for (const p of pages) {
      expect(p).toEqual(pages[0]);
      expect(p.cc).toBe("no-store");
    }
    expect(pages[0]?.status).toBe(404);
    expect(pages[0]?.body).toContain("This code expired");
    // An approved but unclaimed code (re-expired here) shows the same page.
    expect((await page(approved.user_code, c)).status).toBe(404);
  });

  it("a malformed code renders the same error page without touching the hub", async () => {
    const c = await cookie();
    const a = await page("ZZZZ-ZZZZ", c);
    const b = await page("not-a-code", c);
    expect(b.status).toBe(a.status);
    expect(await b.text()).toBe(await a.text());
  });
});

describe("the approval form's CSRF (form-POST policy mode)", () => {
  it("the header-less form POST passes with a valid token and same origin", async () => {
    const code = await newCode();
    const r = await decide(code.user_code, "approve");
    expect(r.status).toBe(303);
  });

  it("passes with Sec-Fetch-Site: same-origin when Origin is absent", async () => {
    const code = await newCode();
    const r = await SELF.fetch(`${ORIGIN}/approve/${code.user_code}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": FORM,
        "sec-fetch-site": "same-origin",
        cookie: await cookie(),
      },
      body: `decision=approve&csrf=${encodeURIComponent(await approveCsrf(e, code.user_code, await session()))}`,
    });
    expect(r.status).toBe(303);
    expect(await pollJson(code)).toMatchObject({ status: "approved" });
  });

  const refusals: [string, (u: string) => Promise<Response>][] = [
    ["a missing token", (u) => decide(u, "approve", { csrf: null })],
    ["a garbage token", (u) => decide(u, "approve", { csrf: "1.2" })],
    [
      "a token for another code",
      async (u) =>
        decide(u, "approve", {
          csrf: await approveCsrf(
            e,
            u === "ABCD-EFGH" ? "ABCD-EFGJ" : "ABCD-EFGH",
            await session(),
          ),
        }),
    ],
    [
      "a token for another session uid",
      async (u) =>
        decide(u, "approve", {
          csrf: await approveCsrf(e, u, {
            uid: "someone",
            gen: (await session()).gen,
          }),
        }),
    ],
    [
      "a token from an old session generation",
      async (u) =>
        decide(u, "approve", {
          csrf: await approveCsrf(e, u, {
            uid: OWNER_UID,
            gen: (await session()).gen + 1,
          }),
        }),
    ],
    [
      "an expired token",
      async (u) =>
        decide(u, "approve", {
          csrf: await approveCsrf(e, u, await session(), Date.now() - 600_001),
        }),
    ],
    [
      "a cross-origin request",
      (u) =>
        decide(u, "approve", { headers: { origin: "https://evil.example" } }),
    ],
    [
      "a same-site but cross-origin request",
      (u) =>
        decide(u, "approve", {
          headers: { origin: "https://evil.app.localhost" },
        }),
    ],
    [
      "X-OB-Request without a token",
      (u) =>
        decide(u, "approve", { csrf: null, headers: { [CSRF_HEADER]: "1" } }),
    ],
    [
      "a token in the query string instead of the body",
      async (u) =>
        SELF.fetch(
          `${ORIGIN}/approve/${u}?csrf=${encodeURIComponent(await approveCsrf(e, u, await session()))}`,
          {
            method: "POST",
            redirect: "manual",
            headers: {
              "content-type": FORM,
              origin: ORIGIN,
              cookie: await cookie(),
            },
            body: "decision=approve",
          },
        ),
    ],
    [
      "a JSON body",
      async (u) =>
        SELF.fetch(`${ORIGIN}/approve/${u}`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "content-type": "application/json",
            origin: ORIGIN,
            cookie: await cookie(),
            [CSRF_HEADER]: "1",
          },
          body: JSON.stringify({
            decision: "approve",
            csrf: await approveCsrf(e, u, await session()),
          }),
        }),
    ],
  ];

  for (const [name, send] of refusals)
    it(`refuses ${name} with 403 csrf and leaves the code pending`, async () => {
      const code = await newCode();
      const r = await send(code.user_code);
      expect(r.status).toBe(STATUS_FOR.csrf);
      expect(await errorCode(r)).toBe("csrf");
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await pollJson(code)).toEqual({ status: "pending" });
    });

  it("refuses with no Origin and no Sec-Fetch-Site, or a cross-site one", async () => {
    for (const site of [null, "cross-site", "same-site", "none"]) {
      const code = await newCode();
      const r = await SELF.fetch(`${ORIGIN}/approve/${code.user_code}`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": FORM,
          cookie: await cookie(),
          ...(site === null ? {} : { "sec-fetch-site": site }),
        },
        body: `decision=approve&csrf=${encodeURIComponent(await approveCsrf(e, code.user_code, await session()))}`,
      });
      expect(r.status, String(site)).toBe(403);
      expect(await pollJson(code)).toEqual({ status: "pending" });
    }
  });

  it("refuses a signed-out POST with 401 and never redirects it", async () => {
    const code = await newCode();
    const r = await decide(code.user_code, "approve", { cookie: null });
    expect(r.status).toBe(401);
    expect(await pollJson(code)).toEqual({ status: "pending" });
  });

  it("refuses a bad decision with 400", async () => {
    const code = await newCode();
    const r = await SELF.fetch(`${ORIGIN}/approve/${code.user_code}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": FORM, origin: ORIGIN, cookie: await cookie() },
      body: `decision=maybe&csrf=${encodeURIComponent(await approveCsrf(e, code.user_code, await session()))}`,
    });
    expect(r.status).toBe(400);
    expect(await pollJson(code)).toEqual({ status: "pending" });
  });

  it("other {session} mutations keep the header rule", async () => {
    const forms = Object.entries(ROUTE_POLICY).filter(
      ([, p]) => "session" in p && "form" in p && p.form !== undefined,
    );
    expect(forms.map(([k]) => k)).toEqual(["POST /approve/:user_code"]);
  });
});

describe("guessing user codes", () => {
  it(`caps failed approvals per session at ${APPROVE_FAIL_CAP} per window`, async () => {
    const c = await cookie();
    const good = await newCode("guess-target");
    for (let i = 0; i < APPROVE_FAIL_CAP; i++)
      expect(
        (
          await decide(
            `ZZZZ-ZZ${"23456789ABCDEFGH"[i]}${"23456789ABCDEFGH"[i]}`,
            "approve",
          )
        ).status,
      ).toBe(404);
    const limited = await page(good.user_code, c);
    expect(limited.status).toBe(429);
    expect(await limited.text()).not.toContain("guess-target");
    expect((await decide(good.user_code, "approve")).status).toBe(429);
    expect(await pollJson(good)).toEqual({ status: "pending" });
    await advance(APPROVE_FAIL_WINDOW_MS);
    // A new window; the code is now expired too, so mint a fresh one.
    const fresh = await newCode("after-window");
    expect((await page(fresh.user_code, c)).status).toBe(200);
  });
});

describe("rate limits (RL_DEVICE, B11 pattern)", () => {
  const app = createApp();
  const limiter = (success: boolean | "throw"): RateLimit => ({
    limit: async () => {
      if (success === "throw") throw new Error("binding down");
      return { success };
    },
  });
  const call = (p: string, body: unknown, envOver: Partial<Env>) =>
    app.request(
      `${ORIGIN}${p}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.9",
        },
        body: JSON.stringify(body),
      },
      { ...e, ...envOver },
    );

  it("fails open when the binding is unbound or throws, logged once", async () => {
    resetRateLimitWarning();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      (await call("/device/code", {}, { RL_DEVICE: undefined })).status,
    ).toBe(201);
    expect(
      (await call("/device/code", {}, { RL_DEVICE: limiter("throw") })).status,
    ).toBe(201);
    const warnings = err.mock.calls.filter((a) =>
      String(a[0]).includes("rate_limit_unavailable"),
    );
    expect(warnings).toHaveLength(1);
  });

  it("refuses 429 rate_limited when the binding says over the limit", async () => {
    const seen: string[] = [];
    const rl: RateLimit = {
      limit: async ({ key }) => {
        seen.push(key);
        return { success: false };
      },
    };
    const code = await call("/device/code", {}, { RL_DEVICE: rl });
    expect(code.status).toBe(429);
    expect(await errorCode(code)).toBe("rate_limited");
    const tok = await call(
      "/device/token",
      { device_code: "1".repeat(43) },
      { RL_DEVICE: rl },
    );
    expect(tok.status).toBe(429);
    const appr = await app.request(
      `${ORIGIN}/approve/ABCD-EFGH`,
      {
        headers: { cookie: await cookie(), "cf-connecting-ip": "203.0.113.9" },
      },
      { ...e, RL_DEVICE: rl },
    );
    expect(appr.status).toBe(429);
    expect(seen.every((k) => k.endsWith(":203.0.113.9"))).toBe(true);
    expect(new Set(seen.map((k) => k.split(":")[0])).size).toBe(3);
  });

  it(`falls back to the in-DO cap: ${MAX_DEVICE_CODES} outstanding codes, then rate_limited, never evicting`, async () => {
    const before = await inHub(
      (s) =>
        s.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from device_codes where expires_at > ?",
            clock,
          )
          .one().n,
    );
    await inHub((s) => {
      for (let i = before; i < MAX_DEVICE_CODES; i++)
        s.storage.sql.exec(
          "insert into device_codes (user_code, org_id, code_hash, label, created_at, expires_at) values (?, 'owner', ?, 'fill', ?, ?)",
          `FILL-${String(i).padStart(4, "0")}`,
          `fill-${i}`,
          clock,
          clock + 600_000,
        );
    });
    const r = await json("/device/code", {});
    expect(r.status).toBe(429);
    expect(await errorCode(r)).toBe("rate_limited");
    const after = await inHub(
      (s) =>
        s.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from device_codes where expires_at > ?",
            clock,
          )
          .one().n,
    );
    expect(after).toBe(MAX_DEVICE_CODES);
    // Once they expire, new codes are minted again.
    await advance(LIMITS.deviceCodeTtlSec * 1000 + 1);
    expect((await json("/device/code", {})).status).toBe(201);
  });
});

describe("the machine limit", () => {
  it("surfaces as 409 conflict and leaves the approval redeemable after a revoke", async () => {
    const code = await newCode("over-limit");
    expect((await decide(code.user_code, "approve")).status).toBe(303);
    const ids: string[] = [];
    for (let i = 0; i < LIMITS.maxMachinesListed + 1; i++) {
      const m = await hub(e).createMachine(`fill-${i}`);
      if (!m.ok) break;
      ids.push(m.id);
    }
    const r = await poll(code);
    expect(r.status).toBe(409);
    expect(await errorCode(r)).toBe("conflict");
    await hub(e).revokeMachine(ids[0] as string);
    const ok = await pollJson(code);
    expect(ok).toMatchObject({ status: "approved" });
    expect(await pollJson(code)).toEqual({ status: "expired" });
    for (const id of ids) await hub(e).revokeMachine(id);
  }, 60_000);
});

describe("hub RPC surface", () => {
  it("adds exactly the five device methods", () => {
    const own = Object.getOwnPropertyNames(Hub.prototype);
    for (const n of [
      "createDeviceCode",
      "pollDevice",
      "approveDevice",
      "denyDevice",
      "deviceForApproval",
    ])
      expect(own).toContain(n);
    expect(own.filter((n) => /device/i.test(n)).sort()).toEqual([
      "approveDevice",
      "createDeviceCode",
      "denyDevice",
      "deviceForApproval",
      "pollDevice",
    ]);
  });

  it("the policy rows", () => {
    expect(ROUTE_POLICY["GET /approve/:user_code"]).toHaveProperty("session");
    expect(ROUTE_POLICY["POST /approve/:user_code"]).toHaveProperty("session");
  });
});

describe('FE9: "Not you?" works in browsers (referrer policy same-origin)', () => {
  it("sends Referrer-Policy and the meta tag as same-origin on every page state", async () => {
    const code = await newCode();
    const c = await cookie();
    for (const r of [
      await page(code.user_code, c),
      await page("ZZZZ-ZZZZ", c),
    ]) {
      expect(r.headers.get("referrer-policy")).toBe("same-origin");
      const html = await r.text();
      expect(html).toContain('<meta name="referrer" content="same-origin">');
      expect(html).not.toContain("no-referrer");
    }
  });

  it("the logout POST a same-origin browser form sends (real Origin) succeeds", async () => {
    const code = await newCode();
    const c = await cookie();
    const html = await (await page(code.user_code, c)).text();
    const action = /<form id="switch" method="post" action="([^"]+)"/
      .exec(html)?.[1]
      ?.replaceAll("&amp;", "&");
    if (!action) throw new Error("no switch form");
    const r = await SELF.fetch(action, {
      method: "POST",
      redirect: "manual",
      headers: { origin: ORIGIN, cookie: c, "content-type": FORM },
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(
      `/auth/login?next=${encodeURIComponent(`/approve/${code.user_code}`)}`,
    );
  });

  it("a null Origin (what no-referrer produced) is still refused, in both logout modes", async () => {
    const code = await newCode();
    const c = await cookie();
    for (const q of [
      "",
      `?then=login&next=${encodeURIComponent(`/approve/${code.user_code}`)}`,
    ]) {
      const r = await SELF.fetch(`${ORIGIN}/auth/logout${q}`, {
        method: "POST",
        redirect: "manual",
        headers: { origin: "null", cookie: c, "content-type": FORM },
      });
      expect(r.status, q || "plain").toBe(403);
      expect(r.headers.getSetCookie(), q || "plain").toEqual([]);
    }
    // Not signed out: the session still reads.
    expect((await page(code.user_code, c)).status).toBe(200);
  });
});

describe('"Not you?" signs out, then restarts sign-in', () => {
  const logout = (query: string, headers: Record<string, string>) =>
    SELF.fetch(`${ORIGIN}/auth/logout${query}`, {
      method: "POST",
      redirect: "manual",
      headers,
    });

  it("POST /auth/logout?then=login clears the session and 303s to sign-in with next", async () => {
    const code = await newCode();
    const c = await cookie();
    const next = `/approve/${code.user_code}`;
    const r = await logout(`?then=login&next=${encodeURIComponent(next)}`, {
      origin: ORIGIN,
      cookie: c,
      "content-type": FORM,
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(
      `/auth/login?next=${encodeURIComponent(next)}`,
    );
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(
      r.headers
        .getSetCookie()
        .some((x) => x.startsWith(`${sessionCookieName(e)}=;`)),
    ).toBe(true);
    // Signed out everywhere: the old cookie no longer reads.
    expect((await page(code.user_code, c)).status).toBe(302);
  });

  it("keeps logout's origin check and sanitizes next", async () => {
    const c = await cookie();
    const cross = await logout("?then=login&next=%2Fmachines", {
      origin: "https://evil.example",
      cookie: c,
    });
    expect(cross.status).toBe(403);
    expect((await page("ZZZZ-ZZZZ", c)).status).toBe(404);
    const evil = await logout(
      `?then=login&next=${encodeURIComponent("https://evil.example/x")}`,
      { origin: ORIGIN, cookie: c },
    );
    expect(evil.status).toBe(303);
    expect(evil.headers.get("location")).toBe("/auth/login?next=%2F");
  });

  it("without then=login, logout still answers 204", async () => {
    const r = await logout("?next=%2Fmachines", {
      origin: ORIGIN,
      cookie: await cookie(),
    });
    expect(r.status).toBe(204);
  });
});

// ------------------------------------------------- B4 fix round 1 (adv-B4)

describe("M1: per-IP share of the device-code cap", () => {
  const fromIp = (ip: string) =>
    json("/device/code", {}, { "cf-connecting-ip": ip });

  it(`caps one IP at ${DEVICE_CODES_PER_IP} live codes while other IPs still get codes`, async () => {
    for (let i = 0; i < DEVICE_CODES_PER_IP; i++)
      expect((await fromIp("198.51.100.7")).status).toBe(201);
    const over = await fromIp("198.51.100.7");
    expect(over.status).toBe(429);
    expect(await errorCode(over)).toBe("rate_limited");
    expect((await fromIp("198.51.100.8")).status).toBe(201);
    expect((await fromIp("2001:db8::1")).status).toBe(201);
    // Expired codes free the share.
    await advance(LIMITS.deviceCodeTtlSec * 1000 + 1);
    expect((await fromIp("198.51.100.7")).status).toBe(201);
  });

  it("a redeemed code frees its slot (live = unexpired and unconsumed)", async () => {
    const codes: Code[] = [];
    for (let i = 0; i < DEVICE_CODES_PER_IP; i++) {
      const r = await fromIp("198.51.100.9");
      expect(r.status).toBe(201);
      codes.push((await r.json()) as Code);
    }
    expect((await fromIp("198.51.100.9")).status).toBe(429);
    const c0 = codes[0] as Code;
    expect((await decide(c0.user_code, "approve")).status).toBe(303);
    const got = await pollJson(c0);
    expect(got.status).toBe("approved");
    expect((await fromIp("198.51.100.9")).status).toBe(201);
    for (const m of await hub(e).listMachines())
      if (m.label === "machine" && m.revokedAt === null)
        await hub(e).revokeMachine(m.id);
  });

  it("stores an HMAC tag of the IP, never the raw IP", async () => {
    const ip = "203.0.113.77";
    expect((await fromIp(ip)).status).toBe(201);
    const rows = await inHub((s) =>
      s.storage.sql
        .exec<Record<string, SqlStorageValue>>(
          "select * from device_codes order by rowid desc limit 1",
        )
        .toArray(),
    );
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(ip);
    expect(dump).not.toContain("203.0.113");
    expect(rows[0]?.ip_tag).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const idx = await inHub((s) =>
      s.storage.sql
        .exec<{ name: string }>(
          "select name from pragma_index_list('device_codes')",
        )
        .toArray()
        .map((r) => r.name),
    );
    expect(idx).toContain("device_codes_ip");
  });

  it("P22: rotating IPs still meet the global cap; existing codes still redeem", async () => {
    const live = await inHub(
      (s) =>
        s.storage.sql
          .exec<{ n: number }>(
            "select count(*) as n from device_codes where expires_at > ?",
            clock,
          )
          .one().n,
    );
    const mine = await newCode("before-flood");
    for (let i = live + 1; i < MAX_DEVICE_CODES; i++)
      expect((await fromIp(`198.51.101.${i % 250}`)).status).toBe(201);
    expect((await fromIp("198.51.102.1")).status).toBe(429);
    expect((await decide(mine.user_code, "approve")).status).toBe(303);
    expect((await pollJson(mine)).status).toBe("approved");
    for (const m of await hub(e).listMachines())
      if (m.label === "before-flood" && m.revokedAt === null)
        await hub(e).revokeMachine(m.id);
  });
});

describe("M2: the approval page's CSP lets 'Not you?' reach Access", () => {
  const CSP = `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self' https://${e.ACCESS_TEAM_DOMAIN}; frame-ancestors 'none'`;

  it("sends form-action 'self' plus the Access team origin, exactly", async () => {
    const code = await newCode();
    const r = await page(code.user_code, await cookie());
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    const gone = await page("ZZZZ-ZZZZ", await cookie());
    expect(gone.headers.get("content-security-policy")).toBe(CSP);
  });

  it("P21: the chain from 'Not you?' ends at that Access origin", async () => {
    const login = await SELF.fetch(`${ORIGIN}/auth/login?next=%2F`, {
      redirect: "manual",
    });
    const loc = login.headers.get("location") ?? "";
    expect(new URL(loc).origin).toBe(`https://${e.ACCESS_TEAM_DOMAIN}`);
  });

  it("falls back to form-action 'self' when ACCESS_TEAM_DOMAIN is not a hostname", async () => {
    const app = createApp();
    for (const bad of [
      "evil.com; script-src *",
      "a b",
      "",
      "https://x.com",
      "x.com/path",
    ]) {
      const r = await app.request(
        `${ORIGIN}/approve/ZZZZ-ZZZZ`,
        { headers: { cookie: await cookie() } },
        { ...e, ACCESS_TEAM_DOMAIN: bad },
      );
      expect(r.headers.get("content-security-policy"), bad).toBe(
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
    }
  });
});

describe("L1: only POST misses count toward the failed-approval cap", () => {
  it("P10: cross-site GET navigations never lock out a real code", async () => {
    const ck = await cookie();
    const real = await newCode("victim");
    for (let i = 0; i < APPROVE_FAIL_CAP + 2; i++)
      await page(`ZZZZ-ZZ${"23456789ABCD"[i]}Z`, ck);
    expect((await page(real.user_code, ck)).status).toBe(200);
  });

  it("P11: revisiting already-decided codes does not count", async () => {
    const ck = await cookie();
    const codes: Code[] = [];
    for (let i = 0; i < APPROVE_FAIL_CAP; i++) {
      const r = await json(
        "/device/code",
        { machine_label: `rv${i}` },
        { "cf-connecting-ip": `192.0.2.${i}` },
      );
      codes.push((await r.json()) as Code);
    }
    for (const c of codes)
      expect((await decide(c.user_code, "deny")).status).toBe(200);
    for (const c of codes)
      expect((await page(c.user_code, ck)).status).toBe(404);
    const fresh = await newCode("fresh");
    expect((await page(fresh.user_code, ck)).status).toBe(200);
  });

  it("POST misses still count and then lock both GET and POST", async () => {
    const ck = await cookie();
    const real = await newCode("post-guess");
    for (let i = 0; i < APPROVE_FAIL_CAP; i++) {
      const u = `ZZZZ-ZZ${"23456789ABCD"[i]}Y`;
      expect((await decide(u, "approve")).status).toBe(404);
    }
    expect((await page(real.user_code, ck)).status).toBe(429);
    expect((await decide(real.user_code, "approve")).status).toBe(429);
  });
});

describe("L2: RL_AUTH guards GET /auth/login", () => {
  const app = createApp();
  it("429s when the binding says over the limit, keyed auth:<ip>", async () => {
    const keys: string[] = [];
    const rl: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: false };
      },
    };
    const r = await app.request(
      `${ORIGIN}/auth/login`,
      { headers: { "cf-connecting-ip": "1.2.3.4" } },
      { ...e, RL_AUTH: rl },
    );
    expect(r.status).toBe(429);
    expect(keys).toEqual(["auth:1.2.3.4"]);
  });

  it("fails open when unbound or throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const RL_AUTH of [
      undefined,
      {
        limit: async () => {
          throw new Error("down");
        },
      } as RateLimit,
    ]) {
      const r = await app.request(
        `${ORIGIN}/auth/login`,
        {},
        { ...e, RL_AUTH },
      );
      expect(r.status).toBe(302);
    }
  });
});

describe("L3: a failure after the machine insert never mints a second machine", () => {
  it("keeps the claim when the machine row exists", async () => {
    const code = await newCode("half-made");
    expect((await decide(code.user_code, "approve")).status).toBe(303);
    await runInDurableObject(
      hub(e) as unknown as DurableObjectStub<Hub>,
      (h: Hub) => {
        const real = Hub.prototype.createMachine;
        Object.defineProperty(h, "createMachine", {
          configurable: true,
          value: async function (this: Hub, label: string, id?: string) {
            await real.call(this, label, id);
            throw new Error("injected after insert");
          },
        });
      },
    );
    const vi1 = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await json("/device/token", { device_code: code.device_code });
    expect(r.status).toBe(500);
    vi1.mockRestore();
    await runInDurableObject(
      hub(e) as unknown as DurableObjectStub<Hub>,
      (h: Hub) => {
        delete (h as unknown as Record<string, unknown>).createMachine;
      },
    );
    await advance(POLL_MS);
    expect(await pollJson(code)).toEqual({ status: "expired" });
    const made = (await hub(e).listMachines()).filter(
      (m) => m.label === "half-made",
    );
    expect(made).toHaveLength(1);
    for (const m of made) await hub(e).revokeMachine(m.id);
  });

  it("releases the claim when nothing was inserted", async () => {
    const code = await newCode("not-made");
    expect((await decide(code.user_code, "approve")).status).toBe(303);
    await runInDurableObject(
      hub(e) as unknown as DurableObjectStub<Hub>,
      (h: Hub) => {
        Object.defineProperty(h, "createMachine", {
          configurable: true,
          value: async () => {
            throw new Error("injected before insert");
          },
        });
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      (await json("/device/token", { device_code: code.device_code })).status,
    ).toBe(500);
    await runInDurableObject(
      hub(e) as unknown as DurableObjectStub<Hub>,
      (h: Hub) => {
        delete (h as unknown as Record<string, unknown>).createMachine;
      },
    );
    await advance(POLL_MS);
    expect((await pollJson(code)).status).toBe("approved");
    for (const m of await hub(e).listMachines())
      if (m.label === "not-made" && m.revokedAt === null)
        await hub(e).revokeMachine(m.id);
  });
});

describe("L4: the page shows when the code was requested", () => {
  it("renders 'Requested N minutes ago' from created_at", async () => {
    const code = await newCode("aged");
    const now = await (await page(code.user_code, await cookie())).text();
    expect(now).toContain("Requested just now");
    await advance(3 * 60_000 + 5_000);
    const later = await (await page(code.user_code, await cookie())).text();
    expect(later).toContain("Requested 3 minutes ago");
    await advance(-2 * 60_000);
    const one = await (await page(code.user_code, await cookie())).text();
    expect(one).toContain("Requested 1 minute ago");
  });
});

// ------------------------------------------------- B4 fix round 2 (adv-B4 R1)

describe("R1: IPv6 clients are keyed by their /64", () => {
  const fromIp = (ip?: string) =>
    json(
      "/device/code",
      {},
      ip === undefined ? {} : { "cf-connecting-ip": ip },
    );

  it("clientKey: IPv4 as is, IPv6 by /64, mapped IPv4 as IPv4, else unknown", () => {
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(clientKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:DB8:1:2:ffff:ffff:ffff:ffff")).toBe(
      "2001:db8:1:2::/64",
    );
    expect(clientKey("2001:0db8:0001:0002:0:0:0:1")).toBe("2001:db8:1:2::/64");
    expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey("::ffff:198.51.100.40")).toBe("198.51.100.40");
    expect(clientKey("::FFFF:c633:6428")).toBe("198.51.100.40");
    expect(clientKey("64:ff9b::198.51.100.40")).toBe("64:ff9b:0:0::/64");
    for (const bad of [
      null,
      undefined,
      "",
      "  ",
      "unknown",
      "1.2.3.256",
      "1.2.3",
      "2001:db8::1::2",
      "2001:db8:1:2:3:4:5:6:7",
      "fe80::1%eth0",
      "[2001:db8::1]",
      "12345::1",
      "a".repeat(100),
    ])
      expect(clientKey(bad), String(bad)).toBe("unknown");
  });

  it("F4: rotating addresses within one /64 stays capped at the per-IP share", async () => {
    let ok = 0;
    for (let i = 1; i <= 4 * DEVICE_CODES_PER_IP; i++) {
      const r = await fromIp(`2001:db8:1:2::${i.toString(16)}`);
      if (r.status === 201) ok++;
      else expect(r.status).toBe(429);
    }
    expect(ok).toBe(DEVICE_CODES_PER_IP);
    // Another /64 is another bucket.
    expect((await fromIp("2001:db8:1:3::1")).status).toBe(201);
  });

  it("an IPv4-mapped IPv6 address shares the IPv4 bucket", async () => {
    for (let i = 0; i < DEVICE_CODES_PER_IP; i++)
      expect((await fromIp("198.51.100.40")).status).toBe(201);
    expect((await fromIp("::ffff:198.51.100.40")).status).toBe(429);
  });

  it("missing, blank and malformed addresses share one 'unknown' bucket", async () => {
    const sources = [
      undefined,
      "",
      "not-an-ip",
      "unknown",
      "1.2.3.999",
      "fe80::1%eth0",
    ];
    let ok = 0;
    for (const ip of sources) if ((await fromIp(ip)).status === 201) ok++;
    expect(ok).toBe(DEVICE_CODES_PER_IP);
  });

  it("RL_DEVICE and RL_AUTH are keyed by the /64", async () => {
    const keys: string[] = [];
    const rl: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: true };
      },
    };
    const app = createApp();
    const env = { ...e, RL_DEVICE: rl, RL_AUTH: rl };
    await app.request(
      `${ORIGIN}/device/code`,
      {
        method: "POST",
        headers: { "cf-connecting-ip": "2001:db8:1:2::abcd" },
        body: "{}",
      },
      env,
    );
    await app.request(
      `${ORIGIN}/auth/login`,
      { headers: { "cf-connecting-ip": "2001:db8:1:2::beef" } },
      env,
    );
    expect(keys).toEqual([
      "device_code:2001:db8:1:2::/64",
      "auth:2001:db8:1:2::/64",
    ]);
  });
});
