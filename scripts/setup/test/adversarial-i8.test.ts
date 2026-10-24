// I8 adversarial pass on the install path. Each `it.fails` is a real finding:
// it fails today and turns green (so the `.fails` must go) once fixed.
import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import type { Ctx } from "../src/step.ts";
import { APP_NAME } from "../src/steps/access.ts";
import { selftest } from "../src/steps/selftest.ts";
import { envelope, FLAGS, ROOT } from "./fakes.ts";
import { SEEDED, world } from "./world.ts";

// biome-ignore lint/suspicious/noExplicitAny: untyped API objects
type Obj = any;
const A = "/accounts/acc1/access";
const TEAM = "team.cloudflareaccess.com";
const DESTROY = ["--name", "open-bus", "--json", "--destroy"];
const YES = [...DESTROY, "--yes-destroy=open-bus"];

/** world.ts plus an in-memory Access API (org, policies, apps) on acc1. */
function full(
  o: Parameters<typeof world>[0] & { apps?: Obj[]; policies?: Obj[] } = {},
) {
  const w = world(o);
  const apps: Obj[] = o.apps ?? [];
  const policies: Obj[] = o.policies ?? [];
  const inner = w.deps.fetch;
  let n = 0;
  w.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const path = u.pathname.replace("/client/v4", "");
    if (!path.startsWith(A)) return inner(input, init);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    w.ops.push(`${method} ${path}`);
    if (path === `${A}/organizations`) return envelope({ auth_domain: TEAM });
    if (path === `${A}/policies` && method === "GET") return envelope(policies);
    if (path === `${A}/policies` && method === "POST") {
      const p = { ...body, id: `pol${policies.length + 1}` };
      policies.push(p);
      return envelope(p);
    }
    if (path === `${A}/apps` && method === "GET") return envelope(apps);
    if (path === `${A}/apps` && method === "POST") {
      n++;
      const saas = { ...body.saas_app, client_id: `cid-new-${n}` };
      apps.push({ ...body, id: `app-new-${n}`, saas_app: saas });
      return envelope({
        ...body,
        id: `app-new-${n}`,
        saas_app: { ...saas, client_secret: `client-secret-new-${n}` },
      });
    }
    const id = path.split("/").pop();
    const i = apps.findIndex((x) => x.id === id);
    if (path.startsWith(`${A}/apps/`) && method === "PUT") {
      apps[i] = { ...body, id };
      return envelope(apps[i]);
    }
    if (path.startsWith(`${A}/apps/`) && method === "DELETE") {
      if (i >= 0) apps.splice(i, 1);
      return envelope({ id });
    }
    return envelope(null, 404);
  }) as typeof fetch;
  return { ...w, apps, policies };
}

const bulks = (w: ReturnType<typeof world>) =>
  w.calls.filter((c) => c.args[1] === "secret" && c.args[2] === "bulk");

describe("I8 adversarial: destroy", () => {
  it.fails("I8-01 --destroy after a failed first run does not delete a Worker setup never deployed", async () => {
    // First run stops at the host step (host taken), but state is persisted.
    const w = world({
      domains: [{ id: "d9", hostname: "bus.example.com", service: "theirs" }],
    });
    expect(await run(FLAGS, w.deps, ROOT)).toBe(2);
    expect(w.wrangler("deploy")).toEqual([]);
    // The user (or agent) then follows "Remove OpenBus".
    await run(YES, w.deps, ROOT);
    expect(w.ops).not.toContain(
      "DELETE /accounts/acc1/workers/scripts/open-bus?force=true",
    );
  });

  it.fails("I8-02 a crafted custom-domain id cannot turn destroy into a DELETE of another Worker", async () => {
    const w = world({
      state: SEEDED,
      domains: [
        {
          id: "../scripts/victim",
          hostname: "bus.example.com",
          service: "open-bus",
        },
      ],
    });
    await run(YES, w.deps, ROOT);
    expect(w.ops).not.toContain("DELETE /accounts/acc1/workers/scripts/victim");
  });
});

describe("I8 adversarial: install touches only its own resources", () => {
  it.fails("I8-03 a first install does not overwrite an existing non-OpenBus Worker named --name", async () => {
    // No state; the account already has a Worker "open-bus" with foreign secrets.
    const w = full({ secrets: ["DATABASE_URL", "STRIPE_KEY"] });
    await run(FLAGS, w.deps, ROOT);
    expect(bulks(w)).toEqual([]);
    expect(w.wrangler("deploy")).toEqual([]);
  });

  it.fails("I8-07 --upgrade with no existing instance refuses instead of creating one", async () => {
    const w = full({ secrets: "missing" });
    await run([...FLAGS, "--upgrade"], w.deps, ROOT);
    expect(w.ops).not.toContain(`POST ${A}/apps`);
    expect(w.wrangler("deploy")).toEqual([]);
  });
});

describe("I8 adversarial: idempotence", () => {
  it.fails("I8-04 --ci: a new Access app whose secret bulk failed is not reported done on the rerun (stale ACCESS_CLIENT_SECRET)", async () => {
    // The Worker holds the secret of an app that was deleted in the dashboard.
    const w = full({ secrets: ["ACCESS_CLIENT_SECRET", "SESSION_SECRET"] });
    const ci = [...FLAGS, "--ci"];
    w.failOn((a) => a[1] === "secret" && a[2] === "bulk");
    expect(await run(ci, w.deps, ROOT)).toBe(1);
    expect(w.apps.map((x) => x.name)).toEqual([APP_NAME("open-bus")]);
    // Rerun (the next CI attempt): bulk works now.
    w.failOn(() => false);
    const before = bulks(w).length;
    const code = await run(ci, w.deps, ROOT);
    // Either the new app's secret reaches the Worker, or the run is not green.
    expect(bulks(w).length > before || code !== 0).toBe(true);
  });
});

describe("I8 adversarial: output and network", () => {
  it.fails("I8-05 selftest does not follow a redirect on POST /device/code", async () => {
    const good = {
      device_code: "d",
      user_code: "BCDF-GH23",
      expires_in: 600,
      interval: 5,
    };
    const fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      // As undici: "manual" hands back the 3xx, "error" throws, else it follows.
      if (init?.redirect === "manual")
        return new Response(null, {
          status: 307,
          headers: { location: "https://evil.example/device/code" },
        });
      if (init?.redirect === "error") throw new TypeError("redirect");
      // Followed to evil.example, which answers like a healthy B4.
      return new Response(JSON.stringify(good), { status: 201 });
    }) as typeof globalThis.fetch;
    const ctx = {
      deps: { fetch },
      opts: { host: "bus.example.com" },
      notes: [],
    } as unknown as Ctx;
    await expect(selftest.apply({}, ctx)).rejects.toThrow();
  });

  it.fails("I8-06 an invalid --host value (a mis-pasted token) is not echoed", async () => {
    const T = "Wz9_xQ3kLmN0pR8sTuV2yA4bC6dE7fG1hJ5kL";
    const w = world();
    const argv = ["--name", "open-bus", "--host", T];
    argv.push("--owner-email", "o@example.com", "--json");
    expect(await run(argv, w.deps, ROOT)).toBe(1);
    expect(w.out().toLowerCase()).not.toContain(T.toLowerCase());
  });
});
