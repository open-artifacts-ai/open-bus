import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import { HOME, ROOT, STATE } from "./fakes.ts";
import { SEEDED, world } from "./world.ts";

const BASE = ["--name", "open-bus", "--json", "--destroy"];
const TOKEN_FILE = `${HOME}/.openbus/open-bus-access-token`;
const domains = [
  { id: "d1", hostname: "bus.example.com", service: "open-bus" },
  { id: "d2", hostname: "other.example.com", service: "other" },
];

describe("destroy", () => {
  it("--destroy refuses without --yes-destroy=<name>", async () => {
    const c = world({ state: SEEDED, domains });
    c.files.set(TOKEN_FILE, "access-token-0123456789");
    expect(await run(BASE, c.deps, ROOT)).toBe(2);
    expect(c.lines().at(-1)).toMatchObject({
      step: "destroy",
      status: "action_required",
    });
    expect(c.lines().at(-1).message).toContain("--yes-destroy=open-bus");
    expect(c.ops.filter((o) => o.startsWith("DELETE"))).toEqual([]);

    const d = world({ state: SEEDED, domains });
    d.files.set(TOKEN_FILE, "access-token-0123456789");
    expect(await run([...BASE, "--yes-destroy=other"], d.deps, ROOT)).toBe(1);
    expect(d.ops.filter((o) => o.startsWith("DELETE"))).toEqual([]);
  });

  it("deletes the Worker and the Access app, keeps the zone and DNS records it did not create", async () => {
    const c = world({ state: SEEDED, domains });
    c.files.set(TOKEN_FILE, "access-token-0123456789");
    expect(await run([...BASE, "--yes-destroy=open-bus"], c.deps, ROOT)).toBe(
      0,
    );
    const deletes = c.ops.filter((o) => o.startsWith("DELETE"));
    expect(deletes).toEqual([
      "DELETE /accounts/acc1/workers/domains/d1",
      "DELETE /accounts/acc1/workers/scripts/open-bus?force=true",
      "DELETE /accounts/acc1/access/apps/app1",
    ]);
    expect(
      c.ops.some(
        (o) => /\/zones\/|dns_records/.test(o) && !o.startsWith("GET"),
      ),
    ).toBe(false);
    expect(c.files.has(STATE)).toBe(false);
    expect(c.lines().at(-1)).toMatchObject({ step: "destroy", status: "ok" });
    expect(c.out()).not.toContain("access-token-0123456789");
  });

  it("names the Access app it leaves when state has no app id", async () => {
    const { accessAppId: _, ...rest } = SEEDED;
    const c = world({ state: rest, domains });
    expect(await run([...BASE, "--yes-destroy=open-bus"], c.deps, ROOT)).toBe(
      0,
    );
    expect(c.lines().at(-1).message).toContain("OpenBus (open-bus)");
    expect(c.ops.some((o) => o.includes("/access/apps"))).toBe(false);
  });

  it("asks for the Access token before deleting anything", async () => {
    const c = world({ state: SEEDED, domains, env: { OB_ACCESS_TOKEN: "" } });
    expect(await run([...BASE, "--yes-destroy=open-bus"], c.deps, ROOT)).toBe(
      2,
    );
    expect(c.ops.filter((o) => o.startsWith("DELETE"))).toEqual([]);
  });

  it("without state, says how to destroy a CI-deployed instance by hand", async () => {
    const c = world({ domains });
    expect(await run([...BASE, "--yes-destroy=open-bus"], c.deps, ROOT)).toBe(
      1,
    );
    expect(c.lines().at(-1).message).toMatch(/deployed by CI.*by hand/);
    expect(c.ops.filter((o) => o.startsWith("DELETE"))).toEqual([]);
  });

  it("refuses --destroy with --check", async () => {
    const c = world({ state: SEEDED });
    expect(
      await run([...BASE, "--check", "--yes-destroy=open-bus"], c.deps, ROOT),
    ).toBe(1);
  });
});
