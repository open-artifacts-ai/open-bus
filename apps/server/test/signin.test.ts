/**
 * Sign-in routes end to end through the Worker entry (src/index.ts): login,
 * callback against a fake Access IdP (as in redeem.test.ts), no-access,
 * logout and dev-login, plus the B1 seams now backed by the hub.
 */
import { env } from "cloudflare:workers";
import {
  exportJWK,
  generateKeyPair,
  type CryptoKey as JoseKey,
  type JWK,
  SignJWT,
} from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deriveKey } from "../src/auth/keys.js";
import { accessIssuer, stateCookieName } from "../src/auth/oidc.js";
import { ROUTE_POLICY } from "../src/auth/route-policy.js";
import {
  readSession,
  sessionCookieName,
  sessionGeneration,
  signSession,
} from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import { hub } from "../src/hub/stub.js";
import worker from "../src/index.js";
import { b64urlDecode, b64urlEncode, hmacSign } from "../src/util/crypto.js";

const base = env as unknown as Env;
const ORIGIN = `https://${base.APP_HOST}`;
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

let n = 0;
/** A fresh client id per test, so the per-issuer JWKS cache never leaks between tests. */
const freshEnv = (over: Partial<Env> = {}): Env => ({
  ...base,
  ACCESS_CLIENT_ID: `signin-cid-${++n}`,
  ...over,
});

const call = (url: string, init: RequestInit = {}, e: Env = base) =>
  worker.fetch(
    new Request(url.startsWith("http") ? url : `${ORIGIN}${url}`, {
      redirect: "manual",
      ...init,
    }) as Request<unknown, IncomingRequestCfProperties>,
    e,
    ctx,
  );

const setCookies = (r: Response) => r.headers.getSetCookie();
/** `name=value` of the Set-Cookie for `name`, or undefined. */
const jarFor = (r: Response, name: string) =>
  setCookies(r)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0];
const cookieValue = (jar: string) => jar.slice(jar.indexOf("=") + 1);

let priv: JoseKey;
let jwk: JWK;
beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  priv = kp.privateKey;
  jwk = {
    ...(await exportJWK(kp.publicKey)),
    kid: "k1",
    alg: "RS256",
    use: "sig",
  };
});
afterEach(() => vi.restoreAllMocks());

const tokenCalls: string[] = [];
/** Stubs Access: /token answers an id_token from `token(nonce)`, /jwks the test key. */
function fakeIdp(idToken: () => Promise<string> | string) {
  tokenCalls.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.endsWith("/token")) {
      tokenCalls.push(url);
      return Response.json({ id_token: await idToken() });
    }
    if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
    throw new Error(`unexpected fetch ${url}`);
  });
}

const now = () => Math.floor(Date.now() / 1000);
const idToken = (e: Env, nonce: string, email = "owner@example.com") =>
  new SignJWT({ nonce, email, sub: "sub-1" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(accessIssuer(e))
    .setAudience(e.ACCESS_CLIENT_ID)
    .setIssuedAt(now())
    .setExpirationTime(now() + 300)
    .sign(priv);

type StatePayload = {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  exp: number;
  retry?: boolean;
};
const decodeState = (jar: string): StatePayload =>
  JSON.parse(
    new TextDecoder().decode(
      b64urlDecode(cookieValue(jar).split(".")[0] as string) as Uint8Array,
    ),
  ) as StatePayload;

/** GET /auth/login; returns what the browser carries to the callback. */
async function startLogin(e: Env, next = "/machines") {
  const r = await call(`/auth/login?next=${encodeURIComponent(next)}`, {}, e);
  expect(r.status).toBe(302);
  const state = new URL(r.headers.get("location") as string).searchParams.get(
    "state",
  ) as string;
  const name = await stateCookieName(e, state);
  const jar = jarFor(r, name) as string;
  expect(jar).toBeTruthy();
  return { state, name, jar, payload: decodeState(jar) };
}

/** A state cookie signed with the real key, for payloads /auth/login would never mint. */
async function forgeState(e: Env, over: Partial<StatePayload>) {
  const st: StatePayload = {
    state: b64urlEncode(crypto.getRandomValues(new Uint8Array(32))),
    nonce: "forged-nonce",
    verifier: "forged-verifier",
    next: "/",
    exp: Date.now() + 600_000,
    ...over,
  };
  const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(st)));
  const sig = await hmacSign(await deriveKey(e, "ob:oidc-state"), p);
  const name = await stateCookieName(e, st.state);
  return {
    state: st.state,
    name,
    jar: `${name}=${p}.${sig}`,
    payload: st,
  };
}

