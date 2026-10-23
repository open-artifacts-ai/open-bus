import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deriveKey, KEY_LABELS } from "../src/auth/keys.js";
import {
  buildAuthorizeRedirect,
  handleCallback,
  OidcRedeemError,
  OidcStateError,
  safeNext,
} from "../src/auth/oidc.js";
import {
  clearSessionCookie,
  OWNER_UID,
  readSession,
  sessionCookie,
  sessionCookieName,
  signSession,
} from "../src/auth/session.js";
import type { Env } from "../src/env.js";
import {
  b64urlDecode,
  b64urlEncode,
  hmacSign,
  hmacVerify,
} from "../src/util/crypto.js";

const e = env as unknown as Env;
const prod = { ...e, ENVIRONMENT: "production" } as Env;

describe("crypto", () => {
  it("round-trips base64url and rejects malformed input", () => {
    const bytes = new Uint8Array([0, 251, 255, 62, 63]);
    expect(b64urlDecode(b64urlEncode(bytes))).toEqual(bytes);
    expect(b64urlDecode("a+b/")).toBeNull();
  });
  it("verifies its own HMAC and nothing else", async () => {
    const sig = await hmacSign("k".repeat(32), "data");
    expect(await hmacVerify("k".repeat(32), "data", sig)).toBe(true);
    expect(await hmacVerify("k".repeat(32), "datb", sig)).toBe(false);
    expect(await hmacVerify("j".repeat(32), "data", sig)).toBe(false);
  });
});

describe("keys", () => {
  it("derives a distinct key per label", async () => {
    const ks = await Promise.all(KEY_LABELS.map((l) => deriveKey(e, l)));
    expect(new Set(ks).size).toBe(KEY_LABELS.length);
    expect(ks).not.toContain(e.SESSION_SECRET);
  });
  it("refuses a missing or short SESSION_SECRET", async () => {
    await expect(
      deriveKey({ SESSION_SECRET: "" }, "ob:session"),
    ).rejects.toThrow();
    await expect(
      deriveKey({ SESSION_SECRET: "short" }, "ob:session"),
    ).rejects.toThrow();
  });
});

describe("session", () => {
  it("round-trips the owner session", async () => {
    const c = await signSession(e);
    const s = await readSession(e, c);
    expect(s?.uid).toBe(OWNER_UID);
    expect(s?.exp).toBeGreaterThan(Date.now());
  });
  it("rejects tampering, truncation and expiry", async () => {
    const c = await signSession(e);
    expect(await readSession(e, `${c.slice(0, -2)}AA`)).toBeNull();
    expect(await readSession(e, c.split(".")[0])).toBeNull();
    expect(await readSession(e, undefined)).toBeNull();
    expect(
      await readSession(
        e,
        await signSession(e, OWNER_UID, Date.now() - 8 * 86400_000),
      ),
    ).toBeNull();
  });
  it("is not signed with the raw secret", async () => {
    const [p] = (await signSession(e)).split(".") as [string];
    const forged = `${p}.${await hmacSign(e.SESSION_SECRET, p)}`;
    expect(await readSession(e, forged)).toBeNull();
  });
  it("refuses a short SESSION_SECRET", async () => {
    await expect(
      signSession({ ...e, SESSION_SECRET: "short" } as Env),
    ).rejects.toThrow();
  });
  it("uses the __Host- name outside dev", () => {
    expect(sessionCookieName({ ENVIRONMENT: "production" })).toBe(
      "__Host-ob_session",
    );
    expect(sessionCookieName({ ENVIRONMENT: "dev" })).toBe("ob_session");
    expect(sessionCookie("v", prod)).toContain("Secure");
    expect(clearSessionCookie(prod)).toMatch(
      /^__Host-ob_session=; .*Max-Age=0$/,
    );
  });
});

