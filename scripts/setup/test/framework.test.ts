import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import type { Step } from "../src/step.ts";
import { core, FLAGS, ROOT, STATE } from "./fakes.ts";

describe("framework", () => {
  it("stops at the first action_required and records completed steps in state", async () => {
    const calls: string[] = [];
    const s = (name: string, ar?: boolean): Step => ({
      name,
      check: async () => "todo",
      apply: async () => {
        calls.push(name);
        return ar ? { status: "action_required", message: "need" } : undefined;
      },
    });
    const c = core();
    expect(await run(FLAGS, c.deps, ROOT, [s("a"), s("b", true), s("c")])).toBe(
      2,
    );
    expect(calls).toEqual(["a", "b"]);
    expect(c.state()).toMatchObject({ name: "open-bus", completed: ["a"] });
    expect(c.secretWrites).toHaveLength(1);
  });

  it("reports a done step as skipped and never applies it", async () => {
    let applied = false;
    const done: Step = {
      name: "d",
      check: async () => "done",
      apply: async () => {
        applied = true;
        return undefined;
      },
    };
    const c = core();
    expect(await run(FLAGS, c.deps, ROOT, [done])).toBe(0);
    expect(applied).toBe(false);
    expect(JSON.parse(c.lines[0])).toMatchObject({
      step: "d",
      status: "skipped",
    });
  });

  it("reads the default instance's saved state when --name is omitted", async () => {
    const c = core({
      files: {
        [STATE]: JSON.stringify({
          name: "open-bus",
          host: "bus.example.com",
          ownerEmail: "o@example.com",
        }),
      },
    });
    const s: Step = {
      name: "a",
      check: async () => "done",
      apply: async () => undefined,
    };
    expect(await run(["--json"], c.deps, ROOT, [s])).toBe(0);
  });

  it("--ci writes no state", async () => {
    const c = core();
    const s: Step = {
      name: "a",
      check: async () => "todo",
      apply: async () => undefined,
    };
    expect(await run([...FLAGS, "--ci"], c.deps, ROOT, [s])).toBe(0);
    expect(c.secretWrites).toHaveLength(0);
  });

  it("--check runs check() only, writes no state, and exits 2 on drift", async () => {
    const c = core();
    const s: Step = {
      name: "a",
      check: async () => "todo",
      apply: async () => {
        throw new Error("applied");
      },
    };
    expect(await run([...FLAGS, "--check"], c.deps, ROOT, [s])).toBe(2);
    expect(JSON.parse(c.lines[0])).toMatchObject({ step: "a", status: "todo" });
    expect(c.secretWrites).toHaveLength(0);
  });
});
