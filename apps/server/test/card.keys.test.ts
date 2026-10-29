// AC4a: the card key loader, the JWKS route and the test-key guard.
import { env } from "cloudflare:workers";
import { CARD_TYP, LINK_TYP, R } from "@ob/shared";
import { TEST_CARD_JWK, TEST_CARD_KEY_X } from "@ob/shared/mocks";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  jwtVerify,
} from "jose";
import { describe, expect, it } from "vitest";
import { ROUTE_POLICY } from "../src/auth/route-policy.js";
import {
  isTestCardKey,
  loadCardKeys,
  ownerId,
  SERVER_TEST_CARD_KEY_X,
  signJws,
  TestKeyError,
} from "../src/card/keys.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;
const base = env as unknown as Env;
const SALT = `${"s".repeat(24)}A_-0123456789abcdefghijk`; // 48 base64url chars

async function newKey(kid: string): Promise<JWK> {
  const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  return { ...(await exportJWK(privateKey)), kid, alg: "EdDSA" };
}
const pub = ({ d: _d, ...k }: JWK): JWK => k;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** The same 32 bytes with the last char's 2 spare low bits flipped (non-canonical). */
const spare = (s: string, bits = 1): string =>
  s.slice(0, -1) + B64[B64.indexOf(s.slice(-1)) ^ bits];

const withCard = (
  key: JWK | string | undefined,
  extra: Partial<Env> = {},
): Env => ({
  ...base,
  CARD_SIGNING_KEY: typeof key === "string" ? key : key && JSON.stringify(key),
  CARD_OWNER_SALT: SALT,
  ...extra,
});

const getJwks = (e: Env) =>
  worker.fetch(
    new Request(`https://app.localhost${R.jwks}`) as Request<
      unknown,
      IncomingRequestCfProperties
    >,
    e,
    ctx,
  );

const K1 = await newKey("ob-20261029T120000Z-aaaaaa");
const K0 = await newKey("ob-20261001T120000Z-bbbbbb");

