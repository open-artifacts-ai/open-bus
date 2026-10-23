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
