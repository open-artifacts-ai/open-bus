/**
 * handleCallback -> redeem against a fake Access IdP: fetch is stubbed for
 * /token and /jwks, and id_tokens are signed with a local RSA key.
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
import {
  accessIssuer,
  buildAuthorizeRedirect,
  handleCallback,
  isOwner,
  OidcRedeemError,
} from "../src/auth/oidc.js";
import type { Env } from "../src/env.js";
import { b64urlDecode, b64urlEncode } from "../src/util/crypto.js";

const base = env as unknown as Env;
let priv: JoseKey;
let jwk: JWK;
let n = 0;

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

/** A fresh client id per test, so the per-issuer JWKS cache never leaks between tests. */
const freshEnv = (): Env => ({ ...base, ACCESS_CLIENT_ID: `cid-${++n}` });

type Fake = { token: (body: URLSearchParams) => Response | Promise<Response> };
const calls: { url: string; body: string }[] = [];

function fakeIdp(f: Fake) {
  calls.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const body = init?.body ? String(init.body) : "";
    calls.push({ url, body });
    if (url.endsWith("/token")) return f.token(new URLSearchParams(body));
    if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
    throw new Error(`unexpected fetch ${url}`);
  });
}

/** Starts a login; returns what the browser sends back to /auth/callback. */
async function login(e: Env) {
  const r = await buildAuthorizeRedirect(e, "/machines", {});
  const jar = r.stateCookie.split(";")[0] as string;
  const value = jar.split("=")[1] as string;
  const st = JSON.parse(
    new TextDecoder().decode(
      b64urlDecode(value.split(".")[0] as string) as Uint8Array,
    ),
  ) as { nonce: string };
  const state = new URL(r.location).searchParams.get("state") as string;
  return { state, nonce: st.nonce, jar };
}

const callback = (e: Env, l: { state: string; jar: string }) =>
  new Request(
    `https://${e.APP_HOST}/auth/callback?state=${encodeURIComponent(l.state)}&code=the-code`,
    { headers: { cookie: l.jar } },
  );

const now = () => Math.floor(Date.now() / 1000);

/** A valid Access id_token for `e`, with `over` replacing claims (undefined drops one). */
function idToken(
  e: Env,
  nonce: string,
  over: Record<string, unknown> = {},
  opt: { iss?: string; aud?: string; iat?: number; exp?: number } = {},
) {
  const claims: Record<string, unknown> = {
    nonce,
    email: "owner@example.com",
    email_verified: true,
    sub: "sub-1",
    ...over,
  };
  for (const k of Object.keys(claims))
    if (claims[k] === undefined) delete claims[k];
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opt.iss ?? accessIssuer(e))
    .setAudience(opt.aud ?? e.ACCESS_CLIENT_ID)
    .setIssuedAt(opt.iat ?? now())
    .setExpirationTime(opt.exp ?? now() + 300)
    .sign(priv);
}

async function run(e: Env, token: (nonce: string) => Promise<string> | string) {
  const l = await login(e);
  const tok = await token(l.nonce);
  fakeIdp({ token: () => Response.json({ id_token: tok }) });
  return handleCallback(e, callback(e, l));
}

/** The OidcRedeemError stage, or "ACCEPTED". */
async function stageOf(p: Promise<unknown>): Promise<string | null> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await p;
    return "ACCEPTED";
  } catch (err) {
    if (!(err instanceof OidcRedeemError)) throw err;
    return err.stage;
  } finally {
    warn.mockRestore();
  }
}

const enc = (o: object) =>
  b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));

