// C19 review round 1: the allowlist and `.openbus.json` are read safely, and
// paths compare in one canonical form.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalPath,
  globalFile,
  readGlobalDirs,
  writeGlobalDirs,
} from "../src/global.ts";
import { nearestConfig, resolveNamespace } from "../src/namespace.ts";
import { readOwnFile } from "../src/own-file.ts";

const tmp = (p = "ob-glr-") => realpathSync(mkdtempSync(join(tmpdir(), p)));
const noGit = { gitRemote: () => null, gitRoot: () => null };

describe("I1: global.json is read safely", () => {
  const planted = (make: (file: string) => void) => {
    const h = tmp("ob-glh-");
    make(globalFile(h));
    return h;
  };

  it("a symlink, a 0666 file or a FIFO grants nothing, and nothing hangs", () => {
    const dir = tmp();
    const theirs = join(tmp(), "theirs.json");
    writeFileSync(theirs, JSON.stringify({ dirs: ["/"] }), { mode: 0o600 });
    const homes = [
      planted((f) => symlinkSync(theirs, f)),
      planted((f) => {
        writeFileSync(f, JSON.stringify({ dirs: ["/"] }));
        chmodSync(f, 0o666);
      }),
      planted((f) => execFileSync("mkfifo", [f])),
    ];
    for (const h of homes) {
      const r = readGlobalDirs(globalFile(h));
      expect(r.dirs).toEqual([]);
      expect(r.error).toBeDefined();
      const log = vi.fn();
      const deps = { ...noGit, log, globalFile: globalFile(h) };
      expect(resolveNamespace(dir, deps).global).toBe(false);
      resolveNamespace(dir, deps);
      expect(log).toHaveBeenCalledOnce();
    }
  });
});

describe("readOwnFile's reasons", () => {
  it("names each cause in Design's words", () => {
    const d = tmp();
    const f = join(d, "f.json");
    writeFileSync(f, "{}", { mode: 0o600 });
    expect(readOwnFile(f, (process.getuid?.() ?? 0) + 1)).toEqual({
      state: "unsafe",
      why: "belongs to another user",
    });
    chmodSync(f, 0o666);
    expect(readOwnFile(f)).toEqual({
      state: "unsafe",
      why: "is writable by others",
    });
    symlinkSync(f, join(d, "l.json"));
    expect(readOwnFile(join(d, "l.json"))).toEqual({
      state: "unsafe",
      why: "is a symlink",
    });
    writeFileSync(join(d, "bad.json"), "{nope", { mode: 0o600 });
    expect(readGlobalDirs(join(d, "bad.json")).error).toBe("is not valid JSON");
  });
});

describe("I2: one safe reader for .openbus.json", () => {
  it("nearestConfig skips a FIFO or a /dev/zero symlink without hanging", () => {
    for (const make of [
      (f: string) => execFileSync("mkfifo", [f]),
      (f: string) => symlinkSync("/dev/zero", f),
    ]) {
      const root = tmp();
      writeFileSync(
        join(root, ".openbus.json"),
        JSON.stringify({ global: true }),
      );
      mkdirSync(join(root, "repo"));
      make(join(root, "repo", ".openbus.json"));
      expect(nearestConfig(join(root, "repo"))).toEqual({ global: true });
    }
  });
});

describe("M1: one canonical form", () => {
  it("an entry added with another case still covers the directory (case-insensitive volumes)", () => {
    const root = tmp();
    mkdirSync(join(root, "Ops"));
    if (!existsSync(join(root, "ops"))) return; // case-sensitive volume
    const h = tmp("ob-glh-");
    writeGlobalDirs([canonicalPath(join(root, "ops"))], h);
    const deps = { ...noGit, globalFile: globalFile(h) };
    expect(resolveNamespace(join(root, "Ops"), deps).global).toBe(true);
    expect(resolveNamespace(join(root, "ops"), deps).global).toBe(true);
  });

  it("an entry and a cwd in different Unicode forms match", () => {
    const root = tmp();
    const nfd = "café";
    mkdirSync(join(root, nfd));
    if (!existsSync(join(root, nfd.normalize("NFC")))) return; // normalization-sensitive volume
    const h = tmp("ob-glh-");
    writeGlobalDirs([canonicalPath(join(root, nfd.normalize("NFC")))], h);
    const deps = { ...noGit, globalFile: globalFile(h) };
    expect(resolveNamespace(join(root, nfd), deps).global).toBe(true);
  });
});

describe("M2: a missing cwd", () => {
  it("is never global, even under an entry", () => {
    const root = tmp();
    mkdirSync(join(root, "gone"));
    const h = tmp("ob-glh-");
    writeGlobalDirs([root], h);
    rmSync(join(root, "gone"), { recursive: true });
    const deps = { ...noGit, allowMissing: true, globalFile: globalFile(h) };
    expect(resolveNamespace(join(root, "gone", "x"), deps).global).toBe(false);
  });
});

describe("M5: the ignored-global log", () => {
  it("is not logged for an allowlisted directory", () => {
    const root = tmp();
    writeFileSync(
      join(root, ".openbus.json"),
      JSON.stringify({ namespace: "ops", global: true }),
    );
    const h = tmp("ob-glh-");
    writeGlobalDirs([root], h);
    const log = vi.fn();
    expect(
      resolveNamespace(root, { ...noGit, log, globalFile: globalFile(h) })
        .global,
    ).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });
});
