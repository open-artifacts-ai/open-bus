import { describe, expect, it } from "vitest";
import { parse } from "../src/index.ts";

describe("cli", () => {
  it("defaults to install", () => {
    expect(parse([])).toMatchObject({ cmd: "install" });
  });
  it("routes the subcommands", () => {
    expect(parse(["login", "--no-open"])).toMatchObject({
      cmd: "login",
      noOpen: true,
    });
    expect(parse(["daemon", "--hub", "https://h"])).toMatchObject({
      cmd: "daemon",
      hub: "https://h",
    });
    expect(parse(["mcp", "claude"])).toMatchObject({
      cmd: "mcp",
      harness: "claude",
    });
  });
  it("rejects bad input", () => {
    expect(() => parse(["wat"])).toThrow(/unknown command/);
    expect(() => parse(["mcp", "vim"])).toThrow(/usage/);
  });
});
