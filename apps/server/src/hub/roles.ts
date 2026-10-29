/**
 * Owner-assigned role labels (agent card, AC2a). A role lives in the agent
 * name space of its namespace: it compares case-insensitively (lrole =
 * lower(role), as names compare on lower(name)), it can never equal an open
 * agent's name there, and an agent proposing a role's name gets a suffix
 * (roleTaken). A send to a role resolves to its holder (resolveRole) before
 * name resolution runs. Each agent holds at most one role. Every close
 * vacates the closed agents' roles (vacateRoles), so a reopened session, which
 * reuses its agent id, never regains one.
 *
 * agent_up also vacates a holder that reopens, moves namespace or changes
 * global (do.ts agentUp). HOLDER_SQL (open, and in the role's namespace or
 * global) is a second guard only.
 */
import { LIMITS, OWNER_ORG_ID, type RefusalReason } from "@ob/shared";
import { AGENT_COLS, type AgentRow } from "./rows.js";

export type Resolution =
  | { ok: true; agent: AgentRow }
  | { ok: false; reason: RefusalReason };

export type SetRoleResult =
  | "ok"
  | "bad_agent"
  | "name_taken"
  | "agent_has_role"
  | "full";

export type RoleRow = {
  namespace: string;
  role: string;
  agentId: string | null;
  setAt: number;
  /** The holder's bus name while it holds the role (HOLDER_SQL), else null. */
  holderName: string | null;
};

type Row = Record<string, SqlStorageValue>;
const all = <T extends Row>(
  sql: SqlStorage,
  q: string,
  ...b: SqlStorageValue[]
): T[] => sql.exec<T>(q, ...b).toArray();
const one = <T extends Row>(
  sql: SqlStorage,
  q: string,
  ...b: SqlStorageValue[]
): T | null => all<T>(sql, q, ...b)[0] ?? null;

/** Joins `a` (agents) to `r` (roles) on a holder that still holds the role. */
const HOLDER_SQL =
  "a.id = r.agent_id and a.live = 1 and (a.namespace = r.namespace or a.global = 1)";

/**
 * True when `lname` (lowercased) is a role an agent may not take as its name:
 * a role in `namespace`, or for a global agent (visible everywhere) a role in
 * any namespace. A vacant role still reserves its name.
 */
export function roleTaken(
  sql: SqlStorage,
  namespace: string,
  lname: string,
  global: boolean,
): boolean {
  return global
    ? one(
        sql,
        "select 1 as x from roles indexed by roles_lrole where org_id = ? and lrole = ? limit 1",
        OWNER_ORG_ID,
        lname,
      ) !== null
    : one(
        sql,
        "select 1 as x from roles where org_id = ? and namespace = ? and lrole = ?",
        OWNER_ORG_ID,
        namespace,
        lname,
      ) !== null;
}

/** Clears the holder of every role held by `agentIds` (a close). */
export function vacateRoles(sql: SqlStorage, agentIds: string[]): void {
  if (agentIds.length === 0) return;
  sql.exec(
    "update roles set agent_id = null where agent_id in (select value from json_each(?))",
    JSON.stringify(agentIds),
  );
}

/**
 * Points role `role` in `ns` at `agentId`, creating it if needed.
 * - bad_agent: the agent is not open, or neither in `ns` nor global.
 * - name_taken: an open agent visible in `ns` (in it, or global) has the
 *   role's name, in any case.
 * - agent_has_role: the agent holds another role.
 * - full: LIMITS.maxRoles roles exist and this would add one (re-pointing an
 *   existing role is never refused for it).
 * The stored display name follows the latest call.
 */
export function setRole(
  sql: SqlStorage,
  ns: string,
  role: string,
  agentId: string,
  now: number,
): SetRoleResult {
  const lrole = role.toLowerCase();
  const agent = one<{ namespace: string; global: number }>(
    sql,
    "select namespace, global from agents where id = ? and org_id = ? and live = 1",
    agentId,
    OWNER_ORG_ID,
  );
  if (agent === null || (agent.global !== 1 && agent.namespace !== ns))
    return "bad_agent";
  if (
    one(
      sql,
      "select 1 as x from agents where org_id = ? and lower(name) = ? and live = 1 and (namespace = ? or global = 1) limit 1",
      OWNER_ORG_ID,
      lrole,
      ns,
    ) !== null
  )
    return "name_taken";
  if (
    one(
      sql,
      "select 1 as x from roles where agent_id = ? and not (org_id = ? and namespace = ? and lrole = ?) limit 1",
      agentId,
      OWNER_ORG_ID,
      ns,
      lrole,
    ) !== null
  )
    return "agent_has_role";
  const exists =
    one(
      sql,
      "select 1 as x from roles where org_id = ? and namespace = ? and lrole = ?",
      OWNER_ORG_ID,
      ns,
      lrole,
    ) !== null;
  if (
    !exists &&
    (one<{ n: number }>(
      sql,
      "select count(*) as n from roles where org_id = ?",
      OWNER_ORG_ID,
    )?.n ?? 0) >= LIMITS.maxRoles
  )
    return "full";
  sql.exec(
    `insert into roles (org_id, namespace, role, lrole, agent_id, set_at) values (?, ?, ?, ?, ?, ?)
     on conflict (org_id, namespace, lrole) do update set role = excluded.role, agent_id = excluded.agent_id, set_at = excluded.set_at`,
    OWNER_ORG_ID,
    ns,
    role,
    lrole,
    agentId,
    now,
  );
  return "ok";
}

