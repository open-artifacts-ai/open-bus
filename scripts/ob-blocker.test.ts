import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "ob-blocker.sh");

let bin: string;
let log: string;

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "ob-blocker-"));
  log = join(bin, "gh.log");
  const gh = join(bin, "gh");
  writeFileSync(gh, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$GH_LOG"\n');
  chmodSync(gh, 0o755);
});

afterAll(() => rmSync(bin, { recursive: true, force: true }));

const run = (...args: string[]) =>
  spawnSync("bash", [script, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_LOG: log },
    encoding: "utf8",
  });

describe("ob-blocker.sh", () => {
  it("refuses anything but three arguments", () => {
    const r = run("only-one");
    expect(r.status).toBe(64);
    expect(r.stderr).toContain("usage:");
  });

  it("files a blocker issue with the right repo, label and assignee", () => {
    rmSync(log, { force: true });
    const r = run(
      "OpenBus Platform",
      "Need the token",
      "F4 needs a Cloudflare API token in repo secrets.",
    );
    expect(r.status).toBe(0);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("issue create -R open-artifacts-ai/open-bus");
    expect(calls).toContain("--label blocker");
    expect(calls).toContain("--assignee leourbina");
    expect(calls).toContain("[OpenBus Platform] Need the token");
    expect(calls).toContain("**Raised by:** OpenBus Platform");
    expect(calls).toContain("Close this issue (or comment) when unblocked");
  });
});
