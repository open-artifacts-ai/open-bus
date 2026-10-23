// The `@ob/shared/rest` subpath: what the dashboard needs, without the
// WebSocket protocol. Runs against the built package (dist), like a consumer.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

const NAMES = [
  "R",
  "AUTH",
  "CSRF_HEADER",
  "CSRF_VALUE",
  "ERROR_CODES",
  "ApiErrorSchema",
  "MeSchema",
  "MachineSchema",
  "MachinesResponseSchema",
  "AgentSchema",
  "AgentsResponseSchema",
  "AgentListQuerySchema",
  "BusEventSchema",
  "WireNamespaceSchema",
];

let bundle = "";
beforeAll(async () => {
  execFileSync("pnpm", ["build"], { cwd: pkgDir, stdio: "pipe" });
  const r = await build({
    stdin: {
      contents: `import * as rest from "@ob/shared/rest"; console.log(rest);`,
      resolveDir: pkgDir,
      loader: "js",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    logLevel: "silent",
  });
  bundle = r.outputFiles[0]?.text ?? "";
  expect(bundle.length).toBeGreaterThan(0);
});

describe("@ob/shared/rest", () => {
  it("is declared in package.json, with sideEffects false", () => {
    expect(pkg.exports["./rest"]).toMatchObject({
      types: "./dist/rest-entry.d.ts",
      import: "./dist/rest-entry.js",
    });
    expect(pkg.sideEffects).toBe(false);
  });

  it("exports every name the dashboard needs", async () => {
    const mod = await import(join(pkgDir, "dist/rest-entry.js"));
    for (const n of NAMES) expect(mod, n).toHaveProperty(n);
  });

  it("does not bundle the WebSocket protocol or receipts", () => {
    const out = bundle;
    for (const s of [
      "decodeClientFrame",
      "decodeServerFrame",
      "roster_changed",
      "receipt_update",
      "PROTOCOL_VERSION",
      "REFUSAL_REASONS",
      "recipient_closed",
    ])
      expect(out, s).not.toContain(s);
    expect(out).toContain("/api/v1/machines"); // sanity: the REST bits are in
  });

  it("leaves the main barrel's protocol exports in place", async () => {
    const main = await import(join(pkgDir, "dist/index.js"));
    expect(main).toHaveProperty("decodeClientFrame");
    expect(main).toHaveProperty("R");
  });
});
