import { expect, it } from "vitest";
import { AGENT_KINDS, AgentKindSchema } from "./kinds.js";

it("accepts exactly the three harnesses", () => {
  expect(AGENT_KINDS).toEqual(["claude-code", "opencode", "pi"]);
  for (const k of AGENT_KINDS) expect(AgentKindSchema.parse(k)).toBe(k);
  expect(AgentKindSchema.safeParse("cursor").success).toBe(false);
  expect(AgentKindSchema.safeParse("Claude").success).toBe(false);
});
