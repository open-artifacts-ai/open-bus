// The pinned adversarial suite (B12), for the release check. One file at a
// time, in sequence: these files drive real Durable Objects with hundreds of
// sockets and are timing-sensitive under load (machine-load rule). The PR gate
// already runs every one of them inside `pnpm test`; this is the isolated rerun.
import { spawnSync } from "node:child_process";

const FILES = [
  "hub.from_ref",
  "hub.namespace.matrix",
  "hub.expiry",
  "hub.revoke",
  "hub.b11",
  "hub.b11.adv",
  "hub.events",
];

const failed = [];
for (const name of FILES) {
  console.log(`\n=== pinned: test/${name}.test.ts ===`);
  const r = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", `test/${name}.test.ts`],
    {
      stdio: "inherit",
    },
  );
  if (r.status !== 0) failed.push(name);
}
if (failed.length > 0) {
  console.error(`\npinned suite FAILED: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`\npinned suite passed (${FILES.length} files)`);