const callback = (e: Env, l: { state: string; jar: string }) =>
  call(
    `/auth/callback?state=${encodeURIComponent(l.state)}&code=the-code`,
    { headers: { cookie: l.jar } },
    e,
  );

/** Full sign-in for `email`; returns the callback response. */
async function signIn(e: Env, email = "owner@example.com", next = "/machines") {
  const l = await startLogin(e, next);
  fakeIdp(() => idToken(e, l.payload.nonce, email));
  return { l, r: await callback(e, l) };
}

const clearsCookie = (r: Response, name: string) =>
  setCookies(r).some(
    (c) => c.startsWith(`${name}=;`) && c.includes("Max-Age=0"),
  );

const expectNoStore = (r: Response) =>
  expect(r.headers.get("cache-control")).toBe("no-store");

const expectHtml = (r: Response) => {
  expect(r.headers.get("content-type")).toContain("text/html");
  expect(r.headers.get("content-security-policy")).toBe(CSP);
  expectNoStore(r);
};

/** Every `next` that must fall back to "/". */
const BAD_NEXT = [
  "//evil.test",
  "/\\evil.test",
  "%2F%2Fevil.test",
  "/%2F/evil.test",
  "/%5Cevil.test",
  "%252F%252Fevil.test",
  "/%252F/evil.test",
  "/%255Cevil.test",
  "https://evil.test",
  "http://evil.test/machines",
  "javascript:alert(1)",
  "/\tevil",
  "/mach\nines",
  "/%09/evil.test",
  "/%0d%0aSet-Cookie:x=1",
  `/${"a".repeat(2100)}`,
];

const sessionOf = (r: Response) => jarFor(r, sessionCookieName(base));

describe("route policy", () => {
  it("lists every sign-in route with the right kind", () => {
    expect(ROUTE_POLICY["GET /auth/login"]).toHaveProperty("public");
    expect(ROUTE_POLICY["GET /auth/callback"]).toHaveProperty("public");
    expect(ROUTE_POLICY["GET /auth/no-access"]).toHaveProperty("public");
    expect(ROUTE_POLICY["POST /auth/logout"]).toHaveProperty("public");
    expect(ROUTE_POLICY["GET /auth/dev-login"]).toHaveProperty("public");
  });

  it("still 404s unlisted /auth routes and other methods", async () => {
    expect((await call("/auth/nope")).status).toBe(404);
    expect((await call("/auth/login", { method: "POST" })).status).toBe(404);
    expect((await call("/auth/logout")).status).toBe(404);
  });
});

