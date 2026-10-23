import { describe, expect, it } from "vitest";
import { ApiErrorSchema } from "./errors.js";
import { newDeviceSecret, newId } from "./ids.js";
import {
  AgentListQuerySchema,
  AgentSchema,
  CSRF_VALUE,
  DeviceCodeResponseSchema,
  DeviceTokenRequestSchema,
  MeSchema,
  R,
} from "./rest.js";

const base = {
  device_code: newDeviceSecret(),
  user_code: "AB2C-D3E4",
  expires_in: 600,
  interval: 5,
};
const p = (u: string) =>
  DeviceCodeResponseSchema.safeParse({ ...base, verification_uri: u }).success;

describe("verification_uri", () => {
  it("rejects", () => {
    for (const u of [
      "https://bus/approve/AB2C-D3E4/",
      "https://bus/approve/AB2C%2DD3E4",
      "https://bus/approve/ab2c-d3e4",
      "https://bus/approve/AB2C-D3E4?x",
      "https://bus/approve/AB2C-D3E4#x",
      "http://localhost.evil.com/approve/AB2C-D3E4",
      "http://[::1]/approve/AB2C-D3E4",
      "ftp://bus/approve/AB2C-D3E4",
      "https://bus/approve/AB2CD3E4",
      "javascript://bus/approve/AB2C-D3E4",
      "https://bus/approve/ZZZZ-ZZZZ",
    ])
      expect(p(u), u).toBe(false);
  });
  it("accepted (observations)", () => {
    const acc: Record<string, boolean> = {};
    for (const u of [
      "https://evil/approve/AB2C-D3E4",
      "https://x@y/approve/AB2C-D3E4",
      "https://bus.example.com:pw@evil.com/approve/AB2C-D3E4",
      "https://bus/x/../approve/AB2C-D3E4",
      "https://bus/x/%2e%2e/approve/AB2C-D3E4",
      "  https://bus/approve/AB2C-D3E4\u0000",
      "https://bu\ns/approve/AB2C-D3E4",
      "\u001bhttps://bus/approve/AB2C-D3E4\u0007",
      "http://0x7f000001/approve/AB2C-D3E4",
      "http://LOCALHOST/approve/AB2C-D3E4",
      `https://${"a".repeat(100000)}/approve/AB2C-D3E4`,
      "https://bus/approve/AB2C-D3E4?",
      "https://bus/approve/AB2C-D3E4#",
    ])
      acc[JSON.stringify(u).slice(0, 60)] = p(u);
    console.log(acc);
  });
  it("userinfo is rejected", () => {
    expect(p("https://bus.example.com@evil.com/approve/AB2C-D3E4")).toBe(false);
  });
  it("raw string equals its parsed href (no control chars smuggled to the terminal)", () => {
    expect(p("https://bus/approve/AB2C-D3E4\u0007")).toBe(false);
    expect(p("https://bu\ns/approve/AB2C-D3E4")).toBe(false);
  });
});

describe("device_code / builders / misc", () => {
  it("device_code", () => {
    expect(
      DeviceTokenRequestSchema.safeParse({ device_code: newDeviceSecret() })
        .success,
    ).toBe(true);
    for (const d of [
      `${newDeviceSecret()}a`,
      newDeviceSecret().slice(1),
      ` ${newDeviceSecret().slice(1)}`,
      123,
      null,
    ])
      expect(
        DeviceTokenRequestSchema.safeParse({ device_code: d }).success,
      ).toBe(false);
  });
  it("R throws", () => {
    for (const x of [
      "",
      ".",
      "..",
      "%2e",
      "a/b",
      `${newId()}x`,
      "0".repeat(16),
    ])
      expect(() => R.machine(x), x).toThrow();
    for (const x of [
      "",
      "..",
      "AB2C-D3E",
      "ab2c-d3e4",
      "AB2C D3E4",
      "IIII-OOOO",
    ])
      expect(() => R.approve(x), x).toThrow();
    expect(R.machine("7Yb3kQmZ1xRt9PvA")).toBe(
      "/api/v1/machines/7Yb3kQmZ1xRt9PvA",
    );
    expect(R.approve("AB2C-D3E4")).toBe("/approve/AB2C-D3E4");
    expect(R.approve("AB2CD3E4")).toBe("/approve/AB2CD3E4");
  });
  it("namespace exact", () => {
    for (const ns of ["github.com/a/b", "my-team", "dir-2d53a722"])
      expect(AgentListQuerySchema.parse({ namespace: ns }).namespace).toBe(ns);
    for (const ns of [" a", "A", "a b", "a:b", "x".repeat(129), ""])
      expect(
        AgentListQuerySchema.safeParse({ namespace: ns }).success,
        ns,
      ).toBe(false);
  });
  it("Me/CSRF/caps/envelope", () => {
    expect(CSRF_VALUE).toBe("1");
    expect(
      MeSchema.safeParse({
        user: { id: "owner", email: "o@e.com", name: "n".repeat(128) },
      }).success,
    ).toBe(true);
    expect(
      MeSchema.safeParse({
        user: { id: "owner", email: "o@e.com", name: "n".repeat(129) },
      }).success,
    ).toBe(false);
    for (const e of ["@", "a@", "@b", "a b@c.d", "a@b"])
      expect(
        MeSchema.safeParse({ user: { id: "owner", email: e, name: null } })
          .success,
        e,
      ).toBe(false);
    for (const d of [{}, { field: "x" }, { retryAfterSec: 3 }, undefined])
      expect(
        ApiErrorSchema.safeParse({
          error: { code: "rate_limited", message: "m", details: d },
        }).success,
      ).toBe(true);
    for (const d of [
      { retryAfterSec: -1 },
      { retryAfterSec: 1.5 },
      { field: "x".repeat(129) },
      { x: 1 },
      "s",
      null,
      [],
    ])
      expect(
        ApiErrorSchema.safeParse({
          error: { code: "rate_limited", message: "m", details: d },
        }).success,
        JSON.stringify(d),
      ).toBe(false);
    expect(
      ApiErrorSchema.safeParse({
        error: { code: "internal", message: "m" },
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

describe("F2.4 round 2", () => {
  it("uri extras", () => {
    expect(p("https://bus/x/../approve/AB2C-D3E4")).toBe(false);
    expect(p("https://bus/x/%2e%2e/approve/AB2C-D3E4")).toBe(false);
    expect(p(`https://${"a".repeat(3000)}/approve/AB2C-D3E4`)).toBe(false);
    expect(p("https://bus.example.com/approve/AB2C-D3E4")).toBe(true);
  });
  it("agent state", () => {
    const a = {
      id: "8Zc4mRnA2ySu9QwB",
      namespace: "a/b",
      name: "x",
      kind: "pi",
      machineId: "7Yb3kQmZ1xRt9PvA",
      machineLabel: "M",
      global: false,
      updatedAt: "2026-10-21T15:32:52.652Z",
    };
    expect(AgentSchema.safeParse({ ...a, state: "queued" }).success).toBe(true);
    expect(AgentSchema.safeParse({ ...a, state: "gone" }).success).toBe(false);
    expect(AgentSchema.safeParse({ ...a, live: true }).success).toBe(false);
  });
});
