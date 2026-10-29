import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import {
  CARD_TYP,
  type CardClaims,
  CardClaimsSchema,
  LINK_TYP,
  type LinkClaims,
  LinkClaimsSchema,
} from "../card.js";
import {
  signTestCard,
  signTestLink,
  TEST_CARD_JWK,
  TEST_CARD_KEY_X,
} from "./index.js";

const iat = Math.floor(Date.now() / 1000);
const base = {
  iss: "https://bus.example.com",
  aud: "https://oa.example.com",
  owner: "A".repeat(43),
  iat,
  exp: iat + 300,
  jti: "j".repeat(22),
};
const card: CardClaims = {
  ...base,
  sub: "aaaaaaaaaaaaaaaa",
  nonce: "n".repeat(16),
  name: "code-96",
  kind: "claude-code",
  machine: "leo-mbp",
};
const link: LinkClaims = { ...base, state: "s".repeat(16) };

const publicKey = () =>
  importJWK(
    { kty: "OKP", crv: "Ed25519", x: TEST_CARD_KEY_X, alg: "EdDSA" },
    "EdDSA",
  );

describe("test card key", () => {
  it("is a private OKP Ed25519 JWK with kid and alg", () => {
    expect(TEST_CARD_JWK).toMatchObject({
      kty: "OKP",
      crv: "Ed25519",
      alg: "EdDSA",
      x: TEST_CARD_KEY_X,
    });
    expect(TEST_CARD_JWK.d).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(TEST_CARD_JWK.kid.length).toBeGreaterThan(0);
  });

  it("signs a card that verifies against the public half", async () => {
    const jwt = await signTestCard(card);
    const h = decodeProtectedHeader(jwt);
    expect(h).toMatchObject({
      alg: "EdDSA",
      typ: CARD_TYP,
      kid: TEST_CARD_JWK.kid,
    });
    const { payload } = await jwtVerify(jwt, await publicKey(), {
      algorithms: ["EdDSA"],
      typ: CARD_TYP,
      audience: card.aud,
      issuer: card.iss,
    });
    expect(CardClaimsSchema.parse(payload)).toEqual(card);
  });

  it("signs a link assertion with its own typ", async () => {
    const jwt = await signTestLink(link);
    expect(decodeProtectedHeader(jwt)).toMatchObject({
      alg: "EdDSA",
      typ: LINK_TYP,
      kid: TEST_CARD_JWK.kid,
    });
    const { payload } = await jwtVerify(jwt, await publicKey(), {
      algorithms: ["EdDSA"],
      typ: LINK_TYP,
    });
    expect(LinkClaimsSchema.parse(payload)).toEqual(link);
    // A link assertion never passes as a card.
    await expect(
      jwtVerify(jwt, await publicKey(), { typ: CARD_TYP }),
    ).rejects.toThrow();
  });
});
