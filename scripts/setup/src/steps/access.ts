import { join } from "node:path";
import { makeApi } from "../cf.ts";
import { homeOf, type State } from "../state.ts";
import {
  type ActionRequired,
  type Ctx,
  NeedInput,
  type Step,
} from "../step.ts";
import { readTokenFile } from "../token-files.ts";
import { linkFor, tokenById } from "../tokens.ts";

// Cut from Open Artifacts' access step: one owner, one host, no team policies.
export const APP_NAME = (name: string) => `OpenBus (${name})`;
export const POLICY_NAME = "OpenBus owner";
export const ACCESS_SECRET = "ACCESS_CLIENT_SECRET";
const SCOPES = ["openid", "email", "profile"];
const ZERO_TRUST = "https://one.dash.cloudflare.com/";
/** Policy fields kept across a reconcile (dashboard edits). */
const CARRY_OVER = ["session_duration"] as const;

// biome-ignore lint/suspicious/noExplicitAny: untyped API objects
type Obj = any;
type Lookup = {
  a: string;
  domain?: string;
  policy?: Obj;
  app?: Obj;
};

const AR = (message: string, data?: unknown): ActionRequired => ({
  status: "action_required",
  message,
  data,
});
const status = (e: unknown) => (e as { status?: number }).status;
const empty = (x: unknown) => x == null || (Array.isArray(x) && x.length === 0);
const callback = (ctx: Ctx) => `https://${ctx.opts.host}/auth/callback`;
const token = (ctx: Ctx) => tokenById("access", { name: ctx.opts.name });
const tokenPath = (ctx: Ctx) => join(homeOf(ctx.deps.env), token(ctx).file);

const policyBody = (ctx: Ctx) => ({
  name: POLICY_NAME,
  decision: "allow",
  include: [{ email: { email: ctx.opts.ownerEmail } }],
  exclude: [],
  require: [],
});
const policyMatches = (p: Obj, ctx: Ctx) =>
  p.decision === "allow" &&
  Array.isArray(p.include) &&
  p.include.length === 1 &&
  String(p.include[0]?.email?.email ?? "").toLowerCase() ===
    ctx.opts.ownerEmail &&
  Object.keys(p.include[0]).length === 1 &&
  empty(p.exclude) &&
  empty(p.require);

const isOidc = (app: Obj) =>
  app.type === "saas" && app.saas_app?.auth_type === "oidc";
const linked = (app: Obj, policyId?: string) =>
  Boolean(policyId) &&
  Boolean(app.policies?.some((p: Obj) => p.id === policyId));
/** What an adopted app lacks: empty when it matches this run. */
function appDrift(app: Obj, policyId: string | undefined, ctx: Ctx) {
  const uris: unknown = app.saas_app?.redirect_uris;
  const out: string[] = [];
  if (!(Array.isArray(uris) && uris.length === 1 && uris[0] === callback(ctx)))
    out.push(`redirect URI is not ${callback(ctx)}`);
  const scopes: unknown[] = app.saas_app?.scopes ?? [];
  if (!SCOPES.every((s) => scopes.includes(s)))
    out.push(`scopes lack ${SCOPES.join(" ")}`);
  if (!linked(app, policyId)) out.push(`not linked to "${POLICY_NAME}"`);
  return out;
}

/**
 * Where the client secret is: in memory (created this run), on the Worker, or
 * missing. Without I3's Worker check it counts as on the Worker: never rotate blind.
 */
export async function secretState(
  ctx: Ctx,
): Promise<"memory" | "worker" | "missing"> {
  if (ctx.secrets?.[ACCESS_SECRET]) return "memory";
  if (!ctx.workerSecretNames) return "worker";
  return (await ctx.workerSecretNames()).includes(ACCESS_SECRET)
    ? "worker"
    : "missing";
}

/** OB_ACCESS_TOKEN, else `~/.openbus/<name>-access-token`: false when neither exists. */
function useToken(ctx: Ctx): boolean {
  if (ctx.deps.env.OB_ACCESS_TOKEN?.trim() || ctx.accessToken) return true;
  const t = readTokenFile(ctx.fs, tokenPath(ctx));
  if (!t) return false;
  ctx.accessToken = t;
  ctx.accessApi = makeApi(ctx.deps, ctx.wrangler, t);
  return true;
}

