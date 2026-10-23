import { describe, expect, it } from "vitest";
import { run } from "../src/index.ts";
import type { Step } from "../src/step.ts";
import {
  APP_NAME,
  access,
  policyName,
  ROTATING_NAME,
  secretState,
} from "../src/steps/access.ts";
import { core, envelope, FLAGS, HOME, ROOT, STATE } from "./fakes.ts";

const TOKEN_FILE = `${HOME}/.openbus/open-bus-access-token`;
const A = "/accounts/acc1/access";
const TEAM = "team.cloudflareaccess.com";
const CALLBACK = "https://bus.example.com/auth/callback";

// biome-ignore lint/suspicious/noExplicitAny: untyped API objects
type Obj = any;
type World = {
  org?: "none" | "forbidden";
  apps?: Obj[];
  policies?: Obj[];
  /** Status DELETE /apps/<id> answers with instead of deleting. */
  deleteStatus?: number;
  state?: Obj;
};

const ownerPolicy = (email = "o@example.com") => ({
  id: "pol1",
  name: policyName("open-bus"),
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
    allow_pkce_without_client_secret: false,
  },
  created_at: "2026-01-01T00:00:00Z",
  aud: "aud-1",
  ...over,
});

/** A fake Access API: org, reusable policies and apps; records every write. */
function world(
  w: World = {},
  env: Record<string, string> = {},
  modes: Record<string, number> = {},
) {
  const apps: Obj[] = w.apps ?? [];
  const policies: Obj[] = w.policies ?? [];
  const ops: string[] = [];
  let n = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const path = u.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") ops.push(`${method} ${path.replace(A, "")}`);
    if (path === `${A}/organizations`) {
      if (w.org === "forbidden") return envelope(null, 403);
      if (w.org === "none") return envelope(null, 404);
      return envelope({ auth_domain: TEAM });
    }
    if (path === `${A}/policies` && method === "GET") return envelope(policies);
    if (path === `${A}/policies` && method === "POST") {
      const p = { ...body, id: "pol1" };
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
        // Like the real API: a PUT never changes the client id.
        apps[i] = {
          ...body,
          id,
          saas_app: { ...body.saas_app, client_id: apps[i].saas_app.client_id },
        };
        return envelope(apps[i]);
      }
      if (method === "DELETE") {
        if (w.deleteStatus) return envelope(null, w.deleteStatus);
        apps.splice(i, 1);
        return envelope({ id });
      }
    }
    return envelope(null, 404);
  }) as typeof globalThis.fetch;
  const c = core({
    fetch,
    env,
    modes,
    files: { [STATE]: JSON.stringify({ accountId: "acc1", ...w.state }) },
  });
  return { ...c, apps, policies, ops };
}
const withToken = (w: World = {}) =>
  world(w, { OB_ACCESS_TOKEN: "tok-abc123" });
const lines = (c: { lines: string[] }) => c.lines.map((l) => JSON.parse(l));
const last = (c: { lines: string[] }) => lines(c).at(-1);
/** Captures ctx.secrets through a step after access. */
const capture = (into: { secrets?: Record<string, string> }): Step => ({
  name: "capture",
  check: async (_s, ctx) => {
    into.secrets = ctx.secrets;
    return "done";
  },
  apply: async () => undefined,
});

