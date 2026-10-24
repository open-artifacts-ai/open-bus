import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeVersion } from "@ob/adapter-opencode";
import { describe, expect, it } from "vitest";
import { makeExec } from "../src/deps.ts";
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
  it("finds the subcommand after global flags", () => {
    expect(parse(["--no-color", "status"])).toEqual({
      cmd: "status",
      noColor: true,
    });
    // Never install: a flag uninstall does not take is refused.
    expect(() => parse(["--hub", "https://h.example", "uninstall"])).toThrow(
      /--hub does not apply to open-bus uninstall/,
    );
    expect(parse(["--hub", "https://h", "login"])).toMatchObject({
      cmd: "login",
      hub: "https://h",
    });
    expect(parse(["--no-color", "mcp", "pi"])).toMatchObject({
      cmd: "mcp",
      harness: "pi",
    });
  });
  it("refuses a flag the command does not take", () => {
    expect(() => parse(["uninstall", "--purge", "--home", "/tmp/x"])).toThrow(
      /--home only applies to open-bus daemon; set OPENBUS_HOME instead/,
    );
    expect(() => parse(["status", "--purge"])).toThrow(
      /--purge does not apply to open-bus status/,
    );
    expect(() => parse(["--hub", "https://h", "doctor"])).toThrow(/--hub/);
    expect(parse(["daemon", "--home", "/x"])).toMatchObject({ home: "/x" });
  });
  it("rejects bad input", () => {
    expect(() => parse(["status", "extra"])).toThrow(
      /unexpected argument: extra/,
    );
    expect(() => parse(["mcp", "pi", "extra"])).toThrow(/unexpected argument/);
    expect(() => parse(["--no-color", "wat"])).toThrow(/unknown command: wat/);
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

describe("exec", () => {
  it("kills a hung command at its timeout, so a hung opencode reads as version unknown", async () => {
    const bin = mkdtempSync(join(tmpdir(), "ob-bin-"));
    const oc = join(bin, "opencode");
    writeFileSync(oc, "#!/bin/sh\nexec sleep 60\n");
    chmodSync(oc, 0o755);
    const exec = makeExec(300);
    const started = Date.now();
    const r = await exec(oc, ["--version"]);
    expect(r.code).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(
      await opencodeVersion((_cmd, args) => exec(oc, args)),
    ).toBeUndefined();
  }, 15_000);

  it("returns at its timeout even when a child of the command keeps stdout open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-exec-"));
    const sh = join(dir, "opencode");
    // A wrapper script (npm and asdf shims are): sleep inherits the pipe.
    writeFileSync(sh, "#!/bin/sh\nsleep 30\necho 9.9.9\n");
    chmodSync(sh, 0o755);
    const t0 = Date.now();
    const r = await makeExec(500)(sh, ["--version"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/timed out after 500 ms/);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 15_000);
});
