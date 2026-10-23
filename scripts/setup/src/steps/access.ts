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
/** A rotation's replacement, before its rename: left over when a run dies mid-rotation. */
export const ROTATING_NAME = (name: string) => `${APP_NAME(name)} (rotating)`;
export const POLICY_NAME = "OpenBus owner";
/** One owner policy per instance, so instances with different owners never share it. */
export const policyName = (name: string) => `${POLICY_NAME} (${name})`;
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
  /** Rotating-form apps other than `app`: deleted by apply. */
  leftovers: Obj[];
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
  name: policyName(ctx.opts.name),
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
/** What an adopted app lacks: empty when it matches this run. */
function appDrift(app: Obj, policyId: string | undefined, ctx: Ctx) {
  const uris: unknown = app.saas_app?.redirect_uris;
  const out: string[] = [];
  if (app.name !== APP_NAME(ctx.opts.name))
    out.push(
      `named ${JSON.stringify(app.name)}, not ${APP_NAME(ctx.opts.name)}`,
    );
  if (!(Array.isArray(uris) && uris.length === 1 && uris[0] === callback(ctx)))
    out.push(`redirect URI is not ${callback(ctx)}`);
  const scopes: unknown[] = app.saas_app?.scopes ?? [];
  if (!SCOPES.every((s) => scopes.includes(s)))
    out.push(`scopes lack ${SCOPES.join(" ")}`);
  if (app.saas_app?.allow_pkce_without_client_secret !== false)
    out.push("allow_pkce_without_client_secret is not false");
  // Exactly the owner policy: any other linked policy could admit someone else.
  const ids = (app.policies ?? []).map((p: Obj) => p.id);
  if (!(policyId && ids.length === 1 && ids[0] === policyId))
    out.push(`policies are not exactly "${policyName(ctx.opts.name)}"`);
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
export function useToken(ctx: Ctx): boolean {
  if (ctx.deps.env.OB_ACCESS_TOKEN?.trim() || ctx.accessToken) return true;
  const t = readTokenFile(ctx.fs, tokenPath(ctx));
  if (!t) return false;
  ctx.accessToken = t;
  ctx.accessApi = makeApi(ctx.deps, ctx.wrangler, t);
  return true;
}

/** How the user hands setup the token without it entering a chat. */
export function askToken(
  ctx: Ctx,
  accountId: string,
  why: string,
): ActionRequired {
  const t = token(ctx);
  const url = linkFor(t, { accountId });
  const labels = t.permissions.map((p) => p.label).join(", ");
  return AR(
    `${why} Ask the user to create a Cloudflare API token (${labels}) at ${url}, then save it by running saveCommand in their own terminal (in Claude Code, type \`! \` then the line); it lands in ~/${t.file} (or set ${t.env}). Then rerun setup.`,
    { url, saveCommand: t.saveCommand, file: `~/${t.file}` },
  );
}

/**
 * The team domain from the organization; the app by its saved id, else by
 * name; the owner policy through the app, else by name (an orphan from a
 * failed run).
 */
async function lookup(ctx: Ctx, state: State): Promise<Lookup> {
  const a = `/accounts/${state.accountId ?? ""}/access`;
  // A 404 or a null result both mean "no Zero Trust organization".
  const org = await ctx
    .accessApi<{ auth_domain?: string } | null>("GET", `${a}/organizations`)
    .catch((e) => {
      if (status(e) === 404) return null;
      throw e;
    });
  const apps = await ctx.accessApi.all<Obj>(`${a}/apps`);
  const name = APP_NAME(ctx.opts.name);
  const rotating = apps.filter((x) => x.name === ROTATING_NAME(ctx.opts.name));
  // The saved id counts only while the app still carries one of our names.
  let app = state.accessAppId
    ? apps.find(
        (x) =>
          x.id === state.accessAppId &&
          (x.name === name || x.name === ROTATING_NAME(ctx.opts.name)),
      )
    : undefined;
  if (!app) {
    const named = apps.filter((x) => x.name === name);
    if (named.length > 1)
      throw new NeedInput(
        `${named.length} Access apps are named ${name}: ${named.map((x) => x.id).join(", ")}. Delete all but one in Zero Trust > Access > Applications, then rerun.`,
      );
    // A rotation that died before its rename: adopt the replacement.
    app = named[0] ?? rotating[0];
  }
  const leftovers = rotating.filter((x) => x.id !== app?.id);
  const pname = policyName(ctx.opts.name);
  const mine = (await ctx.accessApi.all<Obj>(`${a}/policies`)).filter(
    (p) => p.name === pname,
  );
  const linkedIds = new Set((app?.policies ?? []).map((p: Obj) => p.id));
  const policy = mine.find((p) => linkedIds.has(p.id)) ?? mine[0];
  return {
    a,
    domain: org?.auth_domain?.toLowerCase() || undefined,
    policy,
    app,
    leftovers,
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

/** saas_app from the fields setup owns only; existing scopes and grants are kept. */
const saasApp = (ctx: Ctx, prev?: Obj) => ({
  auth_type: "oidc",
  redirect_uris: [callback(ctx)],
  grant_types: [
    ...new Set([...(prev?.grant_types ?? []), "authorization_code_with_pkce"]),
  ],
  scopes: [...new Set([...(prev?.scopes ?? []), ...SCOPES])],
  allow_pkce_without_client_secret: false,
});

/** POSTs the app; its client secret goes to ctx.secrets only. */
async function create(
  ctx: Ctx,
  l: Lookup,
  policyId: string,
  name = APP_NAME(ctx.opts.name),
) {
  const created = await ctx
    .accessApi<Obj>("POST", `${l.a}/apps`, {
      name,
      type: "saas",
      policies: [{ id: policyId, precedence: 1 }],
      saas_app: saasApp(ctx),
    })
    .catch(writeScope("POST Access app"));
  const secret = created?.saas_app?.client_secret;
  if (typeof secret !== "string" || !secret || !created.saas_app.client_id)
    throw new Error(
      `Access app ${created?.id} create response lacks saas_app.client_secret or client_id; delete it in Zero Trust > Access > Applications, then rerun`,
    );
  ctx.secrets = { ...ctx.secrets, [ACCESS_SECRET]: secret };
  const { client_secret: _, ...saas } = created.saas_app;
  return { ...created, saas_app: saas };
}

/**
 * PUTs an app with only the fields setup owns: name, type, domain, the owner
 * policy alone, and saas_app with this run's redirect and scopes. Never the
 * client secret.
 */
async function update(ctx: Ctx, l: Lookup, app: Obj, policyId: string) {
  const body = {
    name: APP_NAME(ctx.opts.name),
    type: "saas",
    ...(app.domain ? { domain: app.domain } : {}),
    policies: [{ id: policyId, precedence: 1 }],
    saas_app: saasApp(ctx, app.saas_app),
  };
  const res = await ctx
    .accessApi<Obj>("PUT", `${l.a}/apps/${app.id}`, body)
    .catch(writeScope("PUT Access app"));
  // The client id never changes on a PUT; keep it when the response omits it.
  return res?.saas_app?.client_id
    ? res
    : {
        ...body,
        id: app.id,
        saas_app: { ...body.saas_app, client_id: app.saas_app?.client_id },
      };
}

/** DELETEs an app; one already gone (404) counts as deleted. */
async function deleteApp(ctx: Ctx, l: Lookup, id: string) {
  await ctx.accessApi("DELETE", `${l.a}/apps/${id}`).catch((e) => {
    if (status(e) !== 404) writeScope("DELETE Access app")(e);
  });
}

/**
 * A new client secret for an adopted app (Access has no rotate for SaaS
 * apps): create the replacement under a temporary name, delete the old app,
 * then rename the replacement. The old app is never deleted first.
 */
async function rotate(
  state: State,
  ctx: Ctx,
  l: Lookup,
  old: Obj,
  policyId: string,
) {
  const fresh = await create(ctx, l, policyId, ROTATING_NAME(ctx.opts.name));
  try {
    await deleteApp(ctx, l, old.id);
  } catch (e) {
    // Keep the old app working: undo the replacement and drop its secret.
    delete ctx.secrets?.[ACCESS_SECRET];
    await ctx.accessApi("DELETE", `${l.a}/apps/${fresh.id}`).catch(() => {
      (e as Error).message +=
        `; also could not delete the replacement ${fresh.id}, delete it in Zero Trust > Access > Applications`;
    });
    throw e;
  }
  // Saved before the rename: a failed rename is adopted by id next run.
  record(state, ctx, l.domain as string, fresh);
  ctx.notes.push(
    `${ACCESS_SECRET} was missing on the Worker: replaced the app (new client id)`,
  );
  return update(ctx, l, fresh, policyId);
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
      l = await lookup(ctx, state);
    } catch (e) {
      if (status(e) !== 403) throw e;
      ctx.notes.push("the Access token cannot read Access (403)");
      return "todo";
    }
    const why = !l.domain
      ? "no Zero Trust organization"
      : !l.policy || !policyMatches(l.policy, ctx)
        ? `policy "${policyName(ctx.opts.name)}" missing or not just ${ctx.opts.ownerEmail}`
        : !l.app
          ? `Access app ${APP_NAME(ctx.opts.name)} not found`
          : !isOidc(l.app)
            ? `Access app ${APP_NAME(ctx.opts.name)} is not SaaS OIDC`
            : appDrift(l.app, l.policy.id, ctx).join("; ") ||
              (!l.app.saas_app.client_id
                ? "Access app has no client_id"
                : (await secretState(ctx)) === "missing"
                  ? `${ACCESS_SECRET} missing on the Worker`
                  : l.leftovers.length
                    ? `leftover ${ROTATING_NAME(ctx.opts.name)} app`
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
      l = await lookup(ctx, state);
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

    // An adopted app's secret is unreadable: replace the app only when
    // neither memory nor the Worker has it.
    if (!app) {
      app = await create(ctx, l, policyId);
      wrote = true;
    } else if ((await secretState(ctx)) === "missing") {
      app = await rotate(state, ctx, l, app, policyId);
      wrote = true;
    } else if (appDrift(app, policyId, ctx).length) {
      app = await update(ctx, l, app, policyId);
      wrote = true;
    }
    // Rotation leftovers, once the adopted app is settled.
    for (const x of l.leftovers) {
      await deleteApp(ctx, l, x.id);
      wrote = true;
    }
    record(state, ctx, l.domain, app);
    ctx.skipped = !wrote;
    return undefined;
  },
};
