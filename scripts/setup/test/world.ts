import type { Exec } from "../src/cf.ts";
import { core, envelope, ROOT, STATE } from "./fakes.ts";

export const VERSION = "0.5.0";
export const SEEDED = {
  name: "open-bus",
  accountId: "acc1",
  host: "bus.example.com",
  ownerEmail: "o@example.com",
  accessAppId: "app1",
  accessClientId: "cid-1",
  teamDomain: "team.cloudflareaccess.com",
};

type Call = { cmd: string; args: string[]; input?: string; cwd?: string };
type Opts = {
  /** Worker secret names `wrangler secret list` reports; "missing" = no Worker. */
  secrets?: string[] | "missing";
  /** Zones by name on the account. */
  zones?: string[];
  /** Versions /healthz reports, one per call; the last repeats. */
  health?: (string | Error)[];
  device?: unknown;
  domains?: { id: string; hostname: string; service: string }[];
  state?: Record<string, unknown>;
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
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts?.input, cwd: opts?.cwd });
    const w = args.slice(1);
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
      if (o.secrets === "missing")
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
          { status: 200 },
        );
      }
      return new Response("nf", { status: 404 });
    }
    const path = u.pathname.replace("/client/v4", "");
    ops.push(`${method} ${path}${u.search.replace(/[?&]per_page.*$/, "")}`);
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
    env: { CLOUDFLARE_API_TOKEN: "cf-deploy-token-0001", ...o.env },
    files: {
      [`${ROOT}/package.json`]: JSON.stringify({ version: VERSION }),
      [`${ROOT}/apps/server/wrangler.jsonc`]: "{}",
      [`${ROOT}/apps/dashboard/dist/index.html`]: "<!doctype html>",
      ...(o.state ? { [STATE]: JSON.stringify(o.state) } : {}),
    },
  });
  const lines = () => c.lines.map((l) => JSON.parse(l));
  const wrangler = (sub: string) =>
    calls.filter((x) => x.args[0] === "wrangler" && x.args[1] === sub);
  const out = () => c.lines.join("\n");
  return { ...c, calls, ops, bodies, lines, out, wrangler };
}
