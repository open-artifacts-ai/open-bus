// Bundles the CLI and everything it imports into dist/index.js, and copies the
// adapters' assets to assets/, where `new URL("../assets/…", import.meta.url)`
// finds them from dist/ just as it does from each adapter's src/.
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const root = join(import.meta.dirname, "..");
const at = (p) => join(root, p);
const { version } = JSON.parse(readFileSync(at("package.json"), "utf8"));

rmSync(at("dist"), { recursive: true, force: true });
rmSync(at("assets"), { recursive: true, force: true });

await build({
  entryPoints: [at("src/cli.ts")],
  outfile: at("dist/index.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // ESM first: some CommonJS mains are UMD wrappers esbuild cannot follow.
  mainFields: ["module", "main"],
  // CommonJS dependencies require node built-ins.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __obCreateRequire } from "node:module";',
      "const require = __obCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  define: { __OPENBUS_VERSION__: JSON.stringify(version) },
  // ws's optional native add-ons: required in a try, absent is fine.
  external: ["bufferutil", "utf-8-validate"],
  legalComments: "none",
  logLevel: "warning",
});
// The bin runs straight from a package, not only through npm's link.
chmodSync(at("dist/index.js"), 0o755);

// The Pi extension is copied, not bundled: its IPC marker is stamped here.
const PI_MARKER = 'const CLIENT_VERSION = "0.0.0";';
const pi = readFileSync(at("../adapters/pi/assets/openbus.ts"), "utf8");
if (!pi.includes(PI_MARKER))
  throw new Error("the Pi extension has no CLIENT_VERSION to stamp");
mkdirSync(at("assets"), { recursive: true });
writeFileSync(
  at("assets/openbus.ts"),
  pi.replace(PI_MARKER, `const CLIENT_VERSION = ${JSON.stringify(version)};`),
);
cpSync(
  at("../adapters/opencode/assets/opencode-tui/tui.js"),
  at("assets/opencode-tui/tui.js"),
);