describe("access", () => {
  it("asks for the Access token with a pre-filled dashboard link", async () => {
    const c = world();
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(2);
    const l = last(c);
    expect(l).toMatchObject({ step: "access", status: "action_required" });
    expect(l.data.url).toMatch(
      /^https:\/\/dash\.cloudflare\.com\/profile\/api-tokens/,
    );
    expect(decodeURIComponent(l.data.url)).toContain('"key":"access"');
    expect(l.data.saveCommand).toContain("umask 077");
    expect(l.data.saveCommand).toContain("read -rs");
    expect(l.data.saveCommand).toContain(".openbus");
    expect(l.data.saveCommand).toContain("open-bus-access-token");
    expect(c.ops).toEqual([]);
  });

  it("reads the token from ~/.openbus/<name>-access-token and never prints it", async () => {
    const c = world();
    c.files.set(TOKEN_FILE, "file-token-0123456789\n");
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(0);
    expect(c.ops).toContain("POST /apps");
    expect(c.lines.join("\n")).not.toContain("file-token-0123456789");
  });

  it("refuses a token file others can read", async () => {
    const c = world({}, {}, { [TOKEN_FILE]: 0o644 });
    c.files.set(TOKEN_FILE, "file-token-0123456789");
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(2);
    expect(last(c).message).toContain("chmod 600");
    expect(c.ops).toEqual([]);
  });

  it("creates the SaaS app and the owner policy", async () => {
    const c = withToken();
    const got: { secrets?: Record<string, string> } = {};
    expect(await run(FLAGS, c.deps, ROOT, [access, capture(got)])).toBe(0);
    expect(c.ops).toEqual(["POST /policies", "POST /apps"]);
    expect(c.policies[0]).toMatchObject({
      name: "OpenBus owner (open-bus)",
      decision: "allow",
      include: [{ email: { email: "o@example.com" } }],
    });
    expect(c.apps[0]).toMatchObject({
      name: "OpenBus (open-bus)",
      type: "saas",
      policies: [{ id: "pol1", precedence: 1 }],
    });
    expect(c.apps[0].saas_app).toMatchObject({
      auth_type: "oidc",
      redirect_uris: [CALLBACK],
      scopes: ["openid", "email", "profile"],
    });
    expect(lines(c)[0]).toMatchObject({ step: "access", status: "ok" });
    expect(c.state()).toMatchObject({
      teamDomain: TEAM,
      accessAppId: "app-new-1",
      accessClientId: "cid-new-1",
    });
    expect(got.secrets?.ACCESS_CLIENT_SECRET).toBe("cs-1");
  });

  it("adopts the existing app by name", async () => {
    const c = withToken({ policies: [ownerPolicy()], apps: [existingApp()] });
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(0);
    expect(c.ops.filter((o) => o.startsWith("POST"))).toEqual([]);
    expect(c.ops).toEqual([]);
    expect(last(c)).toMatchObject({ step: "access", status: "skipped" });
    expect(c.state()).toMatchObject({
      accessAppId: "app1",
      accessClientId: "cid-1",
      teamDomain: TEAM,
    });
  });

  it("updates the redirect URI when --host changes", async () => {
    const c = withToken({ policies: [ownerPolicy()], apps: [existingApp()] });
    const flags = FLAGS.map((f) =>
      f === "bus.example.com" ? "bus2.example.com" : f,
    );
    expect(await run(flags, c.deps, ROOT, [access])).toBe(0);
    expect(c.ops).toEqual(["PUT /apps/app1"]);
    expect(c.apps[0].saas_app.redirect_uris).toEqual([
      "https://bus2.example.com/auth/callback",
    ]);
    expect(c.apps[0].saas_app.client_id).toBe("cid-1");
    // The PUT carries only the fields setup owns (the fake stores the body).
    expect(Object.keys(c.apps[0]).sort()).toEqual(
      ["id", "name", "policies", "saas_app", "type"].sort(),
    );
    expect(c.state().accessClientId).toBe("cid-1");
  });

  it("reconciles the owner policy when --owner-email changes", async () => {
    const c = withToken({
      policies: [ownerPolicy("old@example.com")],
      apps: [existingApp()],
    });
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(0);
    expect(c.ops).toEqual(["PUT /policies/pol1"]);
    expect(c.policies[0].include).toEqual([
      { email: { email: "o@example.com" } },
    ]);
  });

  it("never prints the client secret", async () => {
    const c = withToken();
    await run(FLAGS, c.deps, ROOT, [access]);
    const out = [...c.lines, ...c.files.values()].join("\n");
    expect(out).not.toContain("cs-1");
  });

  it("scrubs the client secret even from an error that echoes it", async () => {
    const c = withToken();
    const leak: Step = {
      name: "leak",
      check: async () => "todo",
      apply: async (_s, ctx) => {
        throw new Error(`boom ${ctx.secrets?.ACCESS_CLIENT_SECRET}-padding`);
      },
    };
    await run(FLAGS, c.deps, ROOT, [access, leak]);
    expect(c.lines.join("\n")).not.toContain("cs-1");
  });

  it("keeps an adopted app's secret when the Worker check is absent", async () => {
    const c = withToken({ policies: [ownerPolicy()], apps: [existingApp()] });
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(0);
    expect(c.ops).toEqual([]);
  });

  it("rotates an adopted app's secret only when the Worker lacks it", async () => {
    for (const [names, rotated] of [
      [["ACCESS_CLIENT_SECRET"], false],
      [[], true],
    ] as const) {
      const c = withToken({ policies: [ownerPolicy()], apps: [existingApp()] });
      const got: { secrets?: Record<string, string> } = {};
      const hook: Step = {
        name: "hook",
        check: async (_s, ctx) => {
          ctx.workerSecretNames = async () => [...names];
          return "done";
        },
        apply: async () => undefined,
      };
      expect(await run(FLAGS, c.deps, ROOT, [hook, access, capture(got)])).toBe(
        0,
      );
      if (rotated) {
        expect(c.ops).toEqual([
          "POST /apps",
          "DELETE /apps/app1",
          "PUT /apps/app-new-1",
        ]);
        expect(c.apps.map((x) => x.name)).toEqual(["OpenBus (open-bus)"]);
        expect(JSON.stringify(c.apps)).not.toContain("cs-1");
        expect(got.secrets?.ACCESS_CLIENT_SECRET).toBe("cs-1");
        expect(c.state().accessClientId).toBe("cid-new-1");
      } else {
        expect(c.ops).toEqual([]);
        expect(got.secrets?.ACCESS_CLIENT_SECRET).toBeUndefined();
      }
    }
  });

  it("secretState: memory first, then the Worker, absent check means present", async () => {
    const ctx = { secrets: { ACCESS_CLIENT_SECRET: "x" } } as never;
    expect(await secretState(ctx)).toBe("memory");
    expect(await secretState({} as never)).toBe("worker");
    expect(
      await secretState({ workerSecretNames: async () => [] } as never),
    ).toBe("missing");
    // A secret minted earlier that never reached the Worker: the listed one is stale.
    const lists = { workerSecretNames: async () => ["ACCESS_CLIENT_SECRET"] };
    expect(await secretState(lists as never)).toBe("worker");
    expect(
      await secretState(lists as never, { clientSecretPending: true }),
    ).toBe("missing");
  });

  it("asks for a better token on a 403 organizations", async () => {
    const c = withToken({ org: "forbidden" });
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(2);
    expect(last(c).message).toContain("Access: Organizations: Read");
    expect(last(c).data.url).toContain("api-tokens");
    expect(c.ops).toEqual([]);
  });

  it("no Zero Trust organization is action_required with the Zero Trust link", async () => {
    const c = withToken({ org: "none" });
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(2);
    expect(last(c).message).toContain("https://one.dash.cloudflare.com/");
  });

  it("an app with the name that is not SaaS OIDC is action_required, never written", async () => {
    const c = withToken({
      policies: [ownerPolicy()],
      apps: [existingApp({ type: "self_hosted" })],
    });
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(2);
    expect(c.ops).toEqual([]);
  });

  it("--check reports done for an adopted app and writes nothing", async () => {
    const c = withToken({ policies: [ownerPolicy()], apps: [existingApp()] });
    expect(await run([...FLAGS, "--check"], c.deps, ROOT, [access])).toBe(0);
    expect(last(c)).toMatchObject({ step: "access", status: "done" });
    const d = withToken();
    expect(await run([...FLAGS, "--check"], d.deps, ROOT, [access])).toBe(2);
    expect(d.ops).toEqual([]);
  });
  it("deletes a leftover rotating app when the main app exists", async () => {
    const c = withToken({
      policies: [ownerPolicy()],
      apps: [
        existingApp(),
        existingApp({ id: "app-rot", name: ROTATING_NAME("open-bus") }),
      ],
    });
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(0);
    expect(c.ops).toEqual(["DELETE /apps/app-rot"]);
    expect(c.apps.map((x) => x.id)).toEqual(["app1"]);
    expect(c.state().accessAppId).toBe("app1");
  });

  it("adopts a leftover rotating app when the main app is missing, and renames it", async () => {
    const c = withToken({
      policies: [ownerPolicy()],
      apps: [existingApp({ id: "app-rot", name: ROTATING_NAME("open-bus") })],
    });
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(0);
    expect(c.ops).toEqual(["PUT /apps/app-rot"]);
    expect(c.apps[0].name).toBe("OpenBus (open-bus)");
    expect(c.state()).toMatchObject({
      accessAppId: "app-rot",
      accessClientId: "cid-1",
    });
  });

  it("ignores the saved app id when that app no longer carries our name", async () => {
    const c = withToken({
      policies: [ownerPolicy()],
      apps: [existingApp({ name: "Someone else's app" })],
      state: { accessAppId: "app1" },
    });
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(0);
    expect(c.ops).toEqual(["POST /apps"]);
    expect(c.apps[0]).toMatchObject({ id: "app1", name: "Someone else's app" });
    expect(c.state().accessAppId).toBe("app-new-1");
  });

  it("PUTs saas_app with only the fields setup owns, and fixes PKCE drift", async () => {
    const c = withToken({
      policies: [ownerPolicy()],
      apps: [
        existingApp({
          saas_app: {
            ...existingApp().saas_app,
            allow_pkce_without_client_secret: true,
            public_key: "pk",
            custom_claims: [{ name: "x" }],
          },
        }),
      ],
    });
    expect(await run(FLAGS, c.deps, ROOT, [access])).toBe(0);
    expect(c.ops).toEqual(["PUT /apps/app1"]);
    const { client_id: _, ...sent } = c.apps[0].saas_app;
    expect(Object.keys(sent).sort()).toEqual(
      [
        "allow_pkce_without_client_secret",
        "auth_type",
        "grant_types",
        "redirect_uris",
        "scopes",
      ].sort(),
    );
    expect(sent.allow_pkce_without_client_secret).toBe(false);
  });

  it("rotation treats a 404 on deleting the old app as deleted", async () => {
    const c = withToken({
      policies: [ownerPolicy()],
      apps: [existingApp()],
      deleteStatus: 404,
    });
    const hook: Step = {
      name: "hook",
      check: async (_s, ctx) => {
        ctx.workerSecretNames = async () => [];
        return "done";
      },
      apply: async () => undefined,
    };
    const got: { secrets?: Record<string, string> } = {};
    expect(await run(FLAGS, c.deps, ROOT, [hook, access, capture(got)])).toBe(
      0,
    );
    expect(c.ops).toEqual([
      "POST /apps",
      "DELETE /apps/app1",
      "PUT /apps/app-new-1",
    ]);
    expect(got.secrets?.ACCESS_CLIENT_SECRET).toBe("cs-1");
    expect(c.state().accessAppId).toBe("app-new-1");
  });
});
