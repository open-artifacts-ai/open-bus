import { expect, it } from "vitest";
import {
  AGENT_KINDS,
  AgentKindSchema,
  displayKind,
  KIND_TOKEN_MIN_CLIENT,
  KindTokenSchema,
  PRE_TOKEN_KINDS,
} from "./kinds.js";
import { semverGte } from "./semver.js";

it("accepts exactly the three harnesses", () => {
  expect(AGENT_KINDS).toEqual(["claude-code", "opencode", "pi", "omp"]);
  for (const k of AGENT_KINDS) expect(AgentKindSchema.parse(k)).toBe(k);
  expect(AgentKindSchema.safeParse("cursor").success).toBe(false);
  expect(AgentKindSchema.safeParse("Claude").success).toBe(false);
});

it("a kind token is any lowercase slug, so a reader takes future kinds", () => {
  for (const k of [...AGENT_KINDS, "zeta", "cursor-2", "a", "a".repeat(32)])
    expect(KindTokenSchema.parse(k)).toBe(k);
  for (const k of ["", "Claude", "a b", "-x", "2x", "x_y", "a".repeat(33)])
    expect(KindTokenSchema.safeParse(k).success).toBe(false);
});

it("displays an unknown kind as other", () => {
  for (const k of AGENT_KINDS) expect(displayKind(k)).toBe(k);
  expect(displayKind("zeta")).toBe("other");
  expect(displayKind("")).toBe("other");
});

it("the kind-token threshold is above every published closed-enum daemon", () => {
  // KIND_TOKEN_MIN_CLIENT is predicted: check it against the real release tag.
  expect(semverGte("0.44.1", KIND_TOKEN_MIN_CLIENT)).toBe(false);
  expect(PRE_TOKEN_KINDS).toEqual(["claude-code", "opencode", "pi"]);
});
