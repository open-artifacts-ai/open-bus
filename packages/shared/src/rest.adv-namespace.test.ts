import { describe, expect, it } from "vitest";
import { AgentListQuerySchema, AgentSchema } from "./rest.js";

const ISO = "2026-10-21T15:32:52.652Z";
const agent = {
  id: "8Zc4mRnA2ySu9QwB",
  namespace: "github.com/a/b",
  name: "x",
  kind: "pi",
  machineId: "7Yb3kQmZ1xRt9PvA",
  machineLabel: "MacBook",
  global: false,
  live: true,
  updatedAt: ISO,
};

describe("adv F2.4: namespaces in REST DTOs are not wire-canonical", () => {
  // Response DTO: the dashboard silently rewrites what the Worker sent.
  it("AgentSchema rejects non-canonical namespaces instead of transforming them", () => {
    for (const ns of [
      "git@github.com:A/B.git",
      "https://GitHub.com/A/B",
      "My Team",
    ]) {
      const r = AgentSchema.safeParse({ ...agent, namespace: ns });
      expect(r.success, ns).toBe(false);
    }
  });
  // Query param: many inputs alias one namespace (case, scheme, garbage -> dir-hash, >128 truncation).
  it("?namespace= accepts only canonical values (no aliasing)", () => {
    for (const ns of [
      "GitHub.com/A/B",
      "https://github.com/a/b.git",
      "!!!",
      "x".repeat(500),
    ]) {
      expect(
        AgentListQuerySchema.safeParse({ namespace: ns }).success,
        ns.slice(0, 20),
      ).toBe(false);
    }
  });
});

describe("F2.4 fix: exact namespaces", () => {
  it("rejects non-canonical, accepts canonical", () => {
    for (const ns of ["GitHub.com/A/B", "My Team", "x".repeat(129)])
      expect(
        AgentSchema.safeParse({ ...agent, namespace: ns }).success,
        ns.slice(0, 12),
      ).toBe(false);
    expect(AgentListQuerySchema.safeParse({}).success).toBe(true);
    expect(
      AgentListQuerySchema.safeParse({ namespace: "github.com/a/b" }).success,
    ).toBe(true);
  });
});