describe("redeem", () => {
  it("returns the owner's identity and sends the PKCE verifier and secret", async () => {
    const e = freshEnv();
    const id = await run(e, (nonce) => idToken(e, nonce));
    expect(id).toMatchObject({
      email: "owner@example.com",
      subject: "sub-1",
      next: "/machines",
      owner: true,
    });
    const body = new URLSearchParams(
      calls.find((c) => c.url.endsWith("/token"))?.body,
    );
    expect(body.get("code")).toBe("the-code");
    expect(body.get("code_verifier")).toBeTruthy();
    expect(body.get("client_secret")).toBe(e.ACCESS_CLIENT_SECRET);
  });

  it("flags a verified non-owner email as not the owner", async () => {
    const e = freshEnv();
    const id = await run(e, (nonce) =>
      idToken(e, nonce, { email: "someone@example.com" }),
    );
    expect(id.owner).toBe(false);
  });

  it("refuses a bad nonce", async () => {
    const e = freshEnv();
    expect(await stageOf(run(e, () => idToken(e, "attacker-nonce")))).toBe(
      "nonce",
    );
  });

  it("refuses a wrong aud, a wrong iss and an expired token", async () => {
    const e1 = freshEnv();
    expect(
      await stageOf(run(e1, (nc) => idToken(e1, nc, {}, { aud: "other" }))),
    ).toBe("jwt_verify");
    const e2 = freshEnv();
    expect(
      await stageOf(
        run(e2, (nc) => idToken(e2, nc, {}, { iss: "https://evil/" })),
      ),
    ).toBe("jwt_verify");
    const e3 = freshEnv();
    expect(
      await stageOf(
        run(e3, (nc) =>
          idToken(e3, nc, {}, { iat: now() - 900, exp: now() - 120 }),
        ),
      ),
    ).toBe("jwt_verify");
  });

  it("refuses a token older than 10 minutes, future-dated, or without iat", async () => {
    const e1 = freshEnv();
    expect(
      await stageOf(run(e1, (nc) => idToken(e1, nc, {}, { iat: now() - 700 }))),
    ).toBe("jwt_verify");
    const e2 = freshEnv();
    expect(
      await stageOf(
        run(e2, (nc) =>
          idToken(
            e2,
            nc,
            {},
            { iat: now() + 365 * 86400, exp: now() + 3650 * 86400 },
          ),
        ),
      ),
    ).toBe("jwt_verify");
    const e3 = freshEnv();
    expect(
      await stageOf(
        run(e3, (nc) =>
          new SignJWT({ nonce: nc, email: "owner@example.com", sub: "s" })
            .setProtectedHeader({ alg: "RS256", kid: "k1" })
            .setIssuer(accessIssuer(e3))
            .setAudience(e3.ACCESS_CLIENT_ID)
            .setExpirationTime(now() + 300)
            .sign(priv),
        ),
      ),
    ).toBe("jwt_verify");
  });

  it("refuses alg none", async () => {
    const e = freshEnv();
    const t = now();
    const tok = (nonce: string) =>
      `${enc({ alg: "none" })}.${enc({ iss: accessIssuer(e), aud: e.ACCESS_CLIENT_ID, iat: t, exp: t + 300, nonce, sub: "s", email: "owner@example.com", email_verified: true })}.`;
    expect(await stageOf(run(e, tok))).toBe("jwt_verify");
  });

  it("refuses HS256 signed with the public JWK as the secret", async () => {
    const e = freshEnv();
    const secret = new TextEncoder().encode(JSON.stringify(jwk));
    const tok = (nonce: string) =>
      new SignJWT({
        nonce,
        sub: "s",
        email: "owner@example.com",
        email_verified: true,
      })
        .setProtectedHeader({ alg: "HS256", kid: "k1" })
        .setIssuer(accessIssuer(e))
        .setAudience(e.ACCESS_CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime(now() + 300)
        .sign(secret);
    expect(await stageOf(run(e, tok))).toBe("jwt_verify");
  });

  it("refuses an email that is not verified as boolean true", async () => {
    for (const v of [false, undefined, "true", 1, null]) {
      const e = freshEnv();
      expect([
        v,
        await stageOf(run(e, (nc) => idToken(e, nc, { email_verified: v }))),
      ]).toEqual([v, "email_unverified"]);
    }
  });

  it("refuses a missing or empty sub", async () => {
    const e1 = freshEnv();
    expect(
      await stageOf(run(e1, (nc) => idToken(e1, nc, { sub: undefined }))),
    ).toBe("jwt_verify");
    const e2 = freshEnv();
    expect(await stageOf(run(e2, (nc) => idToken(e2, nc, { sub: "" })))).toBe(
      "sub",
    );
  });

  it("maps token-endpoint errors to a fixed stage and logs only the error code", async () => {
    const cases: [Fake["token"], string][] = [
      [
        () =>
          new Response(null, {
            status: 302,
            headers: {
              location:
                "https://x/cb?error=invalid_grant&error_description=code%20the-code%20for%20owner%40example.com",
            },
          }),
        "token_http_302",
      ],
      [
        () =>
          Response.json(
            {
              error: "invalid_client",
              error_description: "client_secret test-client-secret",
            },
            { status: 400 },
          ),
        "token_http_400",
      ],
      [() => new Response("<html>"), "token_bad_json"],
      [() => Response.json({}), "no_id_token"],
      [
        () => {
          throw new TypeError("dns");
        },
        "token_fetch",
      ],
    ];
    for (const [token, stage] of cases) {
      const e = freshEnv();
      const l = await login(e);
      fakeIdp({ token });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const err = await handleCallback(e, callback(e, l)).catch((x) => x);
      const out = warn.mock.calls.flat().join("\n");
      warn.mockRestore();
      expect(err).toBeInstanceOf(OidcRedeemError);
      expect(err.stage).toBe(stage);
      expect(out).toContain(stage);
      for (const s of [
        "the-code",
        "owner@example.com",
        e.ACCESS_CLIENT_SECRET,
        "description",
      ])
        expect(out).not.toContain(s);
    }
  });
});

describe("isOwner", () => {
  const e = { OWNER_EMAIL: "Owner@Example.com" };
  it("matches case-insensitively and trims", () => {
    expect(isOwner(e, "owner@example.com")).toBe(true);
    expect(isOwner(e, " OWNER@EXAMPLE.COM ")).toBe(true);
  });
  it("refuses other addresses and any non-ASCII lookalike", () => {
    expect(isOwner(e, "owner+x@example.com")).toBe(false);
    expect(isOwner({ OWNER_EMAIL: "k@example.com" }, "K@example.com")).toBe(
      false,
    );
    expect(isOwner(e, "owner@example.com​")).toBe(false);
    expect(isOwner({ OWNER_EMAIL: "" }, "")).toBe(false);
  });
});