describe("/auth/login", () => {
  it("redirects to Access with PKCE and sets an HttpOnly state cookie", async () => {
    const r = await call("/auth/login?next=/machines");
    expect(r.status).toBe(302);
    expectNoStore(r);
    const loc = new URL(r.headers.get("location") as string);
    expect(`${loc.origin}${loc.pathname}`).toBe(
      `${accessIssuer(base)}/authorization`,
    );
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/auth/callback`,
    );
    const set = setCookies(r).join("\n");
    expect(set).toMatch(/ob_oidc_[A-Za-z0-9_-]{10}=/);
    expect(set).toContain("HttpOnly");
  });

  it("keeps a safe next", async () => {
    const l = await startLogin(freshEnv(), "/machines?x=1#y");
    expect(l.payload.next).toBe("/machines?x=1#y");
  });

  it.each(BAD_NEXT)("falls back to / for next=%j", async (bad) => {
    const r = await call(`/auth/login?next=${encodeURIComponent(bad)}`);
    expect(r.headers.get("location") ?? "").not.toContain("evil");
    const jar = setCookies(r)
      .find((c) => /ob_oidc_/.test(c))
      ?.split(";")[0] as string;
    expect(decodeState(jar).next).toBe("/");
  });
});

describe("/auth/callback", () => {
  it("signs the owner in, goes to next, and clears the state cookie", async () => {
    const e = freshEnv();
    const { l, r } = await signIn(e);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/machines");
    expectNoStore(r);
    expect(clearsCookie(r, l.name)).toBe(true);
    const s = sessionOf(r) as string;
    const session = await readSession(e, cookieValue(s));
    expect(session?.uid).toBe("owner");
    expect(session?.gen).toBe(await sessionGeneration(e));
  });

  it("refuses a replayed state (single use) without redeeming again", async () => {
    const e = freshEnv();
    const { l, r } = await signIn(e);
    expect(sessionOf(r)).toBeTruthy();
    expect(tokenCalls).toHaveLength(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const again = await callback(e, l);
    expect(warn).toHaveBeenCalled();
    expect(sessionOf(again)).toBeUndefined();
    expect(again.headers.get("location")).not.toBe("/machines");
    expect(again.status).toBe(400);
    expectHtml(again);
    expect(clearsCookie(again, l.name)).toBe(true);
    expect(tokenCalls).toHaveLength(1);
  });

  it("sends a non-owner to /auth/no-access without a session", async () => {
    const e = freshEnv();
    const { l, r } = await signIn(e, "someone@example.com");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/auth/no-access");
    expect(sessionOf(r)).toBeUndefined();
    expect(clearsCookie(r, l.name)).toBe(true);
    expectNoStore(r);
  });

  it.each([
    ["kelvin@example.com", "Kelvin@example.com"], // KELVIN SIGN
    ["kelvin@example.com", "kelvın@example.com"], // dotless i
    ["owner@example.com", "owner@examplе.com"], // Cyrillic e
    ["owner@example.com", "ｏwner@example.com"], // fullwidth o
    ["owner@example.com", "owner@example.com​"], // zero-width space
    ["owner@example.com", "owner @example.com"], // no-break space
    ["owner@example.com", "owner@example.co"],
  ])("refuses a look-alike of %s: %j", async (ownerEmail, email) => {
    const e = freshEnv({ OWNER_EMAIL: ownerEmail });
    const { r } = await signIn(e, email);
    expect(r.headers.get("location")).toBe("/auth/no-access");
    expect(sessionOf(r)).toBeUndefined();
  });

  it("accepts the owner's email in another ASCII case", async () => {
    const e = freshEnv({ OWNER_EMAIL: "Kelvin@Example.com" });
    const { r } = await signIn(e, "kELVIN@example.COM");
    expect(r.headers.get("location")).toBe("/machines");
    expect(jarFor(r, sessionCookieName(e))).toBeTruthy();
  });

  it.each(BAD_NEXT)(
    "re-checks next from the state: %j goes to /",
    async (bad) => {
      const e = freshEnv();
      const l = await forgeState(e, { next: bad });
      fakeIdp(() => idToken(e, l.payload.nonce));
      const r = await callback(e, l);
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("/");
      expect(sessionOf(r)).toBeTruthy();
    },
  );

  it("without a state cookie redirects to a single retry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await call("/auth/callback?state=abc&code=x");
    expect(warn).toHaveBeenCalled();
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(
      `/auth/login?next=${encodeURIComponent("/")}&retry=1`,
    );
    expectNoStore(r);
  });

  it("a failed retry renders the static page and clears its cookie", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = freshEnv();
    const l = await forgeState(e, {
      state: `r1.${b64urlEncode(crypto.getRandomValues(new Uint8Array(32)))}`,
      retry: true,
      exp: Date.now() - 1000,
    });
    const r = await callback(e, l);
    expect(r.status).toBe(400);
    expectHtml(r);
    expect(clearsCookie(r, l.name)).toBe(true);
  });

  it("a redeem failure clears the state cookie and sets no session", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = freshEnv();
    const l = await startLogin(e);
    fakeIdp(() => idToken(e, "attacker-nonce"));
    const r = await callback(e, l);
    expect(r.status).toBe(401);
    expectNoStore(r);
    expect(clearsCookie(r, l.name)).toBe(true);
    expect(sessionOf(r)).toBeUndefined();
  });
});

describe("/auth/no-access", () => {
  it("is a 403 HTML page with the strict CSP", async () => {
    const r = await call("/auth/no-access");
    expect(r.status).toBe(403);
    expectHtml(r);
  });
});

describe("/auth/logout", () => {
  const logout = (headers: Record<string, string>, e: Env = base) =>
    call("/auth/logout", { method: "POST", headers }, e);
  const fresh = async () =>
    `${sessionCookieName(base)}=${await signSession(base)}`;

  it.each([
    [{ origin: "https://evil.test" }],
    [{ origin: "null" }],
    [{ origin: `http://${base.APP_HOST}` }],
    [{ origin: `${ORIGIN}.evil.test` }],
    [{ origin: "https://evil.test", "sec-fetch-site": "same-origin" }],
    [{}],
    [{ "sec-fetch-site": "cross-site" }],
    [{ "sec-fetch-site": "same-site" }],
    [{ "sec-fetch-site": "none" }],
  ])(
    "refuses a cross-origin request %j with 403 and no sign-out",
    async (h) => {
      const c = await fresh();
      const gen = await sessionGeneration(base);
      const r = await logout({ ...h, cookie: c });
      expect(r.status).toBe(403);
      expectNoStore(r);
      expect(setCookies(r)).toEqual([]);
      expect(await sessionGeneration(base)).toBe(gen);
      expect(await readSession(base, cookieValue(c))).not.toBeNull();
    },
  );

  it.each([
    [{ origin: ORIGIN }],
    [{ "sec-fetch-site": "same-origin" }],
    [{ origin: ORIGIN, "sec-fetch-site": "cross-site" }],
  ])("signs every session out for a same-origin request %j", async (h) => {
    const c = await fresh();
    const other = await signSession(base);
    const gen = await sessionGeneration(base);
    const r = await logout({ ...h, cookie: c });
    expect(r.status).toBe(204);
    expectNoStore(r);
    expect(clearsCookie(r, sessionCookieName(base))).toBe(true);
    expect(await sessionGeneration(base)).toBe(gen + 1);
    expect(await readSession(base, cookieValue(c))).toBeNull();
    expect(await readSession(base, other)).toBeNull();
  });

  it("without a valid session still clears the cookie but does not bump", async () => {
    const gen = await sessionGeneration(base);
    for (const cookie of [undefined, `${sessionCookieName(base)}=forged.sig`]) {
      const r = await logout(
        cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN },
      );
      expect(r.status).toBe(204);
      expectNoStore(r);
      expect(clearsCookie(r, sessionCookieName(base))).toBe(true);
    }
    expect(await sessionGeneration(base)).toBe(gen);
  });

  it("clears the cookie name the browser holds (production: __Host-)", async () => {
    const prod = { ...base, ENVIRONMENT: "production" } as Env;
    const r = await logout({ origin: ORIGIN }, prod);
    expect(r.status).toBe(204);
    expect(clearsCookie(r, "__Host-ob_session")).toBe(true);
  });
});

