import type { Exec } from "../src/cf.ts";
import { core, envelope, ROOT, STATE } from "./fakes.ts";

export const VERSION = "0.5.0";
/** The setup token (OB_ACCESS_TOKEN) every world has unless a test clears it. */
export const SETUP_TOKEN = "setup-token-0123456789";
export const SEEDED = {
  name: "open-bus",
  accountId: "acc1",
  host: "bus.example.com",
  ownerEmail: "o@example.com",
  accessAppId: "app1",
  accessClientId: "cid-1",
  teamDomain: "team.cloudflareaccess.com",
  // A finished earlier run: its secret bulk wrote to the Worker.
  workerWritten: true,
};

type Call = {
  cmd: string;
  args: string[];
  input?: string;
  cwd?: string;
  env?: Record<string, string>;
  replaceEnv?: boolean;
};
type Opts = {
  /**
   * Worker secret names `wrangler secret list` reports; "missing" (the default,
   * a fresh account) = no Worker, [] = an existing Worker with no secrets.
   */
  secrets?: string[] | "missing" | "missing-v4" | "other-not-found";
  /** Zones by name on the account. */
  zones?: string[];
  /** Versions /healthz reports, one per call; the last repeats. */
  health?: (string | Error)[];
  device?: unknown;
  domains?: { id: string; hostname: string; service: string }[];
  state?: Record<string, unknown>;
  /** API paths containing one of these answer 403. */
  forbid?: string[];
  /** DNS records for any name in the zone. */
  dns?: unknown[];
  env?: Record<string, string>;
};

/** A fake Cloudflare (API, wrangler, the deployed Worker) recording every call. */
export function world(o: Opts = {}) {
  const calls: Call[] = [];
  const ops: string[] = [];
  const bodies: Record<string, unknown> = {};
  const health = [...(o.health ?? [VERSION])];
  /** [API op, Authorization header] per Cloudflare API call. */
  const auth: [string, string][] = [];
  /** Every file as it was when `wrangler deploy` ran. */
  let atDeploy = new Map<string, string>();
  let files = new Map<string, string>();
  let fail: ((args: string[]) => boolean) | undefined;
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({
      cmd,
      args,
      input: opts?.input,
      cwd: opts?.cwd,
      env: opts?.env,
      replaceEnv: opts?.replaceEnv,
    });
    const w = args.slice(1);
    if (w[0] === "deploy") atDeploy = new Map(files);
    if (fail?.(args)) return { code: 1, stdout: "", stderr: "failed" };
    if (w[0] === "whoami")
      return {
        code: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          accounts: [{ id: "acc1", name: "A" }],
        }),
        stderr: "",
      };
    if (w[0] === "secret" && w[1] === "list") {
      if (o.secrets === "missing-v4")
        return {
          code: 1,
          stdout: "",
          stderr:
            '✘ [ERROR] Worker "open-bus" not found.\n  If this is a new Worker, run `wrangler deploy` first to create it.',
        };
      if (o.secrets === "other-not-found")
        return {
          code: 1,
          stdout: "",
          stderr: '✘ [ERROR] Worker "someone-else" not found.',
        };
      if (o.secrets === "missing" || o.secrets === undefined)
        return {
          code: 1,
          stdout: "",
          stderr: "This Worker does not exist on your account. [code: 10007]",
        };
      return {
        code: 0,
        stdout: JSON.stringify(
          (o.secrets ?? []).map((name) => ({ name, type: "secret_text" })),
        ),
        stderr: "",
      };
    }
    return { code: 0, stdout: "Current Version ID: v1", stderr: "" };
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (u.hostname === "bus.example.com") {
      ops.push(`${method} ${u.pathname}`);
      if (u.pathname === "/healthz") {
        const v = health.length > 1 ? health.shift() : health[0];
        if (v instanceof Error) throw v;
        return new Response(JSON.stringify({ version: v }), { status: 200 });
      }
      if (u.pathname === "/device/code" && method === "POST") {
        bodies.device = body;
        return new Response(
          JSON.stringify(
            o.device ?? {
              device_code: "dev-code-secret-value",
              user_code: "BCDF-GH23",
              verification_uri: "https://bus.example.com/device",
              expires_in: 600,
              interval: 5,
            },
          ),
          // B4 answers 201 (routes/device.ts).
          { status: 201 },
        );
      }
      return new Response("nf", { status: 404 });
    }
    const path = u.pathname.replace("/client/v4", "");
    const op = `${method} ${path}${u.search.replace(/[?&]per_page.*$/, "")}`;
    ops.push(op);
    auth.push([op, new Headers(init?.headers).get("authorization") ?? ""]);
    const deny = o.forbid?.find((f) => path.includes(f));
    if (deny) return envelope(null, 403, [{ message: "Authentication error" }]);
    if (path === "/zones") {
      const name = u.searchParams.get("name");
      const hit = (o.zones ?? ["example.com"]).includes(name ?? "");
      return envelope(hit ? [{ id: `z-${name}`, name }] : []);
    }
    if (/^\/zones\/[^/]+\/dns_records$/.test(path))
      return envelope(o.dns ?? []);
    if (path === "/accounts/acc1/workers/domains" && method === "GET")
      return envelope(o.domains ?? []);
    if (method === "DELETE") return envelope(null);
    return envelope(null, 404);
  }) as typeof globalThis.fetch;
  const c = core({
    exec,
    fetch,
    env: {
      CLOUDFLARE_API_TOKEN: "cf-deploy-token-0001",
      OB_ACCESS_TOKEN: SETUP_TOKEN,
      ...o.env,
    },
    files: {
      [`${ROOT}/package.json`]: JSON.stringify({ version: VERSION }),
      [`${ROOT}/apps/server/wrangler.jsonc`]: "{}",
      [`${ROOT}/apps/server/package.json`]: "{}",
      [`${ROOT}/apps/dashboard/dist/index.html`]: "<!doctype html>",
      ...(o.state ? { [STATE]: JSON.stringify(o.state) } : {}),
    },
  });
  files = c.files;
  const lines = () => c.lines.map((l) => JSON.parse(l));
  const wrangler = (sub: string) =>
    calls.filter((x) => x.args[0] === "wrangler" && x.args[1] === sub);
  const out = () => c.lines.join("\n");
  return {
    ...c,
    calls,
    ops,
    auth,
    bodies,
    lines,
    out,
    wrangler,
    atDeploy: () => atDeploy,
    /** Makes exec fail for matching argv. */
    failOn: (f: (args: string[]) => boolean) => {
      fail = f;
    },
  };
}
