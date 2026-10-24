import { describe, expect, it, vi } from "vitest";
import { main } from "../src/main.ts";
import { fakeCtx } from "./fake.ts";

const seen: { home?: string } = {};
// The real entry would start a stdio server: record what it would read instead.
vi.mock("@ob/adapter-claude-code/main", () => {
  seen.home = process.env.OPENBUS_HOME;
  return {};
});

describe("mcp --home", () => {
  it("points the MCP server at that home's daemon", async () => {
    const prev = process.env.OPENBUS_HOME;
    delete process.env.OPENBUS_HOME;
    try {
      await main(["mcp", "claude", "--home", "/tmp/ob-mcp-home"], () =>
        fakeCtx(),
      );
      expect(seen.home).toBe("/tmp/ob-mcp-home");
    } finally {
      if (prev === undefined) delete process.env.OPENBUS_HOME;
      else process.env.OPENBUS_HOME = prev;
    }
  });
});
