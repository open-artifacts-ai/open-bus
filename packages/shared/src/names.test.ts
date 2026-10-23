import { describe, expect, it } from "vitest";
import { BusNameSchema, candidateName, suffixName } from "./names.js";

describe("bus names", () => {
  it("accepts human names with spaces", () => {
    for (const n of ["OpenBus Backend", "agent-2", "Pi", "a.b_c"]) {
      expect(BusNameSchema.safeParse(n).success).toBe(true);
    }
  });
  it("rejects address-shaped, control or oversized names", () => {
    for (const n of [
      "a@b.com",
      "host:1234",
      "a/b",
      "a\\b",
      "",
      " lead",
      "trail ",
      "..",
      ".",
      "x".repeat(65),
      "tab\there",
      "<script>",
    ]) {
      expect(BusNameSchema.safeParse(n).success).toBe(false);
    }
  });
  it("suffixes without exceeding 64 chars", () => {
    expect(suffixName("Artifacts Manager", 2)).toBe("Artifacts Manager-2");
    const long = "n".repeat(64);
    const out = suffixName(long, 12);
    expect(out.length).toBe(64);
    expect(out.endsWith("-12")).toBe(true);
  });
  it("turns any proposal into a usable candidate", () => {
    expect(candidateName("  My  Agent ")).toBe("My Agent");
    expect(candidateName("a@b.com")).toBe("agent");
    expect(candidateName("")).toBe("agent");
    expect(candidateName("x".repeat(80)).length).toBe(64);
  });
});

describe("bus name hardening", () => {
  it("K: rejects names ending in a dot", () => {
    for (const x of ["a.", "agent..", "lead."]) {
      expect(BusNameSchema.safeParse(x).success, x).toBe(false);
    }
    expect(candidateName("lead.")).toBe("lead");
  });
  it("L: rejects IPv4-shaped names but keeps domain-shaped ones", () => {
    for (const x of ["10.0.0.1", "127.0.0.1"]) {
      expect(BusNameSchema.safeParse(x).success, x).toBe(false);
    }
    for (const x of ["example.com", "api.openai.com"]) {
      expect(BusNameSchema.safeParse(x).success, x).toBe(true);
    }
  });
  it("M: suffixName throws on an invalid base or counter", () => {
    const bad: [string, number][] = [
      ["a@b.com", 2],
      ["-", 2],
      ["x".repeat(64), 1e21],
      ["agent", Number.NaN],
      ["agent", -1],
      ["agent", 1],
      ["agent", 2.5],
    ];
    for (const [b, k] of bad) {
      expect(() => suffixName(b, k), `${b},${k}`).toThrow();
    }
  });
  it("M: suffixName results are always valid bus names", () => {
    for (const b of ["agent", "a.b", "x".repeat(64), "a b."].filter(
      (x) => BusNameSchema.safeParse(x).success,
    )) {
      for (const k of [2, 3, 12, 999999]) {
        const out = suffixName(b, k);
        expect(BusNameSchema.safeParse(out).success, out).toBe(true);
        expect(out.length).toBeLessThanOrEqual(64);
      }
    }
  });
});