/** Removes role `role` (any case) from `ns`; false when there was none. */
export function deleteRole(sql: SqlStorage, ns: string, role: string): boolean {
  return (
    sql.exec(
      "delete from roles where org_id = ? and namespace = ? and lrole = ?",
      OWNER_ORG_ID,
      ns,
      role.toLowerCase(),
    ).rowsWritten > 0
  );
}

/** Every role (at most LIMITS.maxRoles), with its holder's name while it holds it. */
export function listRoles(sql: SqlStorage): RoleRow[] {
  return all<RoleRow>(
    sql,
    `select r.namespace, r.role, r.agent_id as agentId, r.set_at as setAt, a.name as holderName
       from roles r left join agents a on ${HOLDER_SQL}
      where r.org_id = ? order by r.namespace, r.lrole limit ?`,
    OWNER_ORG_ID,
    LIMITS.maxRoles,
  );
}

/**
 * The role each of `agentIds` holds, for a roster row: only roles the viewer
 * can resolve (its own namespace's; every namespace for a global viewer,
 * `viewerNs` null), and only while the agent still holds it (HOLDER_SQL).
 */
export function rolesOf(
  sql: SqlStorage,
  agentIds: string[],
  viewerNs: string | null,
): Map<string, string> {
  if (agentIds.length === 0) return new Map();
  const rows = all<{ agentId: string; role: string }>(
    sql,
    `select r.agent_id as agentId, r.role from roles r indexed by roles_agent join agents a on ${HOLDER_SQL}
      where r.agent_id in (select value from json_each(?)) and r.org_id = ?${viewerNs === null ? "" : " and r.namespace = ?"}`,
    JSON.stringify(agentIds),
    OWNER_ORG_ID,
    ...(viewerNs === null ? [] : [viewerNs]),
  );
  return new Map(rows.map((r) => [r.agentId, r.role]));
}

/** Role `lrole` in `ns` resolved: its holder, or role_vacant. */
function holderOf(sql: SqlStorage, ns: string, lrole: string): Resolution {
  const agent = one<AgentRow>(
    sql,
    `select ${AGENT_COLS} from agents where id =
       (select r.agent_id from roles r where r.org_id = ? and r.namespace = ? and r.lrole = ?)
       and live = 1 and (namespace = ? or global = 1)`,
    OWNER_ORG_ID,
    ns,
    lrole,
    ns,
  );
  return agent ? { ok: true, agent } : { ok: false, reason: "role_vacant" };
}

/**
 * A send's target when `lname` names a role the sender can reach, else null
 * (name resolution runs). Scoped as names are: a non-global sender reaches
 * its own namespace's roles only (an explicit other `to_namespace` is left to
 * name resolution, which answers other_namespace); a global sender reaches
 * `toNamespace`'s, or every namespace's, where a role in two namespaces, or a
 * role in one and an open agent with that name in another, is ambiguous.
 */
export function resolveRole(
  sql: SqlStorage,
  sender: AgentRow,
  lname: string,
  toNamespace: string | undefined,
): Resolution | null {
  let scope: string | undefined = toNamespace;
  if (sender.global !== 1) {
    if (toNamespace !== undefined && toNamespace !== sender.namespace)
      return null;
    scope = sender.namespace;
  }
  if (scope !== undefined)
    return one(
      sql,
      "select 1 as x from roles where org_id = ? and namespace = ? and lrole = ?",
      OWNER_ORG_ID,
      scope,
      lname,
    ) === null
      ? null
      : holderOf(sql, scope, lname);
  const hits = all<{ namespace: string }>(
    sql,
    "select namespace from roles indexed by roles_lrole where org_id = ? and lrole = ? limit 2",
    OWNER_ORG_ID,
    lname,
  );
  const hit = hits[0];
  if (hit === undefined) return null;
  if (
    hits.length > 1 ||
    one(
      sql,
      "select 1 as x from agents where org_id = ? and lower(name) = ? and live = 1 and namespace != ? limit 1",
      OWNER_ORG_ID,
      lname,
      hit.namespace,
    ) !== null
  )
    return { ok: false, reason: "ambiguous" };
  return holderOf(sql, hit.namespace, lname);
}
