import { expect, it } from "vitest";
import {
  AGENT_KINDS,
  AgentKindSchema,
  displayKind,
  KindTokenSchema,
} from "./kinds.js";

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
