import { describe, expect, it } from "vitest";
import { isDeviceSecret } from "./ids.js";
import {
  DeviceCodeResponseSchema,
  DeviceTokenRequestSchema,
  R,
} from "./rest.js";

const ok = {
  device_code: "d".repeat(43),
  user_code: "AB2C-D3E4",
  verification_uri: "https://bus.example.com/approve/AB2C-D3E4",
  expires_in: 600,
  interval: 5,
};

describe("adv F2.4: device flow", () => {
  // Generator is 43 base58 (isDeviceSecret); the schemas accept any [A-Za-z0-9_-]{32,128}.
  it("device_code is pinned to the generator format", () => {
    for (const d of [
      "0".repeat(32),
      "_".repeat(43),
      "-".repeat(128),
      "O".repeat(43),
      "l".repeat(43),
    ]) {
      expect(isDeviceSecret(d)).toBe(false);
      expect(
        DeviceTokenRequestSchema.safeParse({ device_code: d }).success,
        d,
      ).toBe(false);
      expect(
        DeviceCodeResponseSchema.safeParse({ ...ok, device_code: d }).success,
        d,
      ).toBe(false);
    }
  });
  // CLI prints/opens verification_uri; any URL scheme and any path pass, unrelated to user_code.
  it("verification_uri is https and points at /approve/<user_code>", () => {
    for (const u of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "http://bus.example.com/approve/AB2C-D3E4",
      "https://evil.example/approve/ZZZZ-ZZZZ",
    ]) {
      expect(
        DeviceCodeResponseSchema.safeParse({ ...ok, verification_uri: u })
          .success,
        u,
      ).toBe(false);
    }
  });
  // R.machine("") is the collection route; R.approve("") is "/approve/".
  it("route builders reject empty segments", () => {
    expect(() => R.machine("")).toThrow();
    expect(() => R.approve("")).toThrow();
  });
});

describe("F2.4 fix: uri and builders", () => {
  it("allows http only for loopback (localhost, 127.0.0.1)", () => {
    expect(
      DeviceCodeResponseSchema.safeParse({
        ...ok,
        verification_uri: "http://localhost:8787/approve/AB2C-D3E4",
      }).success,
    ).toBe(true);
    expect(
      DeviceCodeResponseSchema.safeParse({
        ...ok,
        verification_uri: "http://127.0.0.1/approve/AB2C-D3E4",
      }).success,
    ).toBe(true);
    expect(
      DeviceCodeResponseSchema.safeParse({
        ...ok,
        verification_uri: "https://bus.example.com/approve/AB2C-D3E4",
      }).success,
    ).toBe(true);
  });
  it("allows http for the IPv6 loopback only", () => {
    const parse = (verification_uri: string) =>
      DeviceCodeResponseSchema.safeParse({ ...ok, verification_uri }).success;
    expect(parse("http://[::1]:8787/approve/AB2C-D3E4")).toBe(true);
    expect(parse("http://[::2]/approve/AB2C-D3E4")).toBe(false);
    expect(parse("http://[::1].evil/approve/AB2C-D3E4")).toBe(false);
  });
  it("builders validate", () => {
    expect(() => R.machine("../x")).toThrow();
    expect(() => R.approve("nope")).toThrow();
  });
});
