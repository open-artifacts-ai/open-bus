import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  AGENT_CARD_MIN_CLIENT,
  AgentStatusSchema,
  CARD_REFUSAL_CODES,
  CARD_TTL_SEC,
  CARD_TYP,
  type CardClaims,
  CardClaimsSchema,
  LINK_TYP,
  LinkClaimsSchema,
  NonceSchema,
  OriginSchema,
  STATUS_STATES,
  StatusLabelSchema,
} from "./card.js";
import { semverGte } from "./semver.js";

const iat = 1_800_000_000;
const card: CardClaims = {
  iss: "https://bus.example.com",
  aud: "https://oa.example.com",
  sub: "aaaaaaaaaaaaaaaa",
  owner: "A".repeat(43),
  nonce: "n".repeat(16),
  iat,
  exp: iat + 300,
  jti: "j".repeat(22),
  name: "code-96",
  role: "lane-6",
  kind: "claude-code",
  machine: "leo-mbp",
  agent_says: { status: "working", label: "on task 1" },
};

describe("agent card gate", () => {
  it("is above the published 0.53.0 and admits 0.54.0", () => {
    expect(AGENT_CARD_MIN_CLIENT).toBe("0.54.0");
    expect(semverGte("0.53.0", AGENT_CARD_MIN_CLIENT)).toBe(false);
    expect(semverGte("0.54.0", AGENT_CARD_MIN_CLIENT)).toBe(true);
  });
  it("pins the constants", () => {
    expect(STATUS_STATES).toEqual([
      "working",
      "idle",
      "blocked",
      "waiting_on_owner",
    ]);
    expect(CARD_TYP).toBe("ob-card+jwt");
    expect(LINK_TYP).toBe("ob-link+jwt");
    expect(CARD_TTL_SEC).toBe(300);
    expect(CARD_REFUSAL_CODES).toEqual([
      "not_linked",
      "bad_nonce",
      "rate_limited",
    ]);
  });
});

describe("nonce", () => {
  it("is 16..128 base64url characters", () => {
    for (const ok of ["a".repeat(16), "a".repeat(128), "aB3_-aB3_-aB3_-x"])
      expect(NonceSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["a".repeat(15), "a".repeat(129), `${"a".repeat(16)}+`])
      expect(NonceSchema.safeParse(bad).success, bad).toBe(false);
  });
});

describe("status", () => {
  it("takes a known state and a clean label of at most 64 characters", () => {
    expect(AgentStatusSchema.safeParse({ state: "blocked" }).success).toBe(
      true,
    );
    expect(
      AgentStatusSchema.safeParse({ state: "idle", label: "x".repeat(64) })
        .success,
    ).toBe(true);
    for (const bad of [
      { state: "sleeping" },
      { state: "idle", label: "x".repeat(65) },
      { state: "idle", label: "a‮b" },
      { state: "idle", label: " pad" },
      { state: "idle", label: "" },
      { state: "idle", extra: 1 },
    ])
      expect(
        AgentStatusSchema.safeParse(bad).success,
        JSON.stringify(bad),
      ).toBe(false);
    expect(StatusLabelSchema.safeParse("😀".repeat(64)).success).toBe(true);
  });
});

describe("origins", () => {
  it("is an exact https origin (http only on loopback)", () => {
    for (const ok of [
      "https://oa.example.com",
      "https://oa.example.com:8443",
      "http://localhost:5173",
    ])
      expect(OriginSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of [
      "HTTPS://oa.example.com",
      "https://oa.example.com/",
      "https://oa.example.com:443",
      "https://u@oa.example.com",
      "http://oa.example.com",
      "https://oa.example.com/x",
      "https://oa.example.com?q",
    ])
      expect(OriginSchema.safeParse(bad).success, bad).toBe(false);
  });
});

describe("card claims", () => {
  it("parses a full card and one without the optional claims", () => {
    expect(CardClaimsSchema.parse(card)).toEqual(card);
    const { role: _r, agent_says: _a, ...bare } = card;
    expect(CardClaimsSchema.safeParse(bare).success).toBe(true);
  });
  it("is strict: no email, namespace or machine id", () => {
    for (const k of ["email", "namespace", "machine_id"])
      expect(CardClaimsSchema.safeParse({ ...card, [k]: "x" }).success, k).toBe(
        false,
      );
  });
  it("agent_says requires status", () => {
    expect(
      CardClaimsSchema.safeParse({ ...card, agent_says: { label: "hi" } })
        .success,
    ).toBe(false);
  });
  it("lives exactly 300 s", () => {
    expect(
      CardClaimsSchema.safeParse({ ...card, exp: iat + 301 }).success,
    ).toBe(false);
  });
  it("link claims are strict", () => {
    const link = {
      iss: card.iss,
      aud: card.aud,
      owner: card.owner,
      state: "s".repeat(16),
      iat,
      exp: iat + 300,
      jti: card.jti,
    };
    expect(LinkClaimsSchema.parse(link)).toEqual(link);
    expect(LinkClaimsSchema.safeParse({ ...link, sub: "x" }).success).toBe(
      false,
    );
    expect(
      LinkClaimsSchema.safeParse({ ...link, state: "short" }).success,
    ).toBe(false);
  });
});

describe("the main entry never bundles the test signing key", () => {
  it("leaves mocks/card.ts out of @ob/shared", async () => {
    const r = await build({
      entryPoints: [new URL("./index.ts", import.meta.url).pathname],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      logLevel: "silent",
      external: ["zod"],
    });
    const text = r.outputFiles[0]?.text ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("TEST_CARD_JWK");
    expect(text).not.toContain("jose");
  });
});
