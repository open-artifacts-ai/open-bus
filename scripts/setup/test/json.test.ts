import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import type { Step } from "../src/step.ts";
import { NeedInput } from "../src/step.ts";
import { core, FLAGS, ROOT } from "./fakes.ts";

const step = (name: string, apply: Step["apply"]): Step => ({
  name,
  check: async () => "todo",
  apply,
});
const ok = step("a", async () => undefined);
const parsed = (lines: string[]) =>
  lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe("output", () => {
  it("prints one JSON object per line with step, status, message", async () => {
    const c = core();
    expect(
      await run(FLAGS, c.deps, ROOT, [ok, step("b", async () => undefined)]),
    ).toBe(0);
    expect(parsed(c.lines)).toEqual([
      { step: "a", status: "ok", message: "done" },
      { step: "b", status: "ok", message: "done" },
    ]);
  });

  it("exits 0 / 2 / 1 for ok / action_required / error", async () => {
    expect(await run(FLAGS, core().deps, ROOT, [ok])).toBe(0);
    const ar = step("a", async () => ({
      status: "action_required",
      message: "do x",
    }));
    expect(await run(FLAGS, core().deps, ROOT, [ar])).toBe(2);
    const need = step("a", async () => {
      throw new NeedInput("pass --x");
    });
    expect(await run(FLAGS, core().deps, ROOT, [need])).toBe(2);
    const err = step("a", async () => {
      throw new Error("boom");
    });
    const c = core();
    expect(await run(FLAGS, c.deps, ROOT, [err])).toBe(1);
    expect(parsed(c.lines).at(-1)).toMatchObject({
      status: "error",
      message: "boom",
    });
  });

  it("scrubs every secret env value and ob_machine_ token", async () => {
    const machine = `ob_machine_${"A1b2C3d4".repeat(4)}`;
    const leak = step("a", async () => {
      throw new Error(`api said tok-12345678 and ${machine} and acc-87654321`);
    });
    const c = core({
      env: {
        CLOUDFLARE_API_TOKEN: "tok-12345678",
        OB_ACCESS_TOKEN: "acc-87654321",
      },
    });
    await run(FLAGS, c.deps, ROOT, [leak]);
    const out = c.lines.join("\n");
    expect(out).not.toContain("tok-12345678");
    expect(out).not.toContain("acc-87654321");
    expect(out).not.toContain(machine);
    expect(out).toContain("api said *** and *** and ***");
  });

  it("reports a missing --host or --owner-email as an error before any step", async () => {
    let ran = false;
    const spy = step("a", async () => {
      ran = true;
      return undefined;
    });
    const c = core();
    expect(
      await run(["--json", "--owner-email", "o@example.com"], c.deps, ROOT, [
        spy,
      ]),
    ).toBe(1);
    expect(parsed(c.lines)).toEqual([
      { step: "args", status: "error", message: "missing --host" },
    ]);
    expect(ran).toBe(false);
  });
});
