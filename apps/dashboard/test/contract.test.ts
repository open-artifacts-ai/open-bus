import * as shared from "@ob/shared";
import { expect, test } from "vitest";
import * as c from "../src/api/contract";
import { fixtures } from "../src/mocks/fixtures";

test("the contract is @ob/shared's, not a copy", () => {
  const pairs: [string, unknown, unknown][] = [
    ["AgentSchema", c.AgentSchema, shared.AgentSchema],
    [
      "AgentsResponseSchema",
      c.AgentsResponseSchema,
      shared.AgentsResponseSchema,
    ],
    ["MachineSchema", c.MachineSchema, shared.MachineSchema],
    [
      "MachinesResponseSchema",
      c.MachinesResponseSchema,
      shared.MachinesResponseSchema,
    ],
    ["MeSchema", c.MeSchema, shared.MeSchema],
    ["BusEventSchema", c.BusEventSchema, shared.BusEventSchema],
    ["ApiErrorSchema", c.ApiErrorSchema, shared.ApiErrorSchema],
    ["ERROR_CODES", c.ERROR_CODES, shared.ERROR_CODES],
    ["AUTH", c.AUTH, shared.AUTH],
    ["R", c.R, shared.R],
    ["WireNamespaceSchema", c.WireNamespaceSchema, shared.WireNamespaceSchema],
    ["CSRF_HEADER", c.CSRF_HEADER, shared.CSRF_HEADER],
    ["CSRF_VALUE", c.CSRF_VALUE, shared.CSRF_VALUE],
  ];
  for (const [name, mine, theirs] of pairs) expect(mine, name).toBe(theirs);
});

test("the fixtures parse through the shared schemas", () => {
  expect(
    shared.AgentsResponseSchema.parse({ agents: fixtures.agents }).agents,
  ).toEqual(fixtures.agents);
  expect(
    shared.MachinesResponseSchema.parse({ machines: fixtures.machines })
      .machines,
  ).toEqual(fixtures.machines);
  expect(shared.MeSchema.parse(fixtures.me)).toEqual(fixtures.me);
});

test("Agent.state is required and is live or queued", () => {
  const [a] = fixtures.agents;
  if (!a) throw new Error("no fixture agent");
  const { state: _, ...noState } = a;
  expect(c.AgentSchema.safeParse(noState).success).toBe(false);
  expect(c.AgentSchema.safeParse({ ...noState, live: true }).success).toBe(
    false,
  );
  for (const state of ["live", "queued"])
    expect(c.AgentSchema.safeParse({ ...a, state }).success).toBe(true);
});
