/**
 * Local-only Worker entry for `wrangler dev -c wrangler.e2e.jsonc` (dev:e2e).
 * Adds POST /__e2e/machine, which seeds a machine on the owner hub and
 * answers the daemon's machine.json shape, and DELETE /__e2e/machine/:id,
 * which revokes it through the hub's real revoke path (revokeMachine: 4403
 * close, agents leave the roster, mail refused as revoked). Callers send
 * `X-OB-E2E: 1`. Never deployed: no deploy path
 * references wrangler.e2e.jsonc, and src/ never imports this file
 * (test/e2e-guards.node.test.ts).
 */
import { isMachineId, MachineLabelSchema } from "@ob/shared";
import type { Env } from "../../src/env.js";
import { hub } from "../../src/hub/stub.js";
import worker from "../../src/index.js";

export { Hub } from "../../src/index.js";

const SEED_PATH = "/__e2e/machine";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_LABEL = "e2e";
const E2E_HEADER = "X-OB-E2E";

const json = (status: number, body: unknown) => Response.json(body, { status });

/** The same checks for every /__e2e route: a loopback URL host and the header. */
function refused(req: Request, url: URL): Response | undefined {
  // Judged by the URL host, which wrangler dev derives from the Host header:
  // this stops DNS rebinding only. Locality comes from the 127.0.0.1 bind
  // (wrangler.e2e.jsonc dev.ip).
  if (!LOOPBACK.has(url.hostname)) return json(403, { code: "forbidden" });
  // A custom header forces a CORS preflight, which nothing answers, so a web
  // page cannot mint or revoke machines with a simple cross-origin request.
  if (req.headers.get(E2E_HEADER) !== "1")
    return json(403, { code: "forbidden" });
  return undefined;
}

async function revoke(
  req: Request,
  env: Env,
  url: URL,
  id: string,
): Promise<Response> {
  const no = refused(req, url);
  if (no) return no;
  // Not a machine id (@ob/shared rule): simply unknown, never sent to the hub.
  if (!isMachineId(id)) return json(404, { code: "not_found" });
  // The real revoke path: true on the first revoke, false when unknown or done.
  return (await hub(env).revokeMachine(id))
    ? new Response(null, { status: 204 })
    : json(404, { code: "not_found" });
}

async function seed(req: Request, env: Env, url: URL): Promise<Response> {
  const no = refused(req, url);
  if (no) return no;
  let label: unknown = DEFAULT_LABEL;
  try {
    const text = await req.text();
    if (text.trim() !== "") {
      const body = JSON.parse(text) as unknown;
      if (typeof body !== "object" || body === null || Array.isArray(body))
        return json(400, { code: "invalid_body" });
      label = (body as { label?: unknown }).label ?? DEFAULT_LABEL;
    }
  } catch {
    return json(400, { code: "invalid_body" });
  }
  // createMachine throws on a bad label; check first so nothing throws over RPC.
  const parsed = MachineLabelSchema.safeParse(label);
  if (!parsed.success) return json(400, { code: "invalid_label" });
  const m = await hub(env).createMachine(parsed.data);
  if (!m.ok) return json(409, { code: m.code });
  return json(200, {
    hub: url.origin,
    machine_id: m.id,
    label: m.label,
    machine_token: m.token,
  });
}

export default {
  fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === SEED_PATH)
      return seed(req, env, url);
    if (req.method === "DELETE" && url.pathname.startsWith(`${SEED_PATH}/`))
      return revoke(req, env, url, url.pathname.slice(SEED_PATH.length + 1));
    return worker.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
