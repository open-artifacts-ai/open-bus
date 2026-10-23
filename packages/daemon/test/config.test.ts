import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "../src/config.ts";

const prev = process.env.OPENBUS_HOME;
afterEach(() => {
  if (prev === undefined) delete process.env.OPENBUS_HOME;
  else process.env.OPENBUS_HOME = prev;
});

describe("readConfig", () => {
  it("fails with 'not logged in' when machine.json is missing the token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-cfg-"));
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, "machine.json"),
      JSON.stringify({ hub: "wss://h" }),
    );
    chmodSync(join(dir, "machine.json"), 0o600);
    process.env.OPENBUS_HOME = dir;
    expect(() => readConfig()).toThrow(/not logged in/);
  });
});