describe("/auth/dev-login", () => {
  const LOOPBACK = [
    "http://localhost",
    "http://127.0.0.1:8787",
    "http://[::1]",
  ];

  it.each(LOOPBACK)(
    "signs the owner in at %s at the current generation",
    async (o) => {
      await hub(base).bumpSessionGeneration();
      const r = await call(`${o}/auth/dev-login?next=/machines`);
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("/machines");
      expectNoStore(r);
      const s = await readSession(base, cookieValue(sessionOf(r) as string));
      expect(s?.uid).toBe("owner");
      expect(s?.gen).toBe(await sessionGeneration(base));
    },
  );

  it.each(BAD_NEXT)("falls back to / for next=%j", async (bad) => {
    const r = await call(
      `http://localhost/auth/dev-login?next=${encodeURIComponent(bad)}`,
    );
    expect(r.headers.get("location")).toBe("/");
  });

  it("is the same 404 off loopback or outside dev", async () => {
    const prod = { ...base, ENVIRONMENT: "production" } as Env;
    const cases: [string, Env][] = [
      [`${ORIGIN}/auth/dev-login`, base],
      ["http://evil.test/auth/dev-login", base],
      ["http://localhost.evil.test/auth/dev-login", base],
      ["http://127.0.0.2/auth/dev-login", base],
      ["http://localhost/auth/dev-login", prod],
      ["http://127.0.0.1/auth/dev-login", prod],
      [`${ORIGIN}/auth/dev-login`, prod],
    ];
    const seen = new Set<string>();
    for (const [url, e] of cases) {
      const r = await call(url, {}, e);
      expect(r.status, url).toBe(404);
      expectNoStore(r);
      expect(setCookies(r), url).toEqual([]);
      expect(r.headers.get("location")).toBeNull();
      seen.add(
        JSON.stringify([r.status, await r.text(), [...r.headers.entries()]]),
      );
    }
    expect(seen.size).toBe(1);
  });

  it("an old session is refused after logout; a new dev login works", async () => {
    const first = sessionOf(
      await call("http://localhost/auth/dev-login"),
    ) as string;
    expect(await readSession(base, cookieValue(first))).not.toBeNull();
    const out = await call("/auth/logout", {
      method: "POST",
      headers: { origin: ORIGIN, cookie: first },
    });
    expect(out.status).toBe(204);
    expect(await readSession(base, cookieValue(first))).toBeNull();
    const second = sessionOf(
      await call("http://localhost/auth/dev-login"),
    ) as string;
    expect(await readSession(base, cookieValue(second))).not.toBeNull();
  });
});

