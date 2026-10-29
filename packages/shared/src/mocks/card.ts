import { importJWK, SignJWT } from "jose";
import {
  CARD_TYP,
  type CardClaims,
  LINK_TYP,
  type LinkClaims,
} from "../card.js";

/**
 * A fixed, TEST-ONLY Ed25519 signing key (a private OKP JWK, Platform's
 * `CARD_SIGNING_KEY` shape). Never accepted outside tests: the bus refuses to
 * sign when `CARD_SIGNING_KEY.x === TEST_CARD_KEY_X` outside ENVIRONMENT=dev.
 * Exported only from `@ob/shared/mocks`, never from the main entry.
 */
export const TEST_CARD_JWK = {
  kty: "OKP",
  crv: "Ed25519",
  x: "S42KhnUIbfw2tK7UtvGNsrm9XBsDDXcAhVwo201LUGA",
  d: "E2jWHNNNHFFsERqfVLi6S33Ey6KjXl3jH3RLUtZ5kz0",
  kid: "ob-test-card-1",
  alg: "EdDSA",
} as const;
/** The public half's `x`. */
export const TEST_CARD_KEY_X = TEST_CARD_JWK.x;

const sign = async (
  claims: Record<string, unknown>,
  typ: string,
): Promise<string> =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: TEST_CARD_JWK.kid, typ })
    .sign(await importJWK({ ...TEST_CARD_JWK }, "EdDSA"));

/** A compact JWS card (`typ: ob-card+jwt`). Claims are signed as given, unvalidated, so tests can sign bad ones. */
export const signTestCard = (claims: CardClaims): Promise<string> =>
  sign(claims, CARD_TYP);

/** A compact JWS link assertion (`typ: ob-link+jwt`). Claims are signed as given. */
export const signTestLink = (claims: LinkClaims): Promise<string> =>
  sign(claims, LINK_TYP);
