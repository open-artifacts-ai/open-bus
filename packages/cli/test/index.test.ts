import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../src/index.ts";

describe("cli", () => {
  it("defaults to install", () => {
    expect(parse([])).toEqual({
      cmd: "install",
      hub: undefined,
      yes: false,
      check: false,
      noOpen: false,
      noColor: false,
    });
    expect(parse(["--hub", "https://h", "--no-open"])).toMatchObject({
      cmd: "install",
      hub: "https://h",
      noOpen: true,
    });
  });
  it("routes every command and flag", () => {
    expect(
      parse(["install", "--check", "-y", "--no-open", "--no-color"]),
    ).toEqual({
      cmd: "install",
      hub: undefined,
      yes: true,
      check: true,
      noOpen: true,
      noColor: true,
    });
    expect(parse(["login", "--no-open", "--hub", "https://h"])).toEqual({
      cmd: "login",
      hub: "https://h",
      noOpen: true,
      noColor: false,
    });
    expect(parse(["daemon", "--hub", "https://h", "--home", "/x"])).toEqual({
      cmd: "daemon",
      hub: "https://h",
      home: "/x",
      noColor: false,
    });
    for (const h of ["claude", "opencode", "pi"])
      expect(parse(["mcp", h])).toEqual({
        cmd: "mcp",
        harness: h,
        noColor: false,
      });
    for (const cmd of ["status", "logs", "doctor", "version"])
      expect(parse([cmd, "--no-color"])).toEqual({ cmd, noColor: true });
    expect(parse(["uninstall"])).toEqual({
      cmd: "uninstall",
      purge: false,
      noColor: false,
    });
    expect(parse(["uninstall", "--purge"])).toMatchObject({ purge: true });
    expect(parse(["--version"])).toEqual({ cmd: "version", noColor: false });
    expect(parse(["status", "-v"])).toMatchObject({ cmd: "version" });
  });
  it("rejects bad input", () => {
    expect(() => parse(["wat"])).toThrow(/unknown command/);
    expect(() => parse(["mcp", "vim"])).toThrow(/usage/);
    expect(() => parse(["mcp"])).toThrow(/usage/);
    expect(() => parse(["status", "--nope"])).toThrow();
  });
});

describe("the open-bus bin", () => {
  it("runs from the sources", () => {
    const home = mkdtempSync(join(tmpdir(), "ob-bin-"));
    const out = execFileSync(
      process.execPath,
      [new URL("../bin/open-bus.mjs", import.meta.url).pathname, "version"],
      {
        env: {
          ...process.env,
          HOME: home,
          OPENBUS_HOME: join(home, ".openbus"),
        },
        encoding: "utf8",
      },
    );
    expect(out).toMatch(/^open-bus \d+\.\d+\.\d+\n$/);
  }, 60_000);
});
