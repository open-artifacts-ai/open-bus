/**
 * The agent card (AC4c): `card_request` from an attested agent, signed by the
 * hub. do.ts runs the first two checks (the AGENT_CARD_MIN_CLIENT gate, then
 * the from_ref attestation); issueCard runs the rest in the fixed order:
 * nonce (bad_nonce), linked and canonical aud (not_linked), the per-agent
 * rate limit (rate_limited), then, asynchronously, the keys (null: `error
 * internal`). Every synchronous step, including the rate-limit count and the
 * claims snapshot (role, applied status), runs before the first await.
 */
import {
  AgentRefSchema,
  CARD_TTL_SEC,
  CARD_TYP,
  CARDS_PER_MINUTE,
  type CardClaims,
  CardClaimsSchema,
  type CardRefusalCode,
  NonceSchema,
} from "@ob/shared";
import { z } from "zod";
import { loadCardKeys, ownerId, signJws } from "../card/keys.js";
import { parseOrigin } from "../card/origin.js";
import type { Env } from "../env.js";
import { isLinked } from "./linked-apps.js";
import { rolesOf } from "./roles.js";
import type { AgentRow } from "./rows.js";
import { statusFields } from "./status.js";

/** The rate-limit window: CARDS_PER_MINUTE requests per agent. */
export const CARD_WINDOW_MS = 60_000;

/** Housekeeping: rows whose window has ended (with `now - CARD_WINDOW_MS`, then the batch). */
export const CARD_RL_PURGE_SQL =
  "delete from card_rl where rowid in (select rowid from card_rl where window_start <= ? limit ?) returning rowid";

export type CardRequest = {
  v: 1;
  id: string;
  type: "card_request";
  from_ref: string;
  aud: string;
  nonce: string;
};

/**
 * The shared frame schema already requires a valid nonce and an exact
 * origin, so such a frame never decodes. This lax shape (any short nonce or
 * aud) lets the hub answer it `card_refused bad_nonce` / `not_linked`, as the
 * spec says, instead of `bad_frame`. Used only after decodeClientFrame
 * rejected a frame it could read an id from.
 */
const LaxCardRequest = z.strictObject({
  v: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  type: z.literal("card_request"),
  from_ref: AgentRefSchema,
  aud: z.string().max(512),
  nonce: z.string().max(512),
});

export function laxCardRequest(raw: string): CardRequest | null {
  try {
    const r = LaxCardRequest.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Counts one request against `agentId`'s window; false when it is full (nothing counted). */
function takeCard(sql: SqlStorage, agentId: string, now: number): boolean {
  const row = sql
    .exec<{ w: number; n: number }>(
      "select window_start as w, n from card_rl where agent_id = ?",
      agentId,
    )
    .toArray()[0];
  if (row && now - row.w < CARD_WINDOW_MS) {
    if (row.n >= CARDS_PER_MINUTE) return false;
    sql.exec("update card_rl set n = n + 1 where agent_id = ?", agentId);
    return true;
  }
  sql.exec(
    "insert into card_rl (agent_id, window_start, n) values (?, ?, 1) on conflict(agent_id) do update set window_start = excluded.window_start, n = 1",
    agentId,
    now,
  );
  return true;
}

const b64url = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

type CardEnv = Parameters<typeof loadCardKeys>[0] & Pick<Env, "APP_HOST">;

/**
 * Checks 3 to 5 (synchronous), then the signing: a refusal code, or a
 * promise of the compact JWS (null: no usable keys, a test key outside dev
 * or any signing error; the caller answers `error internal`). Never rejects.
 */
export function issueCard(
  sql: SqlStorage,
  env: CardEnv,
  agent: AgentRow,
  machineLabel: string,
  f: CardRequest,
  now: number,
): { code: CardRefusalCode } | { jwt: Promise<string | null> } {
  if (!NonceSchema.safeParse(f.nonce).success) return { code: "bad_nonce" };
  if (parseOrigin(f.aud, env) !== f.aud || !isLinked(sql, f.aud))
    return { code: "not_linked" };
  if (!takeCard(sql, agent.id, now)) return { code: "rate_limited" };

  const iat = Math.floor(now / 1000);
  const role = rolesOf(sql, [agent.id], null).get(agent.id);
  const st = statusFields(agent);
  const claims: Omit<CardClaims, "owner"> = {
    iss: `https://${env.APP_HOST}`,
    aud: f.aud,
    sub: agent.id,
    nonce: f.nonce,
    iat,
    exp: iat + CARD_TTL_SEC,
    jti: b64url(crypto.getRandomValues(new Uint8Array(16))),
    name: agent.name,
    ...(role === undefined ? {} : { role }),
    kind: agent.kind,
    machine: machineLabel,
    ...(st.status === undefined
      ? {}
      : {
          agent_says: {
            status: st.status,
            ...(st.statusLabel === undefined ? {} : { label: st.statusLabel }),
          },
        }),
  };
  const sign = async (): Promise<string | null> => {
    const keys = await loadCardKeys(env);
    if (!keys) return null;
    const full = CardClaimsSchema.parse({
      ...claims,
      owner: await ownerId(keys.ownerSalt, f.aud),
    });
    return signJws(keys, CARD_TYP, full);
  };
  return { jwt: sign().catch(() => null) };
}
