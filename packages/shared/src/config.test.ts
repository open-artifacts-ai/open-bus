import { describe, expect, it } from "vitest";
import { CONFIG_FILE, mergeConfigs, OpenBusConfigSchema } from "./config.js";

describe(".openbus.json", () => {
  it("is named exactly that", () => expect(CONFIG_FILE).toBe(".openbus.json"));
  it("accepts both keys and neither", () => {
    expect(OpenBusConfigSchema.parse({})).toEqual({});
    expect(
      OpenBusConfigSchema.parse({ namespace: "github.com/a/b", global: true }),
    ).toEqual({ namespace: "github.com/a/b", global: true });
  });
  it("rejects unknown keys and bad values", () => {
    expect(OpenBusConfigSchema.safeParse({ global: "yes" }).success).toBe(
      false,
    );
    expect(OpenBusConfigSchema.safeParse({ namespace: "" }).success).toBe(
      false,
    );
    expect(OpenBusConfigSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("mergeConfigs (nearest first)", () => {
  it("combines keys from near and far files", () => {
    expect(mergeConfigs([{ namespace: "near" }, { global: true }])).toEqual({
      namespace: "near",
      global: true,
    });
  });
  it("the nearer file wins per key", () => {
    expect(
      mergeConfigs([
        { namespace: "near", global: false },
        { namespace: "far", global: true },
      ]),
    ).toEqual({ namespace: "near", global: false });
  });
  it("is empty for no configs", () => expect(mergeConfigs([])).toEqual({}));
});
