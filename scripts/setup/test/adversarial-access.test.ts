import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import type { Step } from "../src/step.ts";
import { APP_NAME, access, POLICY_NAME } from "../src/steps/access.ts";
import { core, envelope, FLAGS, ROOT, STATE } from "./fakes.ts";

const A = "/accounts/acc1/access";
const TEAM = "team.cloudflareaccess.com";
const CALLBACK = "https://bus.example.com/auth/callback";

// biome-ignore lint/suspicious/noExplicitAny: untyped API objects
type Obj = any;
type World = {
  apps?: Obj[];
  policies?: Obj[];
  /** Status POST /apps answers with instead of creating. */
  failAppPost?: number;
  env?: Record<string, string>;
  state?: Obj;
};

const ownerPolicy = (email = "o@example.com", id = "pol1") => ({
  id,
  name: POLICY_NAME,
  decision: "allow",
  include: [{ email: { email } }],
  exclude: [],
  require: [],
});
const existingApp = (over: Obj = {}) => ({
  id: "app1",
  name: APP_NAME("open-bus"),
  type: "saas",
  policies: [{ id: "pol1", precedence: 1 }],
  saas_app: {
    auth_type: "oidc",
    client_id: "cid-1",
    redirect_uris: [CALLBACK],
    scopes: ["openid", "email", "profile"],
    grant_types: ["authorization_code_with_pkce"],
  },
  ...over,
});

/** Fake Access API (as in access.test.ts) plus failure injection and header capture. */
function world(w: World = {}) {
  const apps: Obj[] = w.apps ?? [];
  const policies: Obj[] = w.policies ?? [];
  const ops: string[] = [];
  const auth: string[] = [];
  let n = 0;
  let pn = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const path = u.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    auth.push(
      String((init?.headers as Record<string, string>)?.authorization ?? ""),
    );
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") ops.push(`${method} ${path.replace(A, "")}`);
    if (path === `${A}/organizations`) return envelope({ auth_domain: TEAM });
    if (path === `${A}/policies` && method === "GET") return envelope(policies);
    if (path === `${A}/policies` && method === "POST") {
      const p = { ...body, id: pn++ ? `pol${pn}` : "pol1" };
      policies.push(p);
      return envelope(p);
    }
    if (path.startsWith(`${A}/policies/`) && method === "PUT") {
      const i = policies.findIndex((p) => p.id === path.split("/").pop());
      policies[i] = { ...body, id: policies[i].id };
      return envelope(policies[i]);
    }
    if (path === `${A}/apps` && method === "GET") return envelope(apps);
    if (path === `${A}/apps` && method === "POST") {
      if (w.failAppPost) return envelope(null, w.failAppPost);
      n++;
      const created = {
        ...body,
        id: `app-new-${n}`,
        saas_app: {
          ...body.saas_app,
          client_id: `cid-new-${n}`,
          client_secret: "cs-1",
        },
      };
      const { client_secret: _, ...stored } = created.saas_app;
      apps.push({ ...created, saas_app: stored });
      return envelope(created);
    }
    if (path.startsWith(`${A}/apps/`)) {
      const id = path.split("/").pop();
      const i = apps.findIndex((x) => x.id === id);
      if (method === "PUT") {
        apps[i] = { ...body, id };
        return envelope(apps[i]);
      }
      if (method === "DELETE") {
        apps.splice(i, 1);
        return envelope({ id });
      }
    }
    return envelope(null, 404);
  }) as typeof globalThis.fetch;
  const c = core({
    fetch,
    env: w.env ?? { OB_ACCESS_TOKEN: "tok-abc123" },
    files: { [STATE]: JSON.stringify({ accountId: "acc1", ...w.state }) },
  });
  return { ...c, apps, policies, ops, auth };
}

/** The policies an app's login evaluates. */
const policiesOf = (c: ReturnType<typeof world>, app: Obj) =>
  (app.policies ?? []).map((ref: Obj) =>
    c.policies.find((p) => p.id === ref.id),
  );

describe("adversarial: access", () => {
  it("a second instance with another owner does not rewrite the first instance's owner policy", async () => {
    const c = world();
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(0);
    const other = [
      ...["--name", "other", "--host", "other.example.com"],
      ...["--owner-email", "b@example.com", "--json"],
    ];
    c.files.set(
      STATE.replace("open-bus", "other"),
      JSON.stringify({ accountId: "acc1" }),
    );
    expect(await run(other, c.deps, ROOT, [access])).toBe(0);
    const first = c.apps.find((x) => x.name === APP_NAME("open-bus"));
    // Instance open-bus must still admit exactly its owner, o@example.com.
    const emails = policiesOf(c, first).flatMap((p: Obj) =>
      p.include.map((r: Obj) => r.email?.email),
    );
    expect(emails).toEqual(["o@example.com"]);
  });

  it("an adopted app keeps no policy other than the owner policy", async () => {
    const everyone = {
      id: "pol-all",
      name: "Everyone",
      decision: "allow",
      include: [{ everyone: {} }],
      exclude: [],
      require: [],
    };
    const stale = ownerPolicy("old@example.com", "pol-stale");
    const c = world({
      policies: [ownerPolicy(), everyone, stale],
      apps: [
        existingApp({
          policies: [
            { id: "pol-all", precedence: 1 },
            { id: "pol-stale", precedence: 2 },
            { id: "pol1", precedence: 3 },
          ],
        }),
      ],
    });
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(0);
    expect(c.apps[0].policies.map((p: Obj) => p.id)).toEqual(["pol1"]);
  });

  it("rotation never deletes the app before its replacement exists", async () => {
    const c = world({
      policies: [ownerPolicy()],
      apps: [existingApp()],
      failAppPost: 500,
    });
    const hook: Step = {
      name: "hook",
      check: async (_s, ctx) => {
        ctx.workerSecretNames = async () => [];
        return "done";
      },
      apply: async () => undefined,
    };
    expect(await run(FLAGS, c.deps, ROOT, [hook, access])).toBe(1);
    // The POST failed: the original app must still be there.
    expect(c.apps.map((x) => x.id)).toEqual(["app1"]);
  });

  it("adopts the app recorded in state by id after a rename, without creating a duplicate", async () => {
    const c = world({
      policies: [ownerPolicy()],
      apps: [existingApp({ name: "My bus" })],
      state: { accessAppId: "app1", accessClientId: "cid-1" },
    });
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(0);
    expect(c.ops).not.toContain("POST /apps");
    expect(c.apps).toHaveLength(1);
  });

  it("sends OB_ACCESS_TOKEN trimmed in the Authorization header", async () => {
    const c = world({ env: { OB_ACCESS_TOKEN: "tok-abc123\n" } });
    await run(FLAGS, c.deps, ROOT, [access]);
    expect(c.auth.length).toBeGreaterThan(0);
    expect(c.auth.every((h) => h === "Bearer tok-abc123")).toBe(true);
  });
});
