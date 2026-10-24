import { describe, expect, it } from "vitest";
import { run, STEPS } from "../src/index.ts";
import { healthcheck, selftest } from "../src/steps/selftest.ts";
import { FLAGS, ROOT } from "./fakes.ts";
import { SEEDED, VERSION, world } from "./world.ts";

const DEPLOYED = { ...SEEDED, deployedVersion: VERSION };
const dns = () =>
  Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });

describe("healthcheck and selftest", () => {
  it("runs after secrets and deploy, selftest last", () => {
    expect(STEPS.map((s) => s.name)).toEqual([
      ...["prereqs", "token", "host", "access", "secrets"],
      ...["deploy", "healthcheck", "selftest"],
    ]);
  });

  it("--check over STEPS with no state and a healthy world exits 0", async () => {
    // access and secrets read Cloudflare Access and need a fake org; they are
    // stood in as done. Every other step is the real one.
    const steps = STEPS.map((st) =>
      ["access", "secrets"].includes(st.name)
        ? { ...st, check: async () => "done" as const }
        : st,
    );
    const c = world({ health: [VERSION] });
    expect(await run([...FLAGS, "--check"], c.deps, ROOT, steps)).toBe(0);
    for (const n of ["deploy", "healthcheck", "selftest"])
      expect(c.lines().find((l) => l.step === n)).toMatchObject({
        status: "done",
      });
  });

  it("healthcheck waits for /healthz to report the deployed version", async () => {
    const c = world({
      state: DEPLOYED,
      health: [dns(), dns(), "0.4.0", "0.4.0", VERSION],
    });
    expect(await run(FLAGS, c.deps, ROOT, [healthcheck])).toBe(0);
    expect(c.ops.filter((o) => o === "GET /healthz")).toHaveLength(5);
    expect(c.lines().at(-1)).toMatchObject({
      step: "healthcheck",
      status: "ok",
    });
  });

  it("healthcheck gives up after 3 minutes", async () => {
    const c = world({ state: DEPLOYED, health: ["0.4.0"] });
    expect(await run(FLAGS, c.deps, ROOT, [healthcheck])).toBe(1);
    const waited = c.sleeps.reduce((a, b) => a + b, 0);
    expect(waited).toBeGreaterThanOrEqual(180_000);
    expect(waited).toBeLessThan(200_000);
    expect(c.lines().at(-1).message).toContain("0.4.0");
  });

  it("selftest gets a user_code from POST /device/code", async () => {
    const c = world({ state: DEPLOYED });
    expect(await run(FLAGS, c.deps, ROOT, [selftest])).toBe(0);
    expect(c.ops).toContain("POST /device/code");
    expect(c.bodies.device).toMatchObject({
      machine_label: expect.any(String),
    });
    expect(c.out()).not.toContain("dev-code-secret-value");
  });

  it("selftest refuses a malformed device code response", async () => {
    for (const device of [
      { user_code: "bcdf-gh23", expires_in: 600, interval: 5 },
      { user_code: "BCDF-GH10", expires_in: 600, interval: 5 },
      { user_code: "BCDF-GH23", expires_in: 300, interval: 5 },
      { user_code: "BCDF-GH23", expires_in: 600, interval: 1 },
    ]) {
      const c = world({ state: DEPLOYED, device });
      expect(await run(FLAGS, c.deps, ROOT, [selftest])).toBe(1);
    }
  });

  it("the final ok line names the next step", async () => {
    const c = world({ state: DEPLOYED });
    expect(await run(FLAGS, c.deps, ROOT, [healthcheck, selftest])).toBe(0);
    const l = c.lines().at(-1);
    expect(l).toMatchObject({ step: "selftest", status: "ok" });
    expect(l.message).toContain(
      "npx @open-bus/cli install --hub https://bus.example.com",
    );
  });

  it("never POSTs under --check", async () => {
    const c = world({ state: DEPLOYED });
    expect(
      await run([...FLAGS, "--check"], c.deps, ROOT, [healthcheck, selftest]),
    ).toBe(0);
    expect(c.ops).toEqual(["GET /healthz"]);
  });
});
