/**
 * Local-only Worker entry for `wrangler dev -c wrangler.e2e.jsonc` (dev:e2e).
 * Adds POST /__e2e/machine, which seeds a machine on the owner hub and
 * answers the daemon's machine.json shape. Never deployed: no deploy path
 * references wrangler.e2e.jsonc, and src/ never imports this file
 * (test/e2e-guards.node.test.ts).
 */
import { MachineLabelSchema } from "@ob/shared";
import type { Env } from "../../src/env.js";
import { hub } from "../../src/hub/stub.js";
import worker from "../../src/index.js";

export { Hub } from "../../src/index.js";

const SEED_PATH = "/__e2e/machine";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_LABEL = "e2e";

const json = (status: number, body: unknown) => Response.json(body, { status });

async function seed(req: Request, env: Env, url: URL): Promise<Response> {
  // Judged by the request URL only; headers are client-controlled.
  if (!LOOPBACK.has(url.hostname)) return json(403, { code: "forbidden" });
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
    return worker.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