/** How the user hands setup the token without it entering a chat. */
function askToken(ctx: Ctx, accountId: string, why: string): ActionRequired {
  const t = token(ctx);
  const url = linkFor(t, { accountId });
  const labels = t.permissions.map((p) => p.label).join(", ");
  return AR(
    `${why} Ask the user to create a Cloudflare API token (${labels}) at ${url}, then save it by running saveCommand in their own terminal (in Claude Code, type \`! \` then the line); it lands in ~/${t.file} (or set ${t.env}). Then rerun setup.`,
    { url, saveCommand: t.saveCommand, file: `~/${t.file}` },
  );
}

/** The team domain from the organization, the policy and the app, by name. */
async function lookup(ctx: Ctx, accountId: string): Promise<Lookup> {
  const a = `/accounts/${accountId}/access`;
  // A 404 or a null result both mean "no Zero Trust organization".
  const org = await ctx
    .accessApi<{ auth_domain?: string } | null>("GET", `${a}/organizations`)
    .catch((e) => {
      if (status(e) === 404) return null;
      throw e;
    });
  const policy = (await ctx.accessApi.all<Obj>(`${a}/policies`)).find(
    (p) => p.name === POLICY_NAME,
  );
  const name = APP_NAME(ctx.opts.name);
  const named = (await ctx.accessApi.all<Obj>(`${a}/apps`)).filter(
    (x) => x.name === name,
  );
  if (named.length > 1)
    throw new NeedInput(
      `${named.length} Access apps are named ${name}: ${named.map((x) => x.id).join(", ")}. Delete all but one in Zero Trust > Access > Applications, then rerun.`,
    );
  return {
    a,
    domain: org?.auth_domain?.toLowerCase() || undefined,
    policy,
    app: named[0],
  };
}

/** State keeps ids only; the client secret stays in ctx.secrets. */
function record(state: State, ctx: Ctx, teamDomain: string, app: Obj) {
  Object.assign(state, {
    teamDomain,
    accessAppId: app.id,
    accessClientId: app.saas_app.client_id,
  });
  ctx.data = { teamDomain, clientId: app.saas_app.client_id, appId: app.id };
}

/** An Access write answered 403: the token lacks Apps and Policies: Edit. */
const writeScope = (what: string) => (e: unknown) => {
  if (status(e) !== 403) throw e;
  throw new NeedInput(
    `${what}: 403, the Access token cannot write Access; it needs Access: Apps and Policies: Edit`,
  );
};

async function create(state: State, ctx: Ctx, l: Lookup, policyId: string) {
  const created = await ctx
    .accessApi<Obj>("POST", `${l.a}/apps`, {
      name: APP_NAME(ctx.opts.name),
      type: "saas",
      policies: [{ id: policyId, precedence: 1 }],
      saas_app: {
        auth_type: "oidc",
        redirect_uris: [callback(ctx)],
        grant_types: ["authorization_code_with_pkce"],
        allow_pkce_without_client_secret: false,
        scopes: SCOPES,
      },
    })
    .catch(writeScope("POST Access app"));
  const secret = created?.saas_app?.client_secret;
  if (typeof secret !== "string" || !secret || !created.saas_app.client_id)
    throw new Error(
      `Access app ${created?.id} create response lacks saas_app.client_secret or client_id; delete it in Zero Trust > Access > Applications, then rerun`,
    );
  ctx.secrets = { ...ctx.secrets, [ACCESS_SECRET]: secret };
  record(state, ctx, l.domain as string, created);
}

/** Updates an adopted app in place: the GET object, minus read-only fields, with this run's redirect, scopes and policy. */
async function update(ctx: Ctx, l: Lookup, app: Obj, policyId: string) {
  const { id, created_at, updated_at, aud, ...rest } = app;
  const policies = (app.policies ?? []).map((p: Obj, i: number) => ({
    id: p.id,
    precedence: p.precedence ?? i + 1,
  }));
  if (!linked(app, policyId))
    policies.push({ id: policyId, precedence: policies.length + 1 });
  const scopes = [...new Set([...(app.saas_app.scopes ?? []), ...SCOPES])];
  const body = {
    ...rest,
    policies,
    saas_app: {
      ...app.saas_app,
      redirect_uris: [callback(ctx)],
      scopes,
    },
  };
  const res = await ctx
    .accessApi<Obj>("PUT", `${l.a}/apps/${id}`, body)
    .catch(writeScope("PUT Access app"));
  return res?.saas_app?.client_id ? res : { ...body, id };
}

