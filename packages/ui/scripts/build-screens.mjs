// Compiles design/screens/machines.css from scripts/screens.css with Tailwind v4.
// Run: pnpm --filter @ob/ui build:screens
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = here("../../../design/screens/machines.css");
execFileSync(
  "tailwindcss",
  ["-i", here("./screens.css"), "-o", out, "--minify"],
  { stdio: "inherit", cwd: here("..") },
);
const header = `/* Generated: do not edit. Source: packages/ui/scripts/screens.css over
   design/screens/machines.html. Rebuild: pnpm --filter @ob/ui build:screens
   (tailwindcss -i packages/ui/scripts/screens.css -o design/screens/machines.css --minify) */\n`;
writeFileSync(out, header + readFileSync(out, "utf8"));
