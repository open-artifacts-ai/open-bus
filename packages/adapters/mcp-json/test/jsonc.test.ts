import { describe, expect, it } from "vitest";
import {
  parseJsonc,
  removeOpencodeMcp,
  removePlugin,
  upsertOpencodeMcp,
  upsertPlugin,
} from "../src/index.ts";

const server = { type: "local", command: ["open-bus", "mcp", "opencode"] };

// The shape of a real OpenCode 2.0.32 opencode.json: comments, trailing commas.
const CONFIG = `{
  // global config
  "$schema": "https://opencode.ai/config.json",
  /* block comment */
  "plugins": ["./server-plugin",],
  "mcp": {
    "servers": {
      // keep me
      "other": { "type": "local", "command": ["x"], },
    },
  },
}
`;

const CLI = `{
  // TUI plugins
  "plugins": [
    "./herdr", // trailing note
  ],
}
`;

describe("parseJsonc", () => {
  it("reads comments and trailing commas", () => {
    expect(parseJsonc(CONFIG, "f")).toEqual({
      $schema: "https://opencode.ai/config.json",
      plugins: ["./server-plugin"],
      mcp: { servers: { other: { type: "local", command: ["x"] } } },
    });
  });

  it("refuses text it cannot parse, or that is not an object", () => {
    expect(() => parseJsonc("{ not json", "f.json")).toThrow(/f\.json/);
    expect(() => parseJsonc("[]", "f.json")).toThrow(/f\.json/);
    expect(() => parseJsonc('{"a": 1} x', "f.json")).toThrow(/f\.json/);
  });

  it("treats empty text as an empty object", () => {
    expect(parseJsonc("", "f")).toEqual({});
  });
});

describe("opencode v2 mcp.servers (jsonc)", () => {
  it("adds under mcp.servers keeping every comment, and removal restores the text", () => {
    const added = upsertOpencodeMcp(CONFIG, "openbus", server);
    for (const c of ["// global config", "/* block comment */", "// keep me"])
      expect(added).toContain(c);
    expect(parseJsonc(added, "f").mcp).toEqual({
      servers: { other: { type: "local", command: ["x"] }, openbus: server },
    });
    expect(removeOpencodeMcp(added, "openbus")).toBe(CONFIG);
  });

  it("returns the same text when nothing changes", () => {
    const added = upsertOpencodeMcp(CONFIG, "openbus", server);
    expect(upsertOpencodeMcp(added, "openbus", server)).toBe(added);
    expect(removeOpencodeMcp(CONFIG, "openbus")).toBe(CONFIG);
    expect(removeOpencodeMcp("", "openbus")).toBe("");
  });

  it("replaces a changed entry in place", () => {
    const a = upsertOpencodeMcp(CONFIG, "openbus", server);
    const b = upsertOpencodeMcp(a, "openbus", { ...server, command: ["y"] });
    expect(parseJsonc(b, "f").mcp).toMatchObject({
      servers: { openbus: { command: ["y"] } },
    });
    expect(b).toContain("// keep me");
  });

  it("creates mcp.servers in an empty or missing file", () => {
    expect(parseJsonc(upsertOpencodeMcp("", "openbus", server), "f")).toEqual({
      mcp: { servers: { openbus: server } },
    });
    expect(
      parseJsonc(upsertOpencodeMcp("{}\n", "openbus", server), "f"),
    ).toEqual({ mcp: { servers: { openbus: server } } });
  });

  it("round-trips an empty servers object, keeping a comment inside it", () => {
    for (const text of [
      '{\n  "mcp": { "servers": {} }\n}\n',
      '{\n  "mcp": {\n    "servers": {\n      // none yet\n    }\n  }\n}\n',
      '{\r\n  "mcp": {\r\n    "servers": {}\r\n  }\r\n}\r\n',
    ]) {
      const added = upsertOpencodeMcp(text, "openbus", server);
      expect(parseJsonc(added, "f").mcp).toEqual({
        servers: { openbus: server },
      });
      if (text.includes("\r\n")) expect(added).not.toMatch(/[^\r]\n/);
      if (text.includes("// none yet")) expect(added).toContain("// none yet");
      expect(removeOpencodeMcp(added, "openbus")).toBe(text);
    }
  });

  it("drops a legacy top-level mcp.openbus entry", () => {
    const legacy = '{\n  "mcp": { "openbus": { "enabled": true } }\n}\n';
    const after = upsertOpencodeMcp(legacy, "openbus", server);
    expect(parseJsonc(after, "f").mcp).toEqual({
      servers: { openbus: server },
    });
    expect(parseJsonc(removeOpencodeMcp(after, "openbus"), "f")).toEqual({
      mcp: { servers: {} },
    });
  });

  it("refuses a non-object mcp or mcp.servers instead of clobbering it", () => {
    expect(() => upsertOpencodeMcp('{"mcp": "x"}', "openbus", server)).toThrow(
      /mcp/,
    );
    expect(() =>
      upsertOpencodeMcp('{"mcp": {"servers": []}}', "openbus", server),
    ).toThrow(/mcp\.servers/);
  });
});

describe("opencode cli.json plugins (jsonc)", () => {
  it("appends once keeping comments, and removal restores the text", () => {
    const added = upsertPlugin(CLI, "/p");
    expect(added).toContain("// TUI plugins");
    expect(added).toContain("// trailing note");
    expect(parseJsonc(added, "f").plugins).toEqual(["./herdr", "/p"]);
    expect(upsertPlugin(added, "/p")).toBe(added);
    expect(removePlugin(added, "/p")).toBe(CLI);
  });

  it("keeps object entries and matches ours by package", () => {
    const text =
      '{\n  "plugins": ["./x", { "package": "y", "options": { "a": 1 } }, { "package": "/p" }]\n}\n';
    expect(upsertPlugin(text, "/p")).toBe(text);
    expect(parseJsonc(removePlugin(text, "/p"), "f").plugins).toEqual([
      "./x",
      { package: "y", options: { a: 1 } },
    ]);
  });

  it("creates plugins when absent and leaves a doc without ours alone", () => {
    expect(parseJsonc(upsertPlugin("", "/p"), "f")).toEqual({
      plugins: ["/p"],
    });
    expect(removePlugin('{ "a": 1 }', "/p")).toBe('{ "a": 1 }');
    expect(() => upsertPlugin('{"plugins": {}}', "/p")).toThrow(/plugins/);
  });
});