describe("oidc", () => {
  it("builds a PKCE authorize redirect with a per-attempt state cookie", async () => {
    const r = await buildAuthorizeRedirect(e, "/machines", {
      cookieHeader: null,
    });
    const u = new URL(r.location);
    expect(u.origin).toBe(`https://${e.ACCESS_TEAM_DOMAIN}`);
    expect(u.searchParams.get("client_id")).toBe(e.ACCESS_CLIENT_ID);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("nonce")).toBeTruthy();
    expect(r.stateCookie).toMatch(/^ob_oidc_[A-Za-z0-9_-]{10}=/);
    const p = await buildAuthorizeRedirect(prod, "/", { cookieHeader: null });
    expect(p.stateCookie).toMatch(/^__Host-ob_oidc_[A-Za-z0-9_-]{10}=.*Secure/);
  });

  it("evicts the oldest attempts beyond three", async () => {
    const a = await buildAuthorizeRedirect(e, "/", {});
    const b = await buildAuthorizeRedirect(e, "/", {});
    const c = await buildAuthorizeRedirect(e, "/", {});
    const jar = [a, b, c].map((x) => x.stateCookie.split(";")[0]).join("; ");
    const r = await buildAuthorizeRedirect(e, "/", { cookieHeader: jar });
    expect(r.evict).toHaveLength(1);
    expect(r.evict[0]).toContain("Max-Age=0");
  });

  const callback = (qs: string, cookie?: string) =>
    new Request(`https://app.localhost/auth/callback?${qs}`, {
      headers: cookie ? { cookie } : {},
    });

  it("rejects a callback without this attempt's state cookie", async () => {
    await expect(
      handleCallback(e, callback("state=x&code=y")),
    ).rejects.toBeInstanceOf(OidcStateError);
  });

  it("rejects a forged state cookie", async () => {
    const r = await buildAuthorizeRedirect(e, "/", {});
    const state = new URL(r.location).searchParams.get("state") as string;
    const [name] = (r.stateCookie.split(";")[0] as string).split("=");
    await expect(
      handleCallback(e, callback(`state=${state}&code=y`, `${name}=a.b`)),
    ).rejects.toMatchObject({ stage: "state_bad_sig" });
  });

  it("carries next through a valid state into an IdP error", async () => {
    const r = await buildAuthorizeRedirect(e, "/machines", {});
    const state = new URL(r.location).searchParams.get("state") as string;
    const jar = r.stateCookie.split(";")[0] as string;
    const err = await handleCallback(
      e,
      callback(`state=${encodeURIComponent(state)}&error=access_denied`, jar),
    ).catch((x) => x);
    expect(err).toBeInstanceOf(OidcRedeemError);
    expect(err).toMatchObject({ next: "/machines", stage: "idp_error" });
  });
});

describe("safeNext", () => {
  const ok = (v: string) => expect(safeNext(e, v)).toBe(v);
  const no = (v: unknown) => expect(safeNext(e, v as string)).toBe("/");

  it("keeps same-origin paths", () => {
    ok("/machines");
    ok("/machines?tab=agents#top");
    ok("/a%20b");
  });
  it("falls back for missing, empty and oversized values", () => {
    no(undefined);
    no(null);
    no("");
    no(`/${"a".repeat(3000)}`);
  });
  it("rejects schemes and hosts", () => {
    no("https://evil");
    no("https://evil.com/x");
    no("javascript:alert(1)");
    no("evil.com");
    no("//evil");
    no("//evil.com");
    no("///evil");
  });
  it("rejects backslashes, raw and encoded", () => {
    no("/\\evil");
    no("\\\\evil");
    no("/%5Cevil");
    no("/%5cevil");
    no("/a\\b");
  });
  it("rejects encoded slashes that decode to //", () => {
    no("/%2F%2Fevil");
    no("/%2f%2fevil");
    no("%2F%2Fevil");
    no("/%2Fevil");
  });
  it("rejects double-encoded values", () => {
    no("/%252F%252Fevil");
    no("/%255Cevil");
    no("%252F%252Fevil");
  });
  it("rejects tabs, newlines and other control characters", () => {
    no("/\t/evil");
    no("/\n/evil");
    no("/\r/evil");
    no("/%09/evil");
    no("/%0A/evil");
    no("/%0d/evil");
    no("/%00");
    no("/%2509/evil");
  });
  it("rejects dot segments that resolve to //host", () => {
    no("/..//evil");
    no("/%2e%2e//evil");
  });
  it("rejects malformed percent-encoding", () => {
    no("/%E0%A4%A");
    no("/100%");
  });
});
