// The `@ob/shared/web` subpath: what the dashboard needs, without the
// WebSocket protocol. Runs against the built package (dist), like a consumer.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  "EVENTS_DO_PATH",
  "SESSION_EXP_HEADER",
];

let bundle = "";
beforeAll(async () => {
  execFileSync("pnpm", ["build"], { cwd: pkgDir, stdio: "pipe" });
  const r = await build({
    stdin: {
      contents: `import * as rest from "@ob/shared/web"; console.log(rest);`,
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

describe("@ob/shared/web", () => {
  it("is declared in package.json, with sideEffects false", () => {
    expect(pkg.exports["./web"]).toMatchObject({
      types: "./dist/web.d.ts",
      import: "./dist/web.js",
      default: "./dist/web.js",
    });
    expect(pkg.sideEffects).toBe(false);
  });

  it("exports every name the dashboard needs", async () => {
    const mod = await import(join(pkgDir, "dist/web.js"));
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
    expect(out, "msw").not.toMatch(/mswjs|msw\//);
  });

  it("resolves and typechecks like the dashboard (paths @ob/shared/* -> src/*)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-web-"));
    const src = join(pkgDir, "src");
    writeFileSync(
      join(dir, "probe.ts"),
      `import {
  ${NAMES.join(",\n  ")},
  type Agent, type BusEvent, type ErrorCode, type Machine, type Me,
} from "@ob/shared/web";
export const used = [${NAMES.join(", ")}];
export type T = [Agent, BusEvent, ErrorCode, Machine, Me];
export const path: string = R.machines;
`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: join(pkgDir, "../../tsconfig.base.json"),
        compilerOptions: {
          noEmit: true,
          skipLibCheck: true,
          lib: ["ES2022", "DOM", "DOM.Iterable"],
          types: [],
          baseUrl: dir,
          typeRoots: [],
          paths: {
            "@ob/shared": [join(src, "index.ts")],
            "@ob/shared/*": [join(src, "*")],
            zod: [join(pkgDir, "node_modules/zod")],
          },
        },
        files: [join(dir, "probe.ts")],
      }),
    );
    const tsc = join(pkgDir, "node_modules/typescript/bin/tsc");
    expect(() =>
      execFileSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.json")], {
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("leaves the main barrel's protocol exports in place", async () => {
    const main = await import(join(pkgDir, "dist/index.js"));
    expect(main).toHaveProperty("decodeClientFrame");
    expect(main).toHaveProperty("R");
  });
});
