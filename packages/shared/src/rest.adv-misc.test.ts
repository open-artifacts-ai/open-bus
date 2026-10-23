import { describe, expect, it } from "vitest";
import { ApiErrorSchema } from "./errors.js";
import * as rest from "./rest.js";
import { BusEventSchema, MachinesResponseSchema, MeSchema } from "./rest.js";

const ISO = "2026-10-21T15:32:52.652Z";
const machine = {
  id: "7Yb3kQmZ1xRt9PvA",
  label: "MacBook",
  createdAt: ISO,
  lastUsed: ISO,
  revokedAt: null,
};

describe("adv F2.4: misc", () => {
  // Doc comment: "at most 100"; the schema and SSE snapshots are unbounded.
  it("machines lists are capped at 100", () => {
    const many = Array(101).fill(machine);
    expect(MachinesResponseSchema.safeParse({ machines: many }).success).toBe(
      false,
    );
    expect(
      BusEventSchema.safeParse({ type: "machines", machines: many }).success,
    ).toBe(false);
  });
  // Error envelope is non-strict and details is z.unknown(): stack traces / internals pass.
  it("error envelope is strict and has no free-form details on internal", () => {
    expect(
      ApiErrorSchema.safeParse({
        error: { code: "internal", message: "x", stack: "at /srv/x.ts:1" },
      }).success,
    ).toBe(false);
    expect(
      ApiErrorSchema.safeParse({
        error: {
          code: "internal",
          message: "x",
          details: { stack: "at /srv/x.ts:1" },
        },
      }).success,
    ).toBe(false);
  });
  it("MeSchema pins a plausible email and bounded name", () => {
    expect(
      MeSchema.safeParse({ user: { id: "owner", email: "@", name: null } })
        .success,
    ).toBe(false);
    expect(
      MeSchema.safeParse({
        user: { id: "owner", email: "o@e.com", name: "‮".repeat(100_000) },
      }).success,
    ).toBe(false);
  });
  // Ruling: header is "X-OB-Request: 1"; only the name is exported, the value is not pinned.
  it("exports the CSRF header value", () => {
    expect(
      (rest as Record<string, unknown>).CSRF_VALUE ??
        (rest as Record<string, unknown>).CSRF_HEADER_VALUE,
    ).toBe("1");
  });
});

describe("F2.4 fix: caps", () => {
  it("agents capped at 1000", () => {
    const a = {
      id: "8Zc4mRnA2ySu9QwB",
      namespace: "a/b",
      name: "x",
      kind: "pi",
      machineId: machine.id,
      machineLabel: "M",
      global: false,
      state: "live",
      updatedAt: ISO,
    };
    expect(
      BusEventSchema.safeParse({ type: "agents", agents: Array(1000).fill(a) })
        .success,
    ).toBe(true);
    expect(
      BusEventSchema.safeParse({ type: "agents", agents: Array(1001).fill(a) })
        .success,
    ).toBe(false);
  });
});
