import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// The package map pinned by 00-overview.md and the track plans. Every workspace
// package must be on it with this exact name. packages/cli is published to npm
// as `@open-bus/cli`, so it is the one name that is not @ob/<dir>. A track adding a
// package adds its row here in its own PR.
const PACKAGES: Record<string, string> = {
  "apps/server": "@ob/server",
  "apps/dashboard": "@ob/dashboard",
  "apps/landing": "@ob/landing",
  "packages/shared": "@ob/shared",
  "packages/ui": "@ob/ui",
  "packages/ipc": "@ob/ipc",
  "packages/auth-core": "@ob/auth-core",
  "packages/cli": "@open-bus/cli",
  "packages/daemon": "@ob/daemon",
  "packages/adapters/mcp-json": "@ob/adapter-mcp-json",
  "packages/adapters/claude-code": "@ob/adapter-claude-code",
  "packages/adapters/opencode": "@ob/adapter-opencode",
  "packages/adapters/pi": "@ob/adapter-pi",
  "scripts/setup": "@ob/setup",
};

// Directories the workspace globs see, whichever of them exist yet.
function workspaceDirs(): string[] {
  const dirs = new Set<string>();
  for (const rel of ["apps", "packages", "packages/adapters", "scripts"]) {
    const base = join(root, rel);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      if (
        statSync(dir).isDirectory() &&
        existsSync(join(dir, "package.json"))
      ) {
        dirs.add(`${rel}/${name}`);
      }
    }
  }
  return [...dirs];
}

describe("workspace", () => {
  it("declares exactly the pinned globs", () => {
    const ws = parse(read("pnpm-workspace.yaml"));
    expect(ws.packages).toEqual([
      "apps/*",
      "packages/*",
      "packages/adapters/*",
      "scripts/*",
    ]);
  });

  it("the root is private ESM on Node 22 with a pinned pnpm", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(pkg.engines.node).toBe(">=22");
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it.each(workspaceDirs())("%s is on the package map", (dir) => {
    expect(PACKAGES, `${dir} is not in the package map`).toHaveProperty(dir);
  });

  it.each(workspaceDirs())("%s has the pinned name and engines", (dir) => {
    const pkg = JSON.parse(read(`${dir}/package.json`));
    expect(pkg.name).toBe(PACKAGES[dir]);
    expect(pkg.engines?.node).toBe(">=22");
    expect(pkg.type).toBe("module");
  });
});
