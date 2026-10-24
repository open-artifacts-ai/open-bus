// C19 review round 1: canonical paths, inherited entries, and doctor's safe reads.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { globalFile, readGlobalDirs } from "@ob/daemon";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/commands/doctor.ts";
import { main } from "../src/main.ts";
import { fakeCtx } from "./fake.ts";

/** A fresh ctx on the same homes and cwd as `base`. */
const again = (base: ReturnType<typeof fakeCtx>, cwd = base.cwd) =>
  Object.assign(fakeCtx(), {
    userHome: base.userHome,
    home: base.home,
    cwd,
  });

function setup() {
  const ctx = fakeCtx();
  ctx.userHome = realpathSync(ctx.userHome);
  ctx.home = join(ctx.userHome, ".openbus");
  mkdirSync(join(ctx.userHome, "code/ops/deep"), { recursive: true });
  ctx.cwd = join(ctx.userHome, "code");
  const dirs = () => readGlobalDirs(globalFile(ctx.home)).dirs;
  return { ctx, dirs, ops: join(ctx.userHome, "code/ops") };
}

describe("M3: entries cover their subdirectories", () => {
  it("add of a covered subdir says already global and adds nothing", async () => {
    const { ctx, dirs, ops } = setup();
    await main(["global", "add", "ops"], () => ctx);
    const sub = again(ctx, ops);
    expect(await main(["global", "add", "deep"], () => sub)).toBe(0);
    expect(sub.out()[2]).toBe(
      "[[success]]✓[[/success]]  ~/code/ops/deep is already global.",
    );
    expect(dirs()).toEqual([ops]);
  });

  it("rm of an inherited subdir says it was not global and keeps the parent", async () => {
    const { ctx, dirs, ops } = setup();
    await main(["global", "add", "ops"], () => ctx);
    const sub = again(ctx, ops);
    expect(await main(["global", "rm", "deep"], () => sub)).toBe(0);
    expect(sub.out()[2]).toBe(
      "[[warning]]![[/warning]]  ~/code/ops/deep was not global. Nothing changed.",
    );
    expect(dirs()).toEqual([ops]);
  });
});

describe("M1: add and rm store and match the canonical path", () => {
  it("a differently cased path is stored as the volume spells it", async () => {
    const { ctx, dirs, ops } = setup();
    if (!existsSync(join(ctx.userHome, "code/OPS"))) return; // case-sensitive volume
    expect(await main(["global", "add", "OPS"], () => ctx)).toBe(0);
    expect(dirs()).toEqual([ops]);
    const rm = again(ctx);
    await main(["global", "rm", "Ops"], () => rm);
    expect(dirs()).toEqual([]);
  });
});

describe("I2: doctor reads .openbus.json as the daemon does", () => {
  for (const [what, make] of [
    ["a FIFO", (f: string) => execFileSync("mkfifo", [f])],
    ["a /dev/zero symlink", (f: string) => symlinkSync("/dev/zero", f)],
  ] as const)
    it(`never hangs on ${what}`, async () => {
      const { ctx, ops } = setup();
      make(join(ops, ".openbus.json"));
      const d = again(ctx, ops);
      await doctor(d);
      expect(d.all().join("\n")).not.toContain("asks for global");
    }, 5000);
});

describe("M8: doctor on an unusable global.json", () => {
  it("prints a ! line for a malformed or unsafe file", async () => {
    for (const make of [
      (f: string) => writeFileSync(f, "{nope", { mode: 0o600 }),
      (f: string) => {
        writeFileSync(f, '{"dirs":[]}');
        chmodSync(f, 0o666);
      },
    ]) {
      const { ctx } = setup();
      mkdirSync(ctx.home, { recursive: true });
      make(globalFile(ctx.home));
      await doctor(ctx);
      expect(ctx.all()).toEqual(
        expect.arrayContaining([
          "[[warning]]![[/warning]]  ~/.openbus/global.json can't be used, so no directory is global.",
        ]),
      );
    }
  });

  it("says nothing when there is no global.json", async () => {
    const { ctx } = setup();
    await doctor(ctx);
    expect(ctx.all().join("\n")).not.toContain("global.json");
  });
});