describe("GET /.well-known/jwks.json", () => {
  it("is a public route", () => {
    expect(ROUTE_POLICY[`GET ${R.jwks}`]).toEqual({
      public: expect.any(String),
    });
  });

  it("answers 503 no-store when any secret is absent or malformed", async () => {
    const cases: Env[] = [
      base,
      withCard(undefined),
      withCard(K1, { CARD_OWNER_SALT: undefined }),
      withCard(K1, { CARD_OWNER_SALT: "short" }),
      withCard("not json"),
      withCard(pub(K1)),
      withCard({ ...K1, kid: "" }),
      withCard({ ...K1, crv: "P-256" }),
      withCard({ ...K1, x: K0.x }), // d does not match x
      withCard(K1, { CARD_SIGNING_KEY_PREV: JSON.stringify(K0) }), // PREV has d
      withCard(K1, { CARD_SIGNING_KEY_PREV: "{" }),
      withCard({ ...K1, kty: "EC" }),
      withCard({ ...K1, alg: "RS256" }),
      withCard({ ...K1, alg: "none" }),
      withCard({ ...K1, alg: undefined }), // I11: alg is present
      withCard({ ...K1, kid: "ob-1\nx" }),
      withCard({ ...K1, kid: "k".repeat(65) }),
      withCard({ ...K1, x: `${K1.x}=` }),
      withCard({ ...K1, x: `${K1.x?.slice(0, -1)}+` }),
      withCard({ ...K1, x: spare(K1.x as string) }), // non-canonical x
      withCard({ ...K1, d: spare(K1.d as string) }), // non-canonical d
      withCard({ ...K1, d: `${K1.d}AA` }), // wrong length
      withCard(K1, { CARD_SIGNING_KEY_PREV: JSON.stringify(pub(K1)) }), // same kid
      withCard(K1, {
        CARD_SIGNING_KEY_PREV: JSON.stringify({
          ...pub(K0),
          x: spare(K0.x as string),
        }),
      }),
    ];
    for (const e of cases) {
      const r = await getJwks(e);
      expect(r.status).toBe(503);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(await r.json()).toEqual({
        error: { code: "internal", message: expect.any(String) },
      });
    }
  });

  it("serves the current public key, then PREV, cacheable, with no d", async () => {
    const r = await getJwks(
      withCard(K1, { CARD_SIGNING_KEY_PREV: JSON.stringify(pub(K0)) }),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=3600");
    const text = await r.text();
    expect(text).not.toContain('"d"');
    expect(text).not.toContain(K1.d);
    const body = JSON.parse(text) as { keys: JWK[] };
    expect(body.keys.map((k) => k.kid)).toEqual([K1.kid, K0.kid]);
    expect(body.keys[0]).toEqual(pub(K1));
    expect(body.keys[1]).toEqual(pub(K0));
  });

  it("serves only the current key before the first rotation", async () => {
    const r = await getJwks(withCard(K1));
    expect(((await r.json()) as { keys: JWK[] }).keys).toEqual([pub(K1)]);
  });
});

describe("test-key guard", () => {
  it("server constant equals the shared test key's x", () => {
    expect(SERVER_TEST_CARD_KEY_X).toBe(TEST_CARD_KEY_X);
  });

  it("refuses the test key outside dev: 503, and the loader throws", async () => {
    const e = withCard({ ...TEST_CARD_JWK }, { ENVIRONMENT: "production" });
    expect((await getJwks(e)).status).toBe(503);
    await expect(loadCardKeys(e)).rejects.toBeInstanceOf(TestKeyError);
  });

  it("refuses a test key published as PREV outside dev", async () => {
    const e = withCard(K1, {
      ENVIRONMENT: "production",
      CARD_SIGNING_KEY_PREV: JSON.stringify(pub({ ...TEST_CARD_JWK })),
    });
    expect((await getJwks(e)).status).toBe(503);
    await expect(loadCardKeys(e)).rejects.toBeInstanceOf(TestKeyError);
  });

  it("refuses non-canonical test-key encodings, current or PREV, outside dev", async () => {
    for (const bits of [1, 3]) {
      const x = spare(TEST_CARD_KEY_X, bits); // ...LUGB, ...LUGD
      expect(isTestCardKey({ x })).toBe(true);
      for (const extra of [
        {},
        { ENVIRONMENT: undefined as unknown as Env["ENVIRONMENT"] },
      ]) {
        const cur = withCard(
          { ...TEST_CARD_JWK, x },
          { ENVIRONMENT: "production", ...extra },
        );
        expect((await getJwks(cur)).status).toBe(503);
        await expect(loadCardKeys(cur)).rejects.toBeInstanceOf(TestKeyError);
        const prev = withCard(K1, {
          ENVIRONMENT: "production",
          CARD_SIGNING_KEY_PREV: JSON.stringify(pub({ ...TEST_CARD_JWK, x })),
          ...extra,
        });
        expect((await getJwks(prev)).status).toBe(503);
        await expect(loadCardKeys(prev)).rejects.toBeInstanceOf(TestKeyError);
      }
    }
    expect(isTestCardKey({ x: TEST_CARD_KEY_X })).toBe(true);
    expect(isTestCardKey(K1)).toBe(false);
    expect(isTestCardKey({})).toBe(false);
    // Raw secret strings (Platform's middleware) and bare x strings.
    expect(isTestCardKey(JSON.stringify({ x: spare(TEST_CARD_KEY_X) }))).toBe(
      true,
    );
    expect(isTestCardKey(spare(TEST_CARD_KEY_X, 2))).toBe(true);
    expect(isTestCardKey(JSON.stringify(K1))).toBe(false);
    expect(isTestCardKey("{bad")).toBe(false);
    expect(isTestCardKey(undefined)).toBe(false);
  });

  it("refuses the test key before any other check (salt missing or bad)", async () => {
    for (const CARD_OWNER_SALT of [undefined, "short"]) {
      const cur = withCard(
        { ...TEST_CARD_JWK, kid: "" },
        { ENVIRONMENT: "production", CARD_OWNER_SALT },
      );
      await expect(loadCardKeys(cur)).rejects.toBeInstanceOf(TestKeyError);
      const prev = withCard(undefined, {
        ENVIRONMENT: "production",
        CARD_OWNER_SALT,
        CARD_SIGNING_KEY_PREV: JSON.stringify({ x: spare(TEST_CARD_KEY_X) }),
      });
      await expect(loadCardKeys(prev)).rejects.toBeInstanceOf(TestKeyError);
    }
  });

  it("refuses the test key with ENVIRONMENT unset", async () => {
    const e = withCard(
      { ...TEST_CARD_JWK },
      { ENVIRONMENT: undefined as unknown as Env["ENVIRONMENT"] },
    );
    await expect(loadCardKeys(e)).rejects.toBeInstanceOf(TestKeyError);
  });

  it("serves the test key in dev", async () => {
    const r = await getJwks(withCard({ ...TEST_CARD_JWK }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { keys: JWK[] };
    expect(body.keys[0]?.x).toBe(TEST_CARD_KEY_X);
    expect(JSON.stringify(body)).not.toContain(TEST_CARD_JWK.d);
  });

  it("serves a real key outside dev", async () => {
    expect(
      (await getJwks(withCard(K1, { ENVIRONMENT: "production" }))).status,
    ).toBe(200);
  });
});

describe("ownerId", () => {
  it("is stable, unpadded base64url, and pairwise per aud", async () => {
    const a = await ownerId(SALT, "https://a.example");
    expect(await ownerId(SALT, "https://a.example")).toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await ownerId(SALT, "https://b.example")).not.toBe(a);
    expect(await ownerId(`${SALT.slice(1)}x`, "https://a.example")).not.toBe(a);
  });
});

describe("signJws", () => {
  const claims = { sub: "agent", aud: "https://oa.example" };

  it("verifies against the served JWKS, typ checked", async () => {
    const e = withCard(K1);
    const keys = await loadCardKeys(e);
    if (!keys) throw new Error("no keys");
    expect(keys.ownerSalt).toBe(SALT);
    const jws = await signJws(keys, CARD_TYP, claims);
    const set = createLocalJWKSet(await (await getJwks(e)).json());
    const v = await jwtVerify(jws, set, {
      typ: CARD_TYP,
      algorithms: ["EdDSA"],
    });
    expect(v.protectedHeader).toEqual({
      alg: "EdDSA",
      kid: K1.kid,
      typ: CARD_TYP,
    });
    expect(v.payload).toMatchObject(claims);
    await expect(jwtVerify(jws, set, { typ: LINK_TYP })).rejects.toThrow();
    // @ts-expect-error only the two token kinds can be minted
    await signJws(keys, "JWT", claims);
  });

  it("a card signed under PREV still verifies after a rotation", async () => {
    const before = await loadCardKeys(withCard(K0));
    if (!before) throw new Error("no keys");
    const jws = await signJws(before, CARD_TYP, claims);
    const after = withCard(K1, {
      CARD_SIGNING_KEY_PREV: JSON.stringify(pub(K0)),
    });
    const set = createLocalJWKSet(await (await getJwks(after)).json());
    const v = await jwtVerify(jws, set, { typ: CARD_TYP });
    expect(v.protectedHeader.kid).toBe(K0.kid);
  });

  it("caches the import per isolate by secret string", async () => {
    const e = withCard(K1);
    expect(await loadCardKeys(e)).toBe(await loadCardKeys({ ...e }));
    expect(await loadCardKeys(withCard(K0))).not.toBe(await loadCardKeys(e));
  });
});
