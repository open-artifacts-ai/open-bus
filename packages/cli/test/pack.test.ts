import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installCli } from "../src/steps/service.ts";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), "ob-pack-"));
const home = join(work, "home");
const obHome = join(home, ".openbus");
// Nothing reaches the real home, npm cache or harnesses; no network.
const env = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: home,
  OPENBUS_HOME: obHome,
  npm_config_cache: join(work, "npm-cache"),
  npm_config_offline: "true",
  npm_config_update_notifier: "false",
  NO_COLOR: "1",
};
const run = (args: string[], opts: { cwd?: string } = {}) =>
  execFileSync(args[0] as string, args.slice(1), {
    env,
    encoding: "utf8",
    stdio: "pipe",
    ...opts,
  });

let tarball = "";
let files: string[] = [];
let entry = "";
const children: ChildProcess[] = [];

beforeAll(() => {
  mkdirSync(home, { recursive: true });
  // prepack bundles first.
  run(["npm", "pack", "--pack-destination", work], { cwd: root });
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  tarball = join(work, tgz as string);
  files = run(["tar", "-tzf", tarball]).trim().split("\n");
  const out = join(work, "x");
  mkdirSync(out);
  run(["tar", "-xzf", tarball, "-C", out]);
  entry = join(out, "package/dist/index.js");
}, 180_000);

afterAll(() => {
  for (const c of children) if (c.pid && c.exitCode === null) c.kill();
});

describe("the published open-bus package", () => {
  it("ships dist and assets only", () => {
    expect(files.sort()).toEqual([
      "package/assets/openbus.ts",
      "package/assets/opencode-tui/tui.js",
      "package/dist/index.js",
      "package/package.json",
    ]);
  });

  it("has the fields the publish needs and no runtime dependencies", () => {
    const shipped = JSON.parse(
      readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8"),
    );
    expect(shipped.name).toBe("open-bus");
    expect(shipped.private).toBeUndefined();
    expect(shipped.bin).toEqual({ "open-bus": "dist/index.js" });
    expect(shipped.files).toEqual(["dist", "assets"]);
    expect(shipped.engines.node).toBe(">=22");
    expect(shipped.repository).toEqual({
      type: "git",
      url: "https://github.com/open-artifacts-ai/open-bus",
      directory: "packages/cli",
    });
    expect(shipped.scripts.build).toBeTruthy();
    expect(shipped.dependencies ?? {}).toEqual({});
  });

  it("is one self-contained ESM file", () => {
    const dist = readFileSync(entry, "utf8");
    expect(dist.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(dist.length).toBeLessThan(2 * 1024 * 1024);
    // Real imports only: not in comments, nor in strings of generated code
    // (ajv's `'require("ajv/dist/runtime/uri")'`).
    const specifiers = dist
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .flatMap((line) => [
        ...line.matchAll(
          /(?<!['"`])\b(?:require|import)\s*\(\s*["']([^"']+)["']|^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/g,
        ),
      ])
      .map((m) => (m[1] ?? m[2] ?? m[3]) as string);
    expect(specifiers).toContain("node:module");
    const builtins = new Set(builtinModules);
    const foreign = specifiers.filter(
      (s) =>
        !s.startsWith("node:") &&
        !builtins.has(s) &&
        // ws's optional native add-ons, each required in a try.
        s !== "bufferutil" &&
        s !== "utf-8-validate",
    );
    expect(foreign).toEqual([]);
    expect(dist).not.toMatch(/["']@ob\//);
  });

  it("prints its version from the tarball", () => {
    expect(run([process.execPath, entry, "version"])).toBe(
      `open-bus ${pkg.version}\n`,
    );
  });

  it("runs through npm exec from the tarball, offline", () => {
    const cwd = join(work, "exec");
    mkdirSync(cwd);
    expect(
      run(
        [
          "npm",
          "exec",
          "--yes",
          `--package=${tarball}`,
          "--",
          "open-bus",
          "version",
        ],
        {
          cwd,
        },
      ),
    ).toBe(`open-bus ${pkg.version}\n`);
  }, 60_000);

  it("mcp pi explains the extension", () => {
    let out = "";
    let status = 0;
    try {
      run([process.execPath, entry, "mcp", "pi"]);
    } catch (e) {
      const err = e as { stdout: string; status: number };
      out = err.stdout;
      status = err.status;
    }
    expect(status).toBe(1);
    expect(out).toMatch(/Pi uses the OpenBus extension/);
  });

  it("mcp claude answers an MCP initialize over stdio", async () => {
    const child = spawn(process.execPath, [entry, "mcp", "claude"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    const reply = new Promise<string>((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (d) => {
        buf += d;
        if (buf.includes("\n")) resolve(buf);
      });
      child.on("exit", (code) => reject(new Error(`exited ${code}`)));
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "pack-test", version: "0" },
        },
      })}\n`,
    );
    const msg = JSON.parse((await reply).split("\n")[0] as string);
    expect(msg.id).toBe(1);
    expect(msg.result.serverInfo.name).toBe("openbus");
    expect(msg.result.capabilities.tools).toBeDefined();
    child.kill();
  }, 30_000);

  it("doctor runs its checks in a fresh home", () => {
    const r = spawnSync(process.execPath, [entry, "doctor"], {
      env,
      encoding: "utf8",
    });
    // A fresh home fails checks; a crash would end without the summary.
    expect(r.stdout).toMatch(/passed\.\n$/);
    expect(r.stderr).not.toMatch(/doctor to see why/);
  });

  it("install's stable copy carries the bundle and its assets", () => {
    const copyHome = join(work, "stable");
    const copied = installCli(copyHome, { kind: "bundle", file: entry });
    expect(copied).toBe(join(copyHome, "bin/dist/index.js"));
    expect(existsSync(join(copyHome, "bin/assets/openbus.ts"))).toBe(true);
    expect(existsSync(join(copyHome, "bin/assets/opencode-tui/tui.js"))).toBe(
      true,
    );
    expect(run([process.execPath, copied, "version"])).toBe(
      `open-bus ${pkg.version}\n`,
    );
  });
});