/** A HUB whose every RPC throws (the hub is down). */
const downHub = (calls: string[] = []) =>
  ({
    idFromName: () => ({}),
    get: () =>
      new Proxy(
        {},
        {
          get: (_t, k) => async () => {
            calls.push(String(k));
            throw new Error("hub down");
          },
        },
      ),
  }) as unknown as Env["HUB"];

describe("fix round 1", () => {
  const logout = (
    url: string,
    headers: Record<string, string>,
    e: Env = base,
  ) => call(url, { method: "POST", headers }, e);

  // L1
  it.each([
    ["http://localhost/auth/logout", "http://localhost", base],
    ["http://[::1]/auth/logout", "http://[::1]", base],
    [
      "http://127.0.0.1:8787/auth/logout",
      "http://127.0.0.1:8787",
      { ...base, APP_HOST: "127.0.0.1:8787" } as Env,
    ],
  ])(
    "L1: dev on loopback accepts an http Origin (%s)",
    async (url, origin, e) => {
      const r = await logout(url, { origin }, e);
      expect(r.status).toBe(204);
      expect(clearsCookie(r, sessionCookieName(e))).toBe(true);
    },
  );

  it.each([
    // dev, non-loopback host
    ["http://app.localhost/auth/logout", "http://app.localhost", base],
    ["http://evil.test/auth/logout", "http://evil.test", base],
    // dev, loopback host, but an http Origin for another host or port
    ["http://localhost/auth/logout", "http://127.0.0.1", base],
    ["http://localhost:8787/auth/logout", "http://localhost:9999", base],
    // production over http, even on loopback
    [
      "http://localhost/auth/logout",
      "http://localhost",
      { ...base, ENVIRONMENT: "production" } as Env,
    ],
    [
      `http://${base.APP_HOST}/auth/logout`,
      `http://${base.APP_HOST}`,
      { ...base, ENVIRONMENT: "production" } as Env,
    ],
  ])("L1: refuses http Origin at %s (Origin %s)", async (url, origin, e) => {
    const r = await logout(url, { origin }, e);
    expect(r.status).toBe(403);
    expect(setCookies(r)).toEqual([]);
  });

  // L2
  it.each(["cross-site", "same-site"])(
    "L2: dev-login with Sec-Fetch-Site: %s is the same 404",
    async (site) => {
      const r = await call("http://localhost/auth/dev-login", {
        headers: { "sec-fetch-site": site },
      });
      const off = await call(`${ORIGIN}/auth/dev-login`);
      expect(r.status).toBe(404);
      expect(setCookies(r)).toEqual([]);
      expect([await r.text(), [...r.headers.entries()]]).toEqual([
        await off.text(),
        [...off.headers.entries()],
      ]);
    },
  );

  it.each([undefined, "none", "same-origin"])(
    "L2: dev-login with Sec-Fetch-Site %j signs in",
    async (site) => {
      const r = await call("http://localhost/auth/dev-login", {
        headers: site ? { "sec-fetch-site": site } : {},
      });
      expect(r.status).toBe(302);
      expect(sessionOf(r)).toBeTruthy();
    },
  );

  // L4
  it("L4/R2: a valid session with the hub down answers 500 internal, no-store, cookie cleared", async () => {
    const calls: string[] = [];
    const e = { ...base, HUB: downHub(calls) } as Env;
    const c = `${sessionCookieName(base)}=${await signSession(base)}`;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await logout("/auth/logout", { origin: ORIGIN, cookie: c }, e);
    err.mockRestore();
    expect(r.status).toBe(500);
    expectNoStore(r);
    expect(
      ((await r.json()) as { error: { code: string; message: string } }).error,
    ).toEqual({
      code: "internal",
      message: "Signed out here; could not sign out other sessions",
    });
    expect(clearsCookie(r, sessionCookieName(base))).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  // R1: nothing short of a validly signed session reaches the hub.
  it.each([
    ["forged", () => `forged.sig`],
    [
      "bad signature",
      async () => `${(await signSession(base)).slice(0, -2)}AA`,
    ],
    ["expired", () => signSession(base, "owner", Date.now() - 8 * 86400_000)],
    [
      "another host",
      () => signSession({ ...base, APP_HOST: "other.example" } as Env),
    ],
  ])(
    "R1: a %s cookie with the hub down gets 204, cleared, hub never called",
    async (_n, mk) => {
      const calls: string[] = [];
      const e = { ...base, HUB: downHub(calls) } as Env;
      const cookie = `${sessionCookieName(base)}=${await mk()}`;
      const r = await logout("/auth/logout", { origin: ORIGIN, cookie }, e);
      expect(r.status).toBe(204);
      expectNoStore(r);
      expect(clearsCookie(r, sessionCookieName(base))).toBe(true);
      expect(calls).toEqual([]);
    },
  );

  it("L4: no session cookie is still 204 even with the hub down", async () => {
    const e = { ...base, HUB: downHub() } as Env;
    const r = await logout("/auth/logout", { origin: ORIGIN }, e);
    expect(r.status).toBe(204);
    expect(clearsCookie(r, sessionCookieName(base))).toBe(true);
  });
});
