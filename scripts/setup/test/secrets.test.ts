import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import type { Step } from "../src/step.ts";
import { secrets } from "../src/steps/secrets.ts";
import { FLAGS, ROOT } from "./fakes.ts";
import { SEEDED, world } from "./world.ts";

const ACS = "access-client-secret-0123456789";
/** Stands in for the access step: the client secret in memory. */
const seed: Step = {
  name: "seed",
  check: async () => "todo",
  apply: async (_s, ctx) => {
    ctx.secrets = { ...ctx.secrets, ACCESS_CLIENT_SECRET: ACS };
    return undefined;
  },
};

describe("secrets", () => {
  it("sets ACCESS_CLIENT_SECRET and a 48-char SESSION_SECRET via wrangler secret bulk on stdin", async () => {
    const c = world({ secrets: "missing", state: SEEDED });
    expect(await run(FLAGS, c.deps, ROOT, [seed, secrets])).toBe(0);
    const bulk = c.wrangler("secret").filter((x) => x.args[2] === "bulk");
    expect(bulk).toHaveLength(1);
    expect(bulk[0].args).toEqual([
      "wrangler",
      ...["secret", "bulk", "--name", "open-bus"],
    ]);
    const payload = JSON.parse(bulk[0].input ?? "{}");
    expect(payload.ACCESS_CLIENT_SECRET).toBe(ACS);
    expect(payload.SESSION_SECRET).toMatch(/^[A-Za-z0-9_-]{48}$/);
    for (const x of c.calls) {
      expect(x.args.join(" ")).not.toContain(ACS);
      expect(x.args.join(" ")).not.toContain(payload.SESSION_SECRET);
    }
    const out = c.out();
    expect(out).not.toContain(ACS);
    expect(out).not.toContain(payload.SESSION_SECRET);
    expect(
      c.files.get(`${c.deps.env.HOME}/.openbus/setup-open-bus.json`),
    ).not.toContain(payload.SESSION_SECRET);
  });

  it("never rotates an existing SESSION_SECRET", async () => {
    const c = world({ secrets: ["SESSION_SECRET"], state: SEEDED });
    expect(await run(FLAGS, c.deps, ROOT, [seed, secrets])).toBe(0);
    const bulk = c.wrangler("secret").filter((x) => x.args[2] === "bulk");
    expect(Object.keys(JSON.parse(bulk[0].input ?? "{}"))).toEqual([
      "ACCESS_CLIENT_SECRET",
    ]);
  });

  it("puts nothing when the Worker has both and none is new", async () => {
    const c = world({
      secrets: ["ACCESS_CLIENT_SECRET", "SESSION_SECRET"],
      state: SEEDED,
    });
    expect(await run(FLAGS, c.deps, ROOT, [secrets])).toBe(0);
    expect(c.wrangler("secret").map((x) => x.args[2])).toEqual(["list"]);
    expect(c.lines().at(-1)).toMatchObject({ status: "skipped" });
  });

  it("errors when ACCESS_CLIENT_SECRET is neither in memory nor on the Worker", async () => {
    const c = world({ secrets: [], state: SEEDED });
    expect(await run(FLAGS, c.deps, ROOT, [secrets])).toBe(1);
    expect(c.lines().at(-1).message).toContain("ACCESS_CLIENT_SECRET");
  });

  it("keeps clientSecretPending until secret bulk succeeds", async () => {
    const c = world({ secrets: "missing", state: SEEDED });
    const e = c.deps.exec;
    c.deps.exec = async (cmd, args, o) =>
      args[2] === "bulk"
        ? { code: 1, stdout: "", stderr: "boom" }
        : e(cmd, args, o);
    const pending: Step = {
      name: "pending",
      check: async () => "todo",
      apply: async (s) => {
        s.clientSecretPending = true;
        return undefined;
      },
    };
    expect(await run(FLAGS, c.deps, ROOT, [seed, pending, secrets])).toBe(1);
    expect(c.state().clientSecretPending).toBe(true);
    c.deps.exec = e;
    expect(await run(FLAGS, c.deps, ROOT, [seed, secrets])).toBe(0);
    expect(c.state().clientSecretPending).toBeUndefined();
  });

  it("lets the access step see the Worker's secret names", async () => {
    const c = world({ secrets: ["SESSION_SECRET"], state: SEEDED });
    let names: string[] | undefined;
    const probe: Step = {
      name: "probe",
      check: async (_s, ctx) => {
        names = await ctx.workerSecretNames?.();
        return "done";
      },
      apply: async () => undefined,
    };
    await run(FLAGS, c.deps, ROOT, [probe, secrets]);
    expect(names).toEqual(["SESSION_SECRET"]);
  });
});
