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
  `next: run \`npx @open-bus/cli install --hub ${base(ctx)}\` on each machine`;
const sleeper = (ctx: Ctx) =>
  ctx.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
const timeout = () => AbortSignal.timeout(FETCH_TIMEOUT_MS);

/** Lookup failures that mean "this resolver doesn't know the host yet". */
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN"]);
const dnsCode = (e: unknown): string | undefined => {
  const c = (e as { cause?: { code?: unknown }; code?: unknown }).cause?.code;
  const code = typeof c === "string" ? c : (e as { code?: unknown }).code;
  return typeof code === "string" && DNS_CODES.has(code) ? code : undefined;
};

/**
 * fetch to the instance host. A brand-new host's DNS can lag on this machine
 * (a cached "not found"), so a lookup failure retries once through public DNS
 * (1.1.1.1) when the deps provide it; the URL, Host and SNI stay the same.
 */
async function hostFetch(
  ctx: Ctx,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await ctx.deps.fetch(url, init);
  } catch (e) {
    if (!dnsCode(e) || !ctx.deps.publicFetch) throw e;
    const res = await ctx.deps.publicFetch(url, {
      ...init,
      signal: timeout(),
    });
    viaPublicDns.add(ctx);
    return res;
  }
}
/** Runs whose host only resolved through public DNS (named in the ok line). */
const viaPublicDns = new WeakSet<Ctx>();
const dnsNote = (ctx: Ctx) =>
  viaPublicDns.has(ctx)
    ? " (resolved through 1.1.1.1; this machine's DNS hasn't caught up yet)"
    : "";

/** The version /healthz reports, or why there is none. */
export async function probe(
  ctx: Ctx,
): Promise<{ version?: string; problem?: string }> {
  try {
    // redirect: "manual": a redirect is not a healthy Worker, so it reads as
    // todo. The host step decides which Worker serves the host.
    const res = await hostFetch(ctx, `${base(ctx)}/healthz`, {
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
        ctx.notes.push(
          `${base(ctx)}/healthz reports ${version}${dnsNote(ctx)}`,
        );
        return undefined;
      }
      if (now() >= deadline) {
        // Still no address anywhere: a new host's DNS takes a while; the deploy itself is done.
        if (!version && problem && DNS_CODES.has(problem))
          throw new Error(
            `DNS for ${ctx.opts.host} is still propagating (${problem} after 3 minutes); the deploy is done: wait a few minutes and rerun the same command`,
          );
        throw new Error(
          `${base(ctx)}/healthz did not report ${expected} within 3 minutes (last: ${version ?? problem}); check the custom domain in the Cloudflare dashboard, then rerun`,
        );
      }
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
    const res = await hostFetch(ctx, `${base(ctx)}/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ machine_label: "open-bus-setup-selftest" }),
      // A redirect is not this Worker answering; never follow it (I8-05).
      redirect: "manual",
      signal: timeout(),
    });
    // B4 answers 201 Created; any other status is a broken device flow.
    if (res.status !== 201)
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
