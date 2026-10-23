import type { State } from "../state.ts";
import type { Ctx, Step } from "../step.ts";
import { repoVersion } from "../version.ts";

// Cut from Open Artifacts' selftest: no DoH probe, no content host, no PAT.
/** How long /healthz may take to report the deployed version (DNS, certificate, rollout). */
export const HEALTH_WAIT_MS = 3 * 60_000;
const HEALTH_DELAY_MS = 5_000;
const FETCH_TIMEOUT_MS = 10_000;
const USER_CODE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

const base = (ctx: Ctx) => `https://${ctx.opts.host}`;
const next = (ctx: Ctx) =>
  `next: run \`npx open-bus install --hub ${base(ctx)}\` on each machine`;
const sleeper = (ctx: Ctx) =>
  ctx.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
const timeout = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);

/** The version /healthz reports, or why there is none. */
export async function probe(
  ctx: Ctx,
): Promise<{ version?: string; problem?: string }> {
  try {
    // redirect: "manual": a redirect is not a healthy Worker, so it reads as
    // todo. The host step decides which Worker serves the host.
    const res = await ctx.deps.fetch(`${base(ctx)}/healthz`, {
      redirect: "manual",
      signal: timeout(),
    });
    if (res.status !== 200) return { problem: `HTTP ${res.status}` };
    const v = ((await res.json().catch(() => ({}))) as { version?: unknown })
      .version;
    return typeof v === "string"
      ? { version: v }
      : { problem: "no version in the body" };
  } catch (e) {
    const code = (e as { cause?: { code?: unknown } }).cause?.code;
    return { problem: typeof code === "string" ? code : (e as Error).message };
  }
}

const want = (state: State) => {
  if (!state.deployedVersion)
    throw new Error("nothing deployed yet; rerun setup without --check");
  return state.deployedVersion;
};

export const healthcheck: Step = {
  name: "healthcheck",
  async check(_state, ctx) {
    if (!ctx.opts.check) return "todo";
    // Same drift test as deploy: what the host serves vs the repo version, so
    // it works with no state file (stateless CI).
    const want = repoVersion(ctx);
    const { version, problem } = await probe(ctx);
    if (version && version === want) return "done";
    ctx.notes.push(
      version ? `/healthz reports ${version}` : `/healthz: ${problem}`,
    );
    return "todo";
  },
  async apply(state, ctx) {
    const expected = want(state);
    const now = ctx.deps.now ?? Date.now;
    const deadline = now() + HEALTH_WAIT_MS;
    for (;;) {
      const { version, problem } = await probe(ctx);
      if (version === expected) {
        ctx.notes.push(`${base(ctx)}/healthz reports ${version}`);
        return undefined;
      }
      if (now() >= deadline)
        throw new Error(
          `${base(ctx)}/healthz did not report ${expected} within 3 minutes (last: ${version ?? problem}); check the custom domain in the Cloudflare dashboard, then rerun`,
        );
      await sleeper(ctx)(HEALTH_DELAY_MS);
    }
  },
};

/** Starts a device flow on the live Worker; the codes are never reported. */
export const selftest: Step = {
  name: "selftest",
  async check(_state, ctx) {
    // POST is not read-only: --check never starts a device flow.
    return ctx.opts.check ? "done" : "todo";
  },
  async apply(_state, ctx) {
    const res = await ctx.deps.fetch(`${base(ctx)}/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machine_label: "open-bus-setup-selftest" }),
      signal: timeout(),
    });
    if (res.status !== 200)
      throw new Error(`POST /device/code: HTTP ${res.status}`);
    const b = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const bad = [
      !(typeof b.user_code === "string" && USER_CODE.test(b.user_code)) &&
        "user_code is not XXXX-XXXX",
      typeof b.device_code !== "string" && "no device_code",
      b.expires_in !== 600 && "expires_in is not 600",
      b.interval !== 5 && "interval is not 5",
    ].filter(Boolean);
    if (bad.length) throw new Error(`POST /device/code: ${bad.join("; ")}`);
    ctx.notes.push("device flow answers", next(ctx));
    return undefined;
  },
};