export const access: Step = {
  name: "access",
  async check(state, ctx) {
    if (!useToken(ctx)) {
      ctx.notes.push(
        `no Access token (~/${token(ctx).file} or OB_ACCESS_TOKEN)`,
      );
      return "todo";
    }
    let l: Lookup;
    try {
      l = await lookup(ctx, state.accountId ?? "");
    } catch (e) {
      if (status(e) !== 403) throw e;
      ctx.notes.push("the Access token cannot read Access (403)");
      return "todo";
    }
    const why = !l.domain
      ? "no Zero Trust organization"
      : !l.policy || !policyMatches(l.policy, ctx)
        ? `policy "${POLICY_NAME}" missing or not just ${ctx.opts.ownerEmail}`
        : !l.app
          ? `Access app ${APP_NAME(ctx.opts.name)} not found`
          : !isOidc(l.app)
            ? `Access app ${APP_NAME(ctx.opts.name)} is not SaaS OIDC`
            : appDrift(l.app, l.policy.id, ctx).join("; ") ||
              (!l.app.saas_app.client_id
                ? "Access app has no client_id"
                : (await secretState(ctx)) === "missing"
                  ? `${ACCESS_SECRET} missing on the Worker`
                  : undefined);
    if (why) {
      ctx.notes.push(why);
      return "todo";
    }
    record(state, ctx, l.domain as string, l.app);
    return "done";
  },
  async apply(state, ctx) {
    const accountId = state.accountId ?? "";
    if (!useToken(ctx))
      return askToken(
        ctx,
        accountId,
        "Setup needs a Cloudflare Access token: `wrangler login` cannot edit Access.",
      );
    let l: Lookup;
    try {
      l = await lookup(ctx, accountId);
    } catch (e) {
      if (status(e) !== 403) throw e;
      return askToken(
        ctx,
        accountId,
        "The Access token cannot read Access (403).",
      );
    }
    if (!l.domain)
      return AR(
        `No Zero Trust organization on this account: ask the user to open ${ZERO_TRUST}, enable Zero Trust (free), then rerun.`,
        { url: ZERO_TRUST },
      );
    let app = l.app;
    const where = `Zero Trust > Access > Applications > ${APP_NAME(ctx.opts.name)}`;
    if (app && !isOidc(app))
      return AR(
        `Access app ${APP_NAME(ctx.opts.name)} exists but is not a SaaS OIDC app. Rename or delete it (${where}), then rerun.`,
      );
    if (app && !app.saas_app?.client_id)
      throw new Error(`Access app ${app.name} has no saas_app.client_id`);

    let wrote = false;
    let policyId: string | undefined = l.policy?.id;
    if (!l.policy) {
      policyId = (
        await ctx
          .accessApi<Obj>("POST", `${l.a}/policies`, policyBody(ctx))
          .catch(writeScope("POST Access policy"))
      ).id;
      wrote = true;
    } else if (!policyMatches(l.policy, ctx)) {
      const kept = Object.fromEntries(
        CARRY_OVER.filter((k) => l.policy[k] !== undefined).map((k) => [
          k,
          l.policy[k],
        ]),
      );
      await ctx
        .accessApi("PUT", `${l.a}/policies/${policyId}`, {
          ...kept,
          ...policyBody(ctx),
        })
        .catch(writeScope("PUT Access policy"));
      wrote = true;
    }
    if (!policyId) throw new Error("Access policy create returned no id");

    // An adopted app's secret is unreadable: when neither memory nor the
    // Worker has it, recreate the app (Access has no rotate for SaaS apps).
    if (app && (await secretState(ctx)) === "missing") {
      await ctx
        .accessApi("DELETE", `${l.a}/apps/${app.id}`)
        .catch(writeScope("DELETE Access app"));
      ctx.notes.push(
        `${ACCESS_SECRET} was missing on the Worker: recreated the app (new client id)`,
      );
      app = undefined;
    }
    if (!app) {
      await create(state, ctx, l, policyId);
      return undefined;
    }
    if (appDrift(app, policyId, ctx).length) {
      app = await update(ctx, l, app, policyId);
      wrote = true;
    }
    record(state, ctx, l.domain, app);
    ctx.skipped = !wrote;
    return undefined;
  },
};
