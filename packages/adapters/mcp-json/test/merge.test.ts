import { describe, expect, it } from "vitest";
import {
  removeMcpServer,
  removeOpencodeMcp,
  removePlugin,
  upsertMcpServer,
  upsertOpencodeMcp,
  upsertPlugin,
} from "../src/index.ts";

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

describe("opencode v2 mcp.servers", () => {
  const server = { type: "local", command: ["open-bus", "mcp", "opencode"] };

  it("adds under mcp.servers, keeping other servers and mcp keys", () => {
    const before = {
      $schema: "https://opencode.ai/config.json",
      mcp: { timeout: { startup: 5 }, servers: { other: { type: "remote" } } },
    };
    const after = upsertOpencodeMcp(before, "openbus", server);
    expect(after).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        timeout: { startup: 5 },
        servers: { other: { type: "remote" }, openbus: server },
      },
    });
  });

  it("drops a legacy top-level mcp.openbus entry and removes cleanly", () => {
    const legacy = { mcp: { openbus: { type: "local", enabled: true } } };
    const after = upsertOpencodeMcp(legacy, "openbus", server);
    expect(after.mcp).toEqual({ servers: { openbus: server } });
    expect(removeOpencodeMcp(after, "openbus")).toEqual({
      mcp: { servers: {} },
    });
    expect(removeOpencodeMcp({ a: 1 }, "openbus")).toEqual({ a: 1 });
  });
});

describe("opencode plugins", () => {
  it("adds a plugin path once", () => {
    const a = upsertPlugin(
      { plugins: [] },
      "/h/.openbus/integrations/opencode/openbus",
    );
    const b = upsertPlugin(a, "/h/.openbus/integrations/opencode/openbus");
    expect(b.plugins).toEqual(["/h/.openbus/integrations/opencode/openbus"]);
  });

  it("keeps object entries and matches ours by package", () => {
    const doc = {
      scroll: { acceleration: false },
      plugins: ["./x", { package: "y", options: { a: 1 } }, { package: "/p" }],
    };
    const added = upsertPlugin(doc, "/p");
    expect(added.plugins).toEqual(doc.plugins);
    const removed = removePlugin(upsertPlugin(doc, "/q"), "/q");
    expect(removed).toEqual(doc);
    expect(removePlugin(doc, "/p").plugins).toEqual([
      "./x",
      { package: "y", options: { a: 1 } },
    ]);
  });

  it("removing from a doc without plugins adds nothing", () => {
    expect(removePlugin({ a: 1 }, "/p")).toEqual({ a: 1 });
  });
});
