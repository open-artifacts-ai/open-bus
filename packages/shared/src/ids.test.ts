import { describe, expect, it } from "vitest";
import {
  formatUserCode,
  isDeviceSecret,
  isId,
  isMachineToken,
  isUserCode,
  newDeviceSecret,
  newId,
  newMachineToken,
  newMsgId,
  newUserCode,
  normalizeUserCode,
} from "./ids.js";

describe("ids", () => {
  it("mints 16 base58 chars and validates them", () => {
    const id = newId();
    expect(id).toHaveLength(16);
    expect(isId(id)).toBe(true);
    expect(isId("0OIl" + id.slice(4))).toBe(false);
    expect(isId(id.slice(1))).toBe(false);
  });
  it("mints ob_machine_ plus 32 base58 chars", () => {
    const t = newMachineToken();
    expect(t).toMatch(/^ob_machine_[1-9A-HJ-NP-Za-km-z]{32}$/);
    expect(isMachineToken(t)).toBe(true);
    expect(isMachineToken(t.replace("ob_machine_", "oa_pat_"))).toBe(false);
    expect(isMachineToken(t + "x")).toBe(false);
  });
  it("mints a 16-char msg id", () => {
    expect(newMsgId()).toHaveLength(16);
    expect(isId(newMsgId())).toBe(true);
  });
  it("mints a 43-char device secret", () => {
    const s = newDeviceSecret();
    expect(s).toHaveLength(43);
    expect(isDeviceSecret(s)).toBe(true);
    expect(isDeviceSecret(s.slice(1))).toBe(false);
  });
  it("mints an 8-char user code from A-Z2-9, shown XXXX-XXXX", () => {
    const raw = newUserCode();
    expect(raw).toMatch(/^[A-Z2-9]{8}$/);
    expect(formatUserCode(raw)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(isUserCode(formatUserCode(raw))).toBe(true);
  });
  it("normalizes typed user codes", () => {
    expect(normalizeUserCode(" ab2c-d3e4 ")).toBe("AB2CD3E4");
    expect(normalizeUserCode("AB2C D3E4")).toBe("AB2CD3E4");
    expect(normalizeUserCode("AB2CD3E")).toBeNull();
    expect(normalizeUserCode("AB2CD3E0")).toBeNull(); // 0 is not in the alphabet
  });
});
