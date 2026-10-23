import { describe, expect, it } from "vitest";
import { removeMcpServer, upsertMcpServer } from "../src/index.ts";

describe("claude mcpServers", () => {
  it("adds a server without disturbing other keys", () => {
    const before = { theme: "dark", mcpServers: { other: { command: "x" } } };
    const after = upsertMcpServer(before, "openbus", {
      command: "open-bus",
      args: ["mcp", "claude"],
    });
    expect(after.theme).toBe("dark");
    expect(after.mcpServers).toEqual({
      other: { command: "x" },
      openbus: { command: "open-bus", args: ["mcp", "claude"] },
    });
    expect(before.mcpServers).toEqual({ other: { command: "x" } });
  });

  it("replaces our entry instead of duplicating it, and removes it cleanly", () => {
    const once = upsertMcpServer({}, "openbus", { command: "a" });
    const twice = upsertMcpServer(once, "openbus", { command: "b" });
    expect(twice.mcpServers).toEqual({ openbus: { command: "b" } });
    expect(removeMcpServer(twice, "openbus").mcpServers).toEqual({});
  });

  it("removing from a doc without servers adds nothing", () => {
    expect(removeMcpServer({ theme: "x" }, "openbus")).toEqual({ theme: "x" });
  });

  it("refuses a non-object mcpServers instead of clobbering it", () => {
    expect(() =>
      upsertMcpServer({ mcpServers: ["x"] }, "openbus", { command: "a" }),
    ).toThrow(/mcpServers/);
  });
});
