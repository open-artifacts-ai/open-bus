import { DurableObject } from "cloudflare:workers";
import {
  type AgentUpFrame,
  type ClientFrame,
  candidateName,
  decodeClientFrame,
  encodeFrame,
  FALLBACK_BUS_NAME,
  frameId,
  isId,
  LIMITS,
  MachineLabelSchema,
  newId,
  newMachineToken,
  OWNER_ORG_ID,
  PING,
  PONG,
  REFUSAL_REASONS,
  type RefusalReason,
  type SendFrame,
  type ServerFrame,
  suffixName,
  utf8Bytes,
} from "@ob/shared";
import type { Env } from "../env.js";
import { version } from "../version.js";
import { sha256Hex } from "./hash.js";
import {
  AGENT_COLS,
  type AgentRow,
  MACHINE_COLS,
  type MachineRow,
  RECEIPT_COLS,
  type ReceiptRow,
} from "./rows.js";
import { HUB_SCHEMA, migrateHub } from "./schema.js";

const HOUR_MS = 3_600_000;
/** Consumed OIDC states are kept this long past expiry, then purged. */
const STATE_GRACE_MS = HOUR_MS;
/** Rows purged per consumeState call: bounded so one request stays cheap. */
const STATE_PURGE_BATCH = 100;
/** Longest OIDC state the hub stores; anything longer is refused. */
const MAX_STATE_CHARS = 256;
/** Furthest in the future an OIDC state may expire. */
const MAX_STATE_TTL_MS = HOUR_MS;
/** Active (unrevoked) machines per owner; equal to the list cap so every active one is listed. */
const MAX_ACTIVE_MACHINES = LIMITS.maxMachinesListed;
const SESSION_GEN_KEY = "session_gen";

type StoredMachine = Omit<MachineRow, "connected">;
type Row = Record<string, SqlStorageValue>;
type FetchFrame = Extract<ClientFrame, { type: "fetch" }>;

/**
 * createMachine's outcome. The cap is a result, not a thrown error, so the
 * code survives RPC (a thrown subclass arrives as a plain Error). B4 maps
 * `machine_limit` to a refusal.
 */
export type CreateMachineResult =
  | { ok: true; id: string; label: string; token: string }
  | { ok: false; code: "machine_limit" };

// Helpers are module-level, not class members: every method on the class
// prototype (TS `private`/`protected` included) is callable over RPC.

function all<T extends Row>(
  sql: SqlStorage,
  q: string,
  ...b: SqlStorageValue[]
): T[] {
  return sql.exec<T>(q, ...b).toArray();
}

function one<T extends Row>(
  sql: SqlStorage,
  q: string,
  ...b: SqlStorageValue[]
): T | null {
  return all<T>(sql, q, ...b)[0] ?? null;
}

/** True only while the hub holds a socket tagged with the machine id (B5). */
function withLiveness(ctx: DurableObjectState, m: StoredMachine): MachineRow {
  return {
    ...m,
    connected: m.revokedAt === null && ctx.getWebSockets(m.id).length > 0,
  };
}

/** The lookup revoke (B9) uses: an unknown or already-revoked machine is null (404). */
export function activeMachine(
  ctx: DurableObjectState,
  id: string,
): MachineRow | null {
  const m = one<StoredMachine>(
    ctx.storage.sql,
    `select ${MACHINE_COLS} from machines where id = ? and org_id = ? and revoked_at is null`,
    id,
    OWNER_ORG_ID,
  );
  return m && withLiveness(ctx, m);
}

/** The stored generation, or -1 (fail closed: no session matches) if corrupt. */
function readSessionGeneration(sql: SqlStorage): number {
  const row = one<{ value: string }>(
    sql,
    "select value from meta where org_id = ? and key = ?",
    OWNER_ORG_ID,
    SESSION_GEN_KEY,
  );
  if (!row) return 0;
  if (!/^\d+$/.test(row.value)) return -1;
  const n = Number(row.value);
  return Number.isSafeInteger(n) ? n : -1;
}

// ------------------------------------------------------------------ sockets
//
// Daemon sockets are tagged exactly ["daemon", machineId]: "daemon" for
// broadcasts, the machine id for B3's `connected` (withLiveness) and for the
// roster's live/queued state. Hibernation API only: no timers, no outbound
// sockets, and each message does a few indexed queries.

/**
 * Highest numeric suffix tried for a proposed name (then for the fallback
 * name). Equal to the roster cap, so the cap is reached before a name runs out.
 */
const MAX_NAME_SUFFIX = LIMITS.maxRosterAgents;
const DAEMON_TAG = "daemon";
const OPEN = 1; // WebSocket.READY_STATE_OPEN

type ErrorCode = Extract<ServerFrame, { type: "error" }>["code"];
/** `replaced`: a newer socket took over this machine; this one is dead. */
type Attachment = { machineId: string; replaced?: true };

function attachmentOf(ws: WebSocket): Attachment | null {
  const a = ws.deserializeAttachment() as Attachment | null;
  return typeof a?.machineId === "string" ? a : null;
}

function machineOf(ws: WebSocket): string | null {
  return attachmentOf(ws)?.machineId ?? null;
}

const isReplaced = (ws: WebSocket): boolean =>
  attachmentOf(ws)?.replaced === true;

function sendFrame(ws: WebSocket, frame: ServerFrame): void {
  try {
    ws.send(encodeFrame(frame));
  } catch {
    // The socket is closing; the daemon resyncs on reconnect.
  }
}

function sendError(
  ws: WebSocket,
  id: string | undefined,
  code: ErrorCode,
  message: string,
): void {
  sendFrame(ws, { v: 1, id: id ?? frameId(), type: "error", code, message });
}

function closeSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}

/** True while the machine holds an open, current socket other than `except`. */
function machineOnline(
  ctx: DurableObjectState,
  machineId: string,
  except?: WebSocket,
): boolean {
  return ctx
    .getWebSockets(machineId)
    .some((w) => w !== except && w.readyState === OPEN && !isReplaced(w));
}

/**
 * The machine's live socket: open and not replaced. A replaced socket is dead
 * and never receives mail.
 */
function liveSocket(
  ctx: DurableObjectState,
  machineId: string,
): WebSocket | null {
  return (
    ctx
      .getWebSockets(machineId)
      .find((w) => w.readyState === OPEN && !isReplaced(w)) ?? null
  );
}

/**
 * For each machine id that should hear about `changed`, the namespaces it
 * should hear: those where it hosts a live agent, or all of them when it
 * hosts any live global agent (a global sees every namespace).
 *
 * Bounded by the smaller side: one indexed query per changed namespace, or
 * one per connected machine when there are fewer machines than namespaces.
 */
function rosterAudience(
  sql: SqlStorage,
  changed: string[],
  machines: string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const all_ = (m: string) => out.set(m, changed);
  for (const r of all<{ machineId: string }>(
    sql,
    "select distinct machine_id as machineId from agents where org_id = ? and live = 1 and global = 1",
    OWNER_ORG_ID,
  ))
    all_(r.machineId);
  if (changed.length <= machines.length) {
    for (const namespace of changed)
      for (const r of all<{ machineId: string }>(
        sql,
        "select distinct machine_id as machineId from agents where org_id = ? and namespace = ? and live = 1",
        OWNER_ORG_ID,
        namespace,
      )) {
        const cur = out.get(r.machineId);
        if (cur === changed) continue;
        if (cur) cur.push(namespace);
        else out.set(r.machineId, [namespace]);
      }
    return out;
  }
  const wanted = new Set(changed);
  for (const m of machines) {
    if (out.get(m) === changed) continue;
    const hit = all<{ namespace: string }>(
      sql,
      // machine ids are unique across orgs: agents_machine(machine_id, live).
      "select distinct namespace from agents where machine_id = ? and live = 1",
      m,
    )
      .map((r) => r.namespace)
      .filter((n) => wanted.has(n));
    if (hit.length > 0) out.set(m, hit);
  }
  return out;
}

/**
 * What changed: the namespaces of the agents that changed, and whether any of
 * them is global (a global appears in every namespace's list).
 */
type RosterChange = { namespaces: string[]; global: boolean };

/**
 * A global change reaches every daemon: one `roster_changed{ns}` for each
 * namespace where that daemon's machine hosts a live agent (bounded by its own
 * agents, not namespaces x daemons). One covering query on
 * agents_live_ns_machine.
 */
function everyDaemonAudience(sql: SqlStorage): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of all<{ machineId: string; namespace: string }>(
    sql,
    "select distinct machine_id as machineId, namespace from agents where org_id = ? and live = 1",
    OWNER_ORG_ID,
  )) {
    const cur = out.get(r.machineId);
    if (cur) cur.push(r.namespace);
    else out.set(r.machineId, [r.namespace]);
  }
  return out;
}

/**
 * The one roster broadcast; each frame is encoded once per namespace. A
 * non-global change goes only to daemons whose machine hosts a live agent in
 * the namespace, or any live global; a global change reaches every daemon
 * (everyDaemonAudience). `except` is the socket that caused the change: it
 * already knows and is never told. B10 adds the dashboard observers here.
 */
function notifyRoster(
  ctx: DurableObjectState,
  change: RosterChange,
  except?: WebSocket,
) {
  const changed = [...new Set(change.namespaces)];
  if (changed.length === 0) return;
  const sockets = ctx
    .getWebSockets(DAEMON_TAG)
    .filter((w) => w !== except && w.readyState === OPEN && !isReplaced(w));
  if (sockets.length === 0) return;
  const machines = [
    ...new Set(sockets.map(machineOf).filter((m): m is string => m !== null)),
  ];
  const audience = change.global
    ? everyDaemonAudience(ctx.storage.sql)
    : rosterAudience(ctx.storage.sql, changed, machines);
  const encoded = new Map<string, string>();
  const frameFor = (namespace: string) => {
    let f = encoded.get(namespace);
    if (f === undefined) {
      f = encodeFrame({
        v: 1,
        id: frameId(),
        type: "roster_changed",
        namespace,
      });
      encoded.set(namespace, f);
    }
    return f;
  };
  for (const ws of sockets) {
    const m = machineOf(ws);
    const nss = m === null ? undefined : audience.get(m);
    if (!nss) continue;
    for (const namespace of nss) {
      try {
        ws.send(frameFor(namespace));
      } catch {
        // Closing; it resyncs on reconnect.
      }
    }
  }
}

/** A machine's open agents: their state flips with its socket. */
function machineChange(sql: SqlStorage, machineId: string): RosterChange {
  const rows = all<{ namespace: string; g: number }>(
    sql,
    "select namespace, max(global) as g from agents where machine_id = ? and live = 1 group by namespace limit ?",
    machineId,
    LIMITS.maxRosterAgents,
  );
  return {
    namespaces: rows.map((r) => r.namespace),
    global: rows.some((r) => r.g === 1),
  };
}

/** The open agent `ref` on this machine, or null: the from_ref identity check. */
function registeredAgent(
  sql: SqlStorage,
  machineId: string,
  ref: string,
): AgentRow | null {
  return one<AgentRow>(
    sql,
    `select ${AGENT_COLS} from agents where machine_id = ? and native_ref = ? and live = 1 and org_id = ?`,
    machineId,
    ref,
    OWNER_ORG_ID,
  );
}

/**
 * Names compare case-insensitively (bus names are ASCII). A global agent's
 * name must be free among ALL live agents (it is visible everywhere); a
 * non-global's must be free in its namespace and among live globals.
 * One query on agents_live_lname.
 */
function nameTaken(
  sql: SqlStorage,
  namespace: string,
  name: string,
  global: boolean,
  selfId: string,
): boolean {
  const lname = name.toLowerCase();
  return global
    ? one(
        sql,
        "select 1 as x from agents where org_id = ? and lower(name) = ? and live = 1 and id != ? limit 1",
        OWNER_ORG_ID,
        lname,
        selfId,
      ) !== null
    : one(
        sql,
        "select 1 as x from agents where org_id = ? and lower(name) = ? and live = 1 and id != ? and (namespace = ? or global = 1) limit 1",
        OWNER_ORG_ID,
        lname,
        selfId,
        namespace,
      ) !== null;
}

/**
 * The proposed name, else `-2`, `-3`... up to the roster cap, else the
 * fallback name suffixed the same way, else a random fallback suffix. Never
 * fails: a name collision is not an error.
 */
function assignName(
  sql: SqlStorage,
  namespace: string,
  proposed: string,
  global: boolean,
  selfId: string,
): string {
  const free = (n: string) => !nameTaken(sql, namespace, n, global, selfId);
  for (const base of new Set([candidateName(proposed), FALLBACK_BUS_NAME])) {
    if (free(base)) return base;
    for (let n = 2; n <= MAX_NAME_SUFFIX; n++) {
      const next = suffixName(base, n);
      if (free(next)) return next;
    }
  }
  for (;;) {
    const next = suffixName(
      FALLBACK_BUS_NAME,
      MAX_NAME_SUFFIX + 1 + Math.floor(Math.random() * 1e9),
    );
    if (free(next)) return next;
  }
}

/** Registers (or re-registers) an agent; returns the reply and changed namespaces. */
function agentUp(
  sql: SqlStorage,
  machineId: string,
  f: AgentUpFrame,
  now: number,
): { reply: ServerFrame; change: RosterChange } {
  const existing = one<{
    id: string;
    namespace: string;
    live: number;
    global: number;
  }>(
    sql,
    "select id, namespace, live, global from agents where machine_id = ? and native_ref = ? and org_id = ?",
    machineId,
    f.agent_ref,
    OWNER_ORG_ID,
  );
  const id = existing?.id ?? newId();
  const name = assignName(sql, f.namespace, f.proposed_name, f.global, id);
  if (existing)
    sql.exec(
      "update agents set namespace = ?, name = ?, kind = ?, global = ?, live = 1, updated_at = ? where id = ?",
      f.namespace,
      name,
      f.kind,
      f.global ? 1 : 0,
      now,
      id,
    );
  else
    sql.exec(
      `insert into agents (id, org_id, namespace, name, kind, machine_id, native_ref, global, live, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      id,
      OWNER_ORG_ID,
      f.namespace,
      name,
      f.kind,
      machineId,
      f.agent_ref,
      f.global ? 1 : 0,
      now,
    );
  const wasLive = existing?.live === 1;
  const changed = [f.namespace];
  if (wasLive && existing.namespace !== f.namespace)
    changed.push(existing.namespace);
  const global = f.global || (wasLive && existing.global === 1);
  return {
    reply: {
      v: 1,
      id: f.id,
      type: "agent_ok",
      agent_ref: f.agent_ref,
      bus_name: name,
    },
    change: { namespaces: changed, global },
  };
}

/** Closes an open agent (its session ended); returns it, or null. */
function agentDown(
  sql: SqlStorage,
  machineId: string,
  ref: string,
  now: number,
): AgentRow | null {
  const agent = registeredAgent(sql, machineId, ref);
  if (!agent) return null;
  sql.exec(
    "update agents set live = 0, last_name = name, updated_at = ? where id = ?",
    now,
    agent.id,
  );
  return agent;
}

/**
 * A non-global agent sees its namespace plus every global agent; a global
 * agent sees every open agent. `state` is always sent: live while the
 * agent's machine holds a socket, queued otherwise.
 */
function roster(
  ctx: DurableObjectState,
  agent: AgentRow,
  id: string,
): ServerFrame {
  const sql = ctx.storage.sql;
  const cap = LIMITS.maxRosterAgents;
  let rows: AgentRow[];
  if (agent.global === 1) {
    rows = all<AgentRow>(
      sql,
      `select ${AGENT_COLS} from agents where org_id = ? and live = 1 order by namespace, name limit ?`,
      OWNER_ORG_ID,
      cap,
    );
  } else {
    // Two indexed queries (agents_live_name, agents_global_name), merged here.
    const local = all<AgentRow>(
      sql,
      `select ${AGENT_COLS} from agents where org_id = ? and namespace = ? and live = 1 order by name limit ?`,
      OWNER_ORG_ID,
      agent.namespace,
      cap,
    );
    const globals = all<AgentRow>(
      sql,
      `select ${AGENT_COLS} from agents where org_id = ? and live = 1 and global = 1 order by name limit ?`,
      OWNER_ORG_ID,
      cap,
    );
    const seen = new Set(local.map((r) => r.id));
    rows = [...local, ...globals.filter((r) => !seen.has(r.id))]
      .sort((a, b) =>
        a.namespace === b.namespace
          ? a.name < b.name
            ? -1
            : a.name > b.name
              ? 1
              : 0
          : a.namespace < b.namespace
            ? -1
            : 1,
      )
      .slice(0, cap);
  }
  const online = new Map<string, boolean>();
  const stateOf = (machineId: string): "live" | "queued" => {
    let on = online.get(machineId);
    if (on === undefined) {
      on = ctx.getWebSockets(machineId).length > 0;
      online.set(machineId, on);
    }
    return on ? "live" : "queued";
  };
  return {
    v: 1,
    id,
    type: "roster",
    agents: rows.map((r) => ({
      bus_name: r.name,
      kind: r.kind as "claude-code" | "opencode" | "pi",
      namespace: r.namespace,
      global: r.global === 1,
      state: stateOf(r.machineId),
    })),
  };
}

// --------------------------------------------------------------------- mail
//
// Target resolution (CONTRACT.md "send targeting", B6 scope). Names compare
// case-insensitively; every query is on agents_live_lname or agents_lname.
// For a global sender, "the name in namespace X" means what X's roster shows:
// a live agent in X or a live global (globals are visible everywhere). A
// non-global sender's to_namespace X reaches only a live global whose HOME
// namespace is X (liveGlobalHomedIn). Live global names are unique among all
// live agents, so a lookup never sees two rows.

/**
 * Held (pushed, unacked inline) bodies are capped in memory across the hub;
 * past the cap a body is stored in `mail` instead (write-on-miss early). Each
 * entry is charged at least HELD_ENTRY_BYTES so tiny bodies are bounded too.
 */
export const HELD_BYTES_CAP = 8 * 1024 * 1024;
const HELD_ENTRY_BYTES = 256;

/** A held body: `at` is when it was pushed (its ack deadline is at + ackTimeoutMs). */
type Held = {
  body: string;
  cost: number;
  at: number;
  createdAt: number;
  expiresAt: number;
};

type Resolution =
  | { ok: true; agent: AgentRow }
  | { ok: false; reason: RefusalReason };

/** The live agent `lname` names in namespace `ns` (in `ns`, or a global). */
function liveVisibleIn(
  sql: SqlStorage,
  ns: string,
  lname: string,
): AgentRow | null {
  return one<AgentRow>(
    sql,
    `select ${AGENT_COLS} from agents where org_id = ? and lower(name) = ? and live = 1 and (namespace = ? or global = 1) order by global desc limit 1`,
    OWNER_ORG_ID,
    lname,
    ns,
  );
}

/** The live global named `lname` whose home namespace is `ns` (case 2). */
function liveGlobalHomedIn(
  sql: SqlStorage,
  ns: string,
  lname: string,
): AgentRow | null {
  return one<AgentRow>(
    sql,
    `select ${AGENT_COLS} from agents where org_id = ? and lower(name) = ? and live = 1 and global = 1 and namespace = ? limit 1`,
    OWNER_ORG_ID,
    lname,
    ns,
  );
}

/** True when a closed agent `lname` was in namespace `ns`, or was a global. */
function closedVisibleIn(sql: SqlStorage, ns: string, lname: string): boolean {
  return (
    one(
      sql,
      "select 1 as x from agents where org_id = ? and lower(name) = ? and live = 0 and (namespace = ? or global = 1) limit 1",
      OWNER_ORG_ID,
      lname,
      ns,
    ) !== null
  );
}

/** Up to `limit` live agents named `lname`, in any namespace. */
function liveAnywhere(
  sql: SqlStorage,
  lname: string,
  limit: number,
): AgentRow[] {
  return all<AgentRow>(
    sql,
    `select ${AGENT_COLS} from agents where org_id = ? and lower(name) = ? and live = 1 order by global desc limit ?`,
    OWNER_ORG_ID,
    lname,
    limit,
  );
}

function closedAnywhere(sql: SqlStorage, lname: string): boolean {
  return (
    one(
      sql,
      "select 1 as x from agents where org_id = ? and lower(name) = ? and live = 0 limit 1",
      OWNER_ORG_ID,
      lname,
    ) !== null
  );
}

const refused = (reason: RefusalReason): Resolution => ({ ok: false, reason });

function resolveTarget(
  sql: SqlStorage,
  sender: AgentRow,
  toName: string,
  toNamespace: string | undefined,
): Resolution {
  const lname = toName.toLowerCase();
  if (sender.global !== 1) {
    if (toNamespace !== undefined && toNamespace !== sender.namespace) {
      // Only a live global homed in X is reachable. Everything else is the
      // same refusal, so it cannot probe what exists in another namespace.
      const hit = liveGlobalHomedIn(sql, toNamespace, lname);
      return hit ? { ok: true, agent: hit } : refused("other_namespace");
    }
    const hit = liveVisibleIn(sql, sender.namespace, lname);
    if (hit) return { ok: true, agent: hit };
    if (closedVisibleIn(sql, sender.namespace, lname)) return refused("closed");
    // Other namespaces are invisible and unreachable (spec goal 5, scenario
    // 6): a name live only elsewhere is unknown_agent, so no probe can tell
    // it exists. other_namespace answers an explicit to_namespace only.
    return refused("unknown_agent");
  }
  if (toNamespace !== undefined) {
    const hit = liveVisibleIn(sql, toNamespace, lname);
    if (hit) return { ok: true, agent: hit };
    if (closedVisibleIn(sql, toNamespace, lname)) return refused("closed");
    return refused("unknown_agent");
  }
  // A live global sorts first and is the only live agent with its name.
  const live = liveAnywhere(sql, lname, 2);
  const first = live[0];
  if (first && (first.global === 1 || live.length === 1))
    return { ok: true, agent: first };
  if (live.length > 1) return refused("ambiguous");
  if (closedAnywhere(sql, lname)) return refused("closed");
  return refused("unknown_agent");
}

/** True when the agent already has `inboxCap` pending receipts (receipts_to). */
function inboxFull(sql: SqlStorage, agentId: string): boolean {
  const row = one<{ n: number }>(
    sql,
    "select count(*) as n from (select 1 from receipts where to_agent = ? and state = 'pending' limit ?)",
    agentId,
    LIMITS.inboxCap,
  );
  return (row?.n ?? 0) >= LIMITS.inboxCap;
}

/** A refused send: a fresh msg_id and no stored row. */
function refuseSend(ws: WebSocket, id: string, reason: RefusalReason): void {
  sendFrame(ws, {
    v: 1,
    id,
    type: "receipt",
    msg_id: newId(),
    state: "refused",
    reason,
  });
}

function storeBody(
  sql: SqlStorage,
  id: string,
  body: string,
  now: number,
  expiresAt: number,
): void {
  sql.exec(
    "insert into mail (id, org_id, body, created_at, expires_at) values (?, ?, ?, ?, ?) on conflict(id) do nothing",
    id,
    OWNER_ORG_ID,
    body,
    now,
    expiresAt,
  );
}

/**
 * Resolves a pending receipt for an ack or refuse from `machineId`: only the
 * recipient agent's machine may, and only while it is pending. Returns the
 * sender agent id on success, null (ignored) otherwise.
 *
 * The check is by machine, not socket: a late ack that a replaced socket of
 * the recipient's machine sent before it was replaced is accepted on purpose,
 * since that machine is still the recipient. (Frames arriving on a socket
 * after it is marked replaced never get here.)
 *
 * How it was delivered follows from `size`: above inlineBodyBytes it went as
 * a notice. Acking a notice means the harness took the notice, so the receipt
 * is delivered but the stored body stays for fetch. A refusal drops either.
 */
function settle(
  sql: SqlStorage,
  machineId: string,
  msgId: string,
  outcome: "delivered" | "refused",
  now: number,
): string | null {
  const r = one<{ fromAgent: string; size: number }>(
    sql,
    `select r.from_agent as fromAgent, r.size from receipts r join agents a on a.id = r.to_agent
     where r.id = ? and r.org_id = ? and r.state = 'pending' and a.machine_id = ?`,
    msgId,
    OWNER_ORG_ID,
    machineId,
  );
  if (!r) return null;
  // R7 (accepted): an ack after expires_at but before the sweep counts as
  // delivered; the harness really did take it.
  if (outcome === "delivered")
    sql.exec(
      "update receipts set state = 'delivered', acked_at = ?, final_at = ? where id = ? and state = 'pending'",
      now,
      now,
      msgId,
    );
  else
    sql.exec(
      "update receipts set state = 'refused', reason = 'closed', final_at = ? where id = ? and state = 'pending'",
      now,
      msgId,
    );
  // A notice's body stays for fetch (#fetch deletes it); B7's expiry sweep
  // deletes it otherwise.
  if (outcome === "refused" || r.size <= LIMITS.inlineBodyBytes)
    sql.exec("delete from mail where id = ?", msgId);
  return r.fromAgent;
}

// ------------------------------------------------------------------- expiry
//
// One alarm serves every deadline (B7). Each step touches at most BATCH rows
// through an index; a full batch re-arms at now + 1 instead of looping, so a
// run stays inside the Workers Free CPU budget.

/**
 * Rows one alarm step (or one replay, flush or close) handles before
 * re-arming at now + 1. 50 keeps a notify-heavy run well inside the ~10 ms
 * CPU budget (200 expiries plus notifies measured ~9 ms locally). It equals
 * inboxCap, so one batch covers an agent's whole inbox.
 */
export const SWEEP_BATCH = 50;
const BATCH = SWEEP_BATCH;
/** Final receipts are kept this long after the sender was told (or, untold, past expiry). */
const RETAIN_MS = 24 * HOUR_MS;
/** Device codes are purged this long past expiry. */
const DEVICE_CODE_GRACE_MS = 24 * HOUR_MS;

const isRefusalReason = (r: string | null): r is RefusalReason =>
  (REFUSAL_REASONS as readonly (string | null)[]).includes(r);

/** The receipt_update for a final state as stored, or null if the row is not final. */
function updateFrame(
  msgId: string,
  state: string,
  reason: string | null,
): ServerFrame | null {
  const base = {
    v: 1,
    id: frameId(),
    type: "receipt_update",
    msg_id: msgId,
  } as const;
  if (state === "delivered") return { ...base, state };
  if (state === "expired")
    return reason === "recipient_closed"
      ? { ...base, state, reason }
      : { ...base, state };
  if (state === "refused" && isRefusalReason(reason))
    return { ...base, state, reason };
  return null;
}

/**
 * Runs a bounded `delete ... where rowid in (select rowid ... limit ?)
 * returning rowid` with BATCH as the last parameter; true if the batch was full.
 */
function purge(sql: SqlStorage, q: string, ...b: SqlStorageValue[]): boolean {
  return all(sql, q, ...b, BATCH).length >= BATCH;
}

/** The one not_found detail for fetch, whatever the cause. */
const FETCH_NOT_FOUND = "No such message";

/** A frame that names a sender must name an agent this socket registered. */
function senderRef(f: ClientFrame): string | null {
  return f.type === "send" || f.type === "list" || f.type === "fetch"
    ? f.from_ref
    : null;
}

/**
 * The hub: one SQLite Durable Object per owner. B3 holds machines and the
 * auth storage B1/B1b call; later tasks add the socket, mail and alarm paths.
 *
 * Every method on this class is on the RPC surface; the test allowlist in
 * hub.machines.test.ts pins it. Helpers live outside the class.
 */
export class Hub extends DurableObject<Env> {
  /** A frozen clock for tests; null in production. Never on the RPC surface. */
  #clock: number | null = null;

  /**
   * Tests only, inside `runInDurableObject`. Static, so it is not on the
   * prototype and a stub cannot call it over RPC.
   */
  static setTestClock(hub: Hub, ms: number | null): void {
    hub.#clock = ms;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(HUB_SCHEMA);
      migrateHub(ctx.storage.sql);
      await this.#armOnWake();
    });
  }

  #now(): number {
    return this.#clock ?? Date.now();
  }

  /**
   * On wake, when work exists (pending mail, a stored body or an untold
   * final receipt) but no alarm is set, arm for its earliest deadline. One
   * indexed exists query; covers hubs whose rows never armed (B6-era).
   */
  async #armOnWake(): Promise<void> {
    const work = one<{ x: number }>(
      this.ctx.storage.sql,
      `select (exists (select 1 from receipts where state = 'pending')
            or exists (select 1 from mail)
            or exists (select 1 from receipts where notified_at is null and state != 'pending')) as x`,
    );
    if (!work?.x) return;
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    const at = this.#nextDeadline(null);
    if (at !== null)
      await this.ctx.storage.setAlarm(Math.max(at, this.#now() + 1));
  }

  /**
   * Inline bodies pushed and not yet acked, by msg_id, with their charged
   * bytes and when they were pushed (`at`, mirrored in receipts.held_at). In
   * memory only, at most HELD_BYTES_CAP in total. The alarm moves a body to
   * `mail` once its ack is ackTimeoutMs late; a body lost to an eviction
   * before then is found by held_at and its receipt expires (never delivered).
   */
  #held = new Map<string, Held>();
  #heldBytes = 0;
  /** The earliest alarm time asked for while handling one event; committed after it. */
  #armWant: number | null = null;
  /**
   * Senders whose missed receipt_updates did not fit one replay batch; the
   * alarm sends the rest. Lost on eviction: the next agent_up replays again.
   */
  #replayQueue = new Set<string>();

  /** Tests only: static, so not on the RPC surface. */
  static heldStats(hub: Hub): { bytes: number; ids: string[] } {
    return { bytes: hub.#heldBytes, ids: [...hub.#held.keys()] };
  }

  /** Tests only (static, not RPC): an eviction drops every held body. */
  static dropHeldForTests(hub: Hub): void {
    hub.#held.clear();
    hub.#heldBytes = 0;
  }

  // ---------------------------------------------------------------- machines

  /**
   * Called by the device flow once a user code is approved. The label must
   * already pass MachineLabelSchema (callers sanitize with newMachineLabel);
   * an invalid label or id throws (a programmer error). At MAX_ACTIVE_MACHINES
   * active machines it returns `{ ok: false, code: "machine_limit" }`.
   * Stores only the token's SHA-256 and returns the token once.
   */
  async createMachine(
    label: string,
    id: string = newId(),
  ): Promise<CreateMachineResult> {
    if (!MachineLabelSchema.safeParse(label).success)
      throw new Error("invalid machine label");
    if (!isId(id)) throw new Error("invalid machine id");
    const token = newMachineToken();
    // The only await is here, before the cap check: the check and the insert
    // below are one synchronous step, so concurrent creates cannot both pass.
    const tokenHash = await sha256Hex(token);
    const sql = this.ctx.storage.sql;
    const active = one<{ n: number }>(
      sql,
      "select count(*) as n from machines where org_id = ? and (revoked_at is null) = 1",
      OWNER_ORG_ID,
    );
    if ((active?.n ?? 0) >= MAX_ACTIVE_MACHINES)
      return { ok: false, code: "machine_limit" };
    sql.exec(
      "insert into machines (id, org_id, label, token_hash, created_at) values (?, ?, ?, ?, ?)",
      id,
      OWNER_ORG_ID,
      label,
      tokenHash,
      this.#now(),
    );
    return { ok: true, id, label, token };
  }

  /** One lookup per WebSocket upgrade; last_used is throttled to once an hour. */
  async verifyToken(
    tokenHash: string,
  ): Promise<{ id: string; label: string } | null> {
    const sql = this.ctx.storage.sql;
    const row = one<{
      id: string;
      label: string;
      revokedAt: number | null;
      lastUsedAt: number | null;
    }>(
      sql,
      "select id, label, revoked_at as revokedAt, last_used as lastUsedAt from machines where token_hash = ? and org_id = ? limit 1",
      tokenHash,
      OWNER_ORG_ID,
    );
    if (!row || row.revokedAt !== null) return null;
    const now = this.#now();
    if (row.lastUsedAt === null || row.lastUsedAt < now - HOUR_MS)
      sql.exec("update machines set last_used = ? where id = ?", now, row.id);
    return { id: row.id, label: row.label };
  }

  /**
   * Active machines newest first, then revoked newest first, at most
   * maxMachinesListed. Active machines are capped at the same number, so every
   * active machine is always listed.
   */
  async listMachines(): Promise<MachineRow[]> {
    return all<StoredMachine>(
      this.ctx.storage.sql,
      `select ${MACHINE_COLS} from machines where org_id = ? order by (revoked_at is null) desc, created_at desc, rowid desc limit ?`,
      OWNER_ORG_ID,
      LIMITS.maxMachinesListed,
    ).map((m) => withLiveness(this.ctx, m));
  }

  // ----------------------------------------------------------------- sockets
  // DurableObject handlers. workerd reserves these names: a stub cannot call
  // them over RPC (DurableObjectStub omits them).

  /**
   * The Worker's /hub route forwards a verified upgrade here with only
   * `Upgrade` and `X-Ob-Machine-Id` (never the client's headers).
   */
  override async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname !== "/hub")
      return new Response("Not found", { status: 404 });
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket upgrade", { status: 426 });
    const machineId = req.headers.get("X-Ob-Machine-Id") ?? "";
    if (!activeMachine(this.ctx, machineId))
      return new Response("Unknown machine", { status: 401 });

    // One socket per machine: a reconnect replaces the previous one. The old
    // socket is marked dead first, so frames it still sends are ignored.
    const wasOnline = machineOnline(this.ctx, machineId);
    for (const old of this.ctx.getWebSockets(machineId)) {
      try {
        old.serializeAttachment({
          machineId,
          replaced: true,
        } satisfies Attachment);
      } catch {
        // Already closed.
      }
      closeSocket(old, 1000, "replaced");
    }

    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [DAEMON_TAG, machineId]);
    server.serializeAttachment({ machineId } satisfies Attachment);
    // Answered by the runtime, so a keepalive never wakes the hub.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(PING, PONG),
    );
    // The machine's open agents flip from queued to live.
    if (!wasOnline)
      notifyRoster(
        this.ctx,
        machineChange(this.ctx.storage.sql, machineId),
        server,
      );
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    this.#onMessage(ws, message);
    await this.#commitArm();
  }

  #onMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // A replaced socket is dead: nothing it sends is processed.
    if (isReplaced(ws)) {
      closeSocket(ws, 1000, "replaced");
      return;
    }
    const machineId = machineOf(ws);
    // B9: revokeMachine closes this machine's sockets (tag = machine id) with
    // LIMITS.revokeCloseCode. An idle revoked socket (PING is auto-answered)
    // never reaches this check until then.
    const machine = machineId ? activeMachine(this.ctx, machineId) : null;
    if (!machineId || !machine) {
      closeSocket(ws, LIMITS.revokeCloseCode, "machine revoked");
      return;
    }
    if (typeof message !== "string") {
      sendError(ws, undefined, "bad_frame", "Text frames only");
      return;
    }
    if (message === PING) {
      // Normally answered by the auto-response before the hub wakes.
      try {
        ws.send(PONG);
      } catch {
        // Closing.
      }
      return;
    }
    const res = decodeClientFrame(message);
    if (!res.ok) {
      sendError(ws, res.id, res.error, "Unreadable frame");
      return;
    }
    const f = res.frame;
    const sql = this.ctx.storage.sql;

    // Review Focus 1: a socket acts only for agents it registered itself.
    const ref = senderRef(f);
    const sender = ref === null ? null : registeredAgent(sql, machineId, ref);
    if (ref !== null && !sender) {
      sendError(
        ws,
        f.id,
        "not_registered",
        "from_ref is not registered on this socket",
      );
      return;
    }

    switch (f.type) {
      case "hello":
        sendFrame(ws, {
          v: 1,
          id: f.id,
          type: "hello_ok",
          machine_id: machine.id,
          machine_label: machine.label,
          server_version: version(this.env),
        });
        return;
      case "sessions": {
        // Open sessions come back with their own agent_up; closed ones end.
        const change: RosterChange = { namespaces: [], global: false };
        for (const r of f.closed) {
          const a = agentDown(sql, machineId, r, this.#now());
          if (a === null) continue;
          this.#closeInbox(a.id);
          change.namespaces.push(a.namespace);
          if (a.global === 1) change.global = true;
        }
        notifyRoster(this.ctx, change, ws);
        return;
      }
      case "agent_up": {
        const { reply, change } = agentUp(sql, machineId, f, this.#now());
        sendFrame(ws, reply);
        notifyRoster(this.ctx, change, ws);
        const a = registeredAgent(sql, machineId, f.agent_ref);
        if (a) {
          // Its queued mail, then what it missed as a sender.
          this.#flush(ws, a);
          if (this.#replay(a.id)) {
            this.#replayQueue.add(a.id);
            this.#arm(this.#now() + 1);
          }
        }
        return;
      }
      case "agent_down": {
        const a = agentDown(sql, machineId, f.agent_ref, this.#now());
        if (a === null) return;
        this.#closeInbox(a.id);
        notifyRoster(
          this.ctx,
          { namespaces: [a.namespace], global: a.global === 1 },
          ws,
        );
        return;
      }
      case "list":
        if (sender) sendFrame(ws, roster(this.ctx, sender, f.id));
        return;
      case "send":
        if (sender) this.#send(ws, f, sender);
        return;
      case "ack":
      case "refuse":
        // No reply either way: anything but the recipient's own pending mail
        // is silently ignored.
        this.#settle(
          machineId,
          f.msg_id,
          f.type === "ack" ? "delivered" : "refused",
        );
        return;
      case "fetch":
        if (sender) this.#fetch(ws, f, sender, machineId);
        return;
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // 1005/1006 are never sent on the wire.
    closeSocket(ws, code === 1005 || code === 1006 ? 1000 : code, "closed");
    this.#socketGone(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.#socketGone(ws);
  }

  /**
   * The machine's open agents flip to queued. They stay open: their sessions
   * may still be running (sessions{closed} and agent_down end them).
   */
  #socketGone(ws: WebSocket): void {
    const machineId = machineOf(ws);
    if (!machineId || isReplaced(ws)) return;
    if (machineOnline(this.ctx, machineId, ws)) return;
    notifyRoster(this.ctx, machineChange(this.ctx.storage.sql, machineId), ws);
  }

  // -------------------------------------------------------------------- mail

  /**
   * The receipt row is written before any delivery attempt, so a receipt never
   * claims more than happened. A refusal stores nothing.
   */
  #send(ws: WebSocket, f: SendFrame, sender: AgentRow): void {
    const sql = this.ctx.storage.sql;
    const res = resolveTarget(sql, sender, f.to_name, f.to_namespace);
    if (!res.ok) {
      refuseSend(ws, f.id, res.reason);
      return;
    }
    const target = res.agent;
    if (inboxFull(sql, target.id)) {
      refuseSend(ws, f.id, "inbox_full");
      return;
    }

    const now = this.#now();
    const msgId = newId();
    const size = utf8Bytes(f.body);
    const expiresAt = now + LIMITS.mailTtlSec * 1000;
    const socket = liveSocket(this.ctx, target.machineId);
    const inline = size <= LIMITS.inlineBodyBytes;
    // Held in memory only for an inline push to a live socket under the cap.
    const held = socket !== null && inline && this.#fits(size);
    sql.exec(
      `insert into receipts (id, org_id, namespace, to_agent, to_name, from_agent, from_name, state, reason, size, created_at, expires_at, acked_at, held_at)
       values (?, ?, ?, ?, ?, ?, ?, 'pending', null, ?, ?, ?, null, ?)`,
      msgId,
      OWNER_ORG_ID,
      sender.namespace,
      target.id,
      target.name,
      sender.id,
      sender.name,
      size,
      now,
      expiresAt,
      held ? now : null,
    );
    // Write-on-miss: an offline machine (agent queued), an oversized body or
    // a full held cap is stored; only an inline push to a live socket is held.
    if (held) this.#hold(msgId, f.body, size, now, expiresAt, now);
    else storeBody(sql, msgId, f.body, now, expiresAt);
    this.#arm(expiresAt);
    if (held) this.#arm(now + LIMITS.ackTimeoutMs);
    sendFrame(ws, {
      v: 1,
      id: f.id,
      type: "receipt",
      msg_id: msgId,
      state: "pending",
    });
    if (!socket) return;

    const head = {
      v: 1,
      id: frameId(),
      type: "deliver",
      msg_id: msgId,
      to_ref: target.nativeRef,
      from_name: sender.name,
      namespace: sender.namespace,
    } as const;
    if (inline) sendFrame(socket, { ...head, body: f.body });
    else sendFrame(socket, { ...head, notice: { size, msg_id: msgId } });
  }

  /**
   * The recipient fetches a stored body. Served only to the receipt's own
   * agent, from `mail`, while pending or delivered (an acked notice keeps its
   * body until fetched); the row is deleted on the way out. Everything else
   * (someone else's mail, unknown or final ids, held inline bodies, a lost
   * body, a body or pending receipt past its deadline) gets the same
   * not_found, so the reply never shows whether the id exists. Past a
   * deadline the expiry is left to the alarm. A pending receipt becomes delivered through #settle, so the
   * sender is told once; a lost body is left to the alarm's lost-body and
   * TTL steps.
   */
  #fetch(
    ws: WebSocket,
    f: FetchFrame,
    sender: AgentRow,
    machineId: string,
  ): void {
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    const r = one<{ state: string; body: string }>(
      sql,
      `select r.state as state, m.body as body from receipts r join mail m on m.id = r.id
       where r.id = ? and r.org_id = ? and r.to_agent = ? and m.expires_at > ?
         and (r.state = 'delivered' or (r.state = 'pending' and r.expires_at > ?))`,
      f.msg_id,
      OWNER_ORG_ID,
      sender.id,
      now,
      now,
    );
    if (!r) {
      sendError(ws, f.id, "not_found", FETCH_NOT_FOUND);
      return;
    }
    sendFrame(ws, {
      v: 1,
      id: f.id,
      type: "body",
      msg_id: f.msg_id,
      body: r.body,
    });
    if (r.state === "pending") this.#settle(machineId, f.msg_id, "delivered");
    sql.exec("delete from mail where id = ?", f.msg_id);
  }

  /** ack or refuse from `machineId`; tells the sender (now or on its next agent_up). */
  #settle(
    machineId: string,
    msgId: string,
    outcome: "delivered" | "refused",
  ): void {
    const from = settle(
      this.ctx.storage.sql,
      machineId,
      msgId,
      outcome,
      this.#now(),
    );
    if (from === null) return;
    this.#release(msgId);
    this.#tell(msgId, from, outcome, outcome === "refused" ? "closed" : null);
  }

  /**
   * Sends a final receipt_update to the sender's machine if it has a live
   * socket and records notified_at. With no socket notified_at stays null and
   * the update is replayed when the sender next registers (#replay).
   */
  #tell(
    msgId: string,
    fromAgent: string,
    state: "delivered" | "refused" | "expired",
    reason: string | null,
  ): void {
    const sql = this.ctx.storage.sql;
    const frame = updateFrame(msgId, state, reason);
    if (!frame) return;
    const m = one<{ machineId: string }>(
      sql,
      "select machine_id as machineId from agents where id = ?",
      fromAgent,
    );
    // N4 (accepted): a closed sender's machine is still told while online;
    // a session reopened later gets no replay (mail is not kept across it).
    const socket = m && liveSocket(this.ctx, m.machineId);
    if (!socket) return;
    sendFrame(socket, frame);
    sql.exec(
      "update receipts set notified_at = ? where id = ?",
      this.#now(),
      msgId,
    );
  }

  /**
   * pending -> expired, once: the guarded update is the only transition, so a
   * receipt is never expired (or the sender told) twice, and an expired one
   * never becomes delivered (settle also requires pending).
   */
  #expire(msgId: string, fromAgent: string, reason?: "recipient_closed"): void {
    const sql = this.ctx.storage.sql;
    const hit = all(
      sql,
      "update receipts set state = 'expired', reason = ?, final_at = ? where id = ? and state = 'pending' returning id",
      reason ?? null,
      this.#now(),
      msgId,
    );
    if (hit.length === 0) return;
    sql.exec("delete from mail where id = ?", msgId);
    this.#release(msgId);
    this.#tell(msgId, fromAgent, "expired", reason ?? null);
  }

  /**
   * The agent's session ended: its pending mail expires as recipient_closed
   * (spec "queue or refuse"), bodies dropped, so a session reopening under
   * the same ref gets nothing back. Pending per agent is at most inboxCap,
   * below BATCH, so one batch covers it.
   */
  #closeInbox(agentId: string): void {
    const sql = this.ctx.storage.sql;
    for (const r of all<{ id: string; fromAgent: string }>(
      sql,
      "select id, from_agent as fromAgent from receipts where to_agent = ? and state = 'pending' limit ?",
      agentId,
      BATCH,
    ))
      this.#expire(r.id, r.fromAgent, "recipient_closed");
    // Acked notices keep their body for fetch; the session that could fetch
    // it is gone, and a session reopened under the same ref (same agent id)
    // must not read it. The receipts stay (delivered is true). Indexed:
    // receipts_to (to_agent, state), then mail by primary key. Bounded: an
    // agent holds at most inboxCap pending notices at a time and each body
    // lives at most mailTtlSec, so this is that agent's acked-unfetched
    // notices from the last hour.
    sql.exec(
      "delete from mail where id in (select id from receipts where to_agent = ? and state = 'delivered')",
      agentId,
    );
  }

  /**
   * Reconnect flush: the agent's pending mail to its live socket, oldest
   * first. A body in `mail` is sent from there and its row kept until the
   * ack (inline) or expiry; only a never-persisted held body is re-held.
   * Oversized bodies go as a notice. Bounded by inboxCap (50): an agent never
   * has more pending than that, which SWEEP_BATCH covers. Arms for each
   * row's expiry (a B6-era row may never have armed one). A receipt past its TTL, or with no body anywhere (lost to an
   * eviction), expires instead: never delivered. The daemon dedupes by
   * msg_id, so redelivering an unacked held body is safe.
   */
  #flush(ws: WebSocket, agent: AgentRow): void {
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    for (const r of all<ReceiptRow>(
      sql,
      `select ${RECEIPT_COLS} from receipts where to_agent = ? and state = 'pending' order by created_at, rowid limit ?`,
      agent.id,
      BATCH,
    )) {
      if (r.expiresAt <= now) {
        this.#expire(r.id, r.fromAgent);
        continue;
      }
      const h = this.#held.get(r.id);
      const body =
        h?.body ??
        one<{ body: string }>(sql, "select body from mail where id = ?", r.id)
          ?.body ??
        null;
      if (body === null) {
        this.#expire(r.id, r.fromAgent);
        continue;
      }
      this.#arm(r.expiresAt);
      const head = {
        v: 1,
        id: frameId(),
        type: "deliver",
        msg_id: r.id,
        to_ref: agent.nativeRef,
        from_name: r.fromName,
        namespace: r.namespace,
      } as const;
      if (r.size > LIMITS.inlineBodyBytes) {
        sendFrame(ws, { ...head, notice: { size: r.size, msg_id: r.id } });
        continue;
      }
      // A body already on disk stays there until ack or expiry (never moved
      // into memory, so an eviction cannot lose it). A held body, never
      // persisted, is re-held with a fresh ack deadline.
      if (h) {
        this.#hold(r.id, body, r.size, r.createdAt, r.expiresAt, now);
        sql.exec("update receipts set held_at = ? where id = ?", now, r.id);
        this.#arm(now + LIMITS.ackTimeoutMs);
      }
      sendFrame(ws, { ...head, body });
    }
  }

  /**
   * Replays, oldest first, up to BATCH final receipt_updates the sender's
   * machine was never told (notified_at null), marking each as sent. True when
   * the batch was full (more may remain).
   */
  #replay(agentId: string): boolean {
    const sql = this.ctx.storage.sql;
    const m = one<{ machineId: string }>(
      sql,
      "select machine_id as machineId from agents where id = ?",
      agentId,
    );
    const socket = m && liveSocket(this.ctx, m.machineId);
    if (!socket) return false;
    const now = this.#now();
    const rows = all<{ id: string; state: string; reason: string | null }>(
      sql,
      "select id, state, reason from receipts where from_agent = ? and notified_at is null and state != 'pending' order by created_at, rowid limit ?",
      agentId,
      BATCH,
    );
    for (const r of rows) {
      const frame = updateFrame(r.id, r.state, r.reason);
      if (frame) sendFrame(socket, frame);
      sql.exec("update receipts set notified_at = ? where id = ?", now, r.id);
    }
    return rows.length >= BATCH;
  }

  #fits(size: number): boolean {
    return this.#heldBytes + Math.max(size, HELD_ENTRY_BYTES) <= HELD_BYTES_CAP;
  }

  /** Callers check #fits first; byte accounting is only ever done here and in #release. */
  #hold(
    msgId: string,
    body: string,
    size: number,
    createdAt: number,
    expiresAt: number,
    at: number,
  ): void {
    const cost = Math.max(size, HELD_ENTRY_BYTES);
    this.#release(msgId);
    this.#held.set(msgId, { body, cost, at, createdAt, expiresAt });
    this.#heldBytes += cost;
  }

  #release(msgId: string): void {
    const h = this.#held.get(msgId);
    if (!h) return;
    this.#held.delete(msgId);
    this.#heldBytes -= h.cost;
  }

  // ------------------------------------------------------------------- alarm

  /** Asks for the alarm at `t` (the earliest ask wins); committed after the event. */
  #arm(t: number): void {
    if (this.#armWant === null || t < this.#armWant) this.#armWant = t;
  }

  /** setAlarm only when none is set or `t` is earlier than the one set. */
  async #commitArm(): Promise<void> {
    const t = this.#armWant;
    if (t === null) return;
    this.#armWant = null;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || t < cur) await this.ctx.storage.setAlarm(t);
  }

  /**
   * The one alarm (a DurableObject handler: workerd reserves the name, so it
   * is not callable over RPC). In order: ack timeout, lost bodies, TTL,
   * expired mail bodies, replay continuation, housekeeping; then re-arm for
   * the earliest remaining deadline, or now + 1 if any batch was full.
   */
  override async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    let more = false;

    // 1. Ack timeout (write-on-miss): a held body whose ack is late moves to
    // mail; the receipt stays pending and the next flush redelivers it.
    let n = 0;
    for (const [id, h] of this.#held) {
      if (h.at + LIMITS.ackTimeoutMs > now) continue;
      if (n++ >= BATCH) {
        more = true;
        break;
      }
      storeBody(sql, id, h.body, h.createdAt, h.expiresAt);
      sql.exec("update receipts set held_at = null where id = ?", id);
      this.#release(id);
    }

    // 2. Lost bodies: held_at set, no mail row and not in memory means the
    // body died with an eviction. Expired, never delivered.
    const lost = all<{ id: string; fromAgent: string }>(
      sql,
      `select id, from_agent as fromAgent from receipts
       where state = 'pending' and held_at is not null and held_at <= ?
         and not exists (select 1 from mail where mail.id = receipts.id)
       order by held_at limit ?`,
      now - LIMITS.ackTimeoutMs,
      BATCH,
    );
    if (lost.length >= BATCH) more = true;
    for (const r of lost)
      if (!this.#held.has(r.id)) this.#expire(r.id, r.fromAgent);

    // 3. TTL: pending past expires_at expires, bodies dropped, sender told.
    const due = all<{ id: string; fromAgent: string }>(
      sql,
      "select id, from_agent as fromAgent from receipts where state = 'pending' and expires_at <= ? order by expires_at limit ?",
      now,
      BATCH,
    );
    if (due.length >= BATCH) more = true;
    for (const r of due) this.#expire(r.id, r.fromAgent);

    // 4. Expired bodies, whatever the receipt state (acked notices included).
    if (
      purge(
        sql,
        "delete from mail where rowid in (select rowid from mail where expires_at <= ? limit ?) returning rowid",
        now,
      )
    )
      more = true;

    // 5. Missed receipt_updates that did not fit the agent_up batch.
    const next = this.#replayQueue.values().next();
    if (!next.done) {
      if (!this.#replay(next.value)) this.#replayQueue.delete(next.value);
      if (this.#replayQueue.size > 0) more = true;
    }

    // 6. Housekeeping: consumed OIDC states, old device codes, and final
    // receipts told over 24 h ago (or never told, final over 24 h ago: keyed
    // on final_at, so a receipt finalized in this run is never deleted in it).
    for (const [q, t] of [
      [
        "delete from oidc_states where rowid in (select rowid from oidc_states where expires_at < ? limit ?) returning rowid",
        now - STATE_GRACE_MS,
      ],
      [
        "delete from device_codes where rowid in (select rowid from device_codes where expires_at < ? limit ?) returning rowid",
        now - DEVICE_CODE_GRACE_MS,
      ],
      [
        "delete from receipts where rowid in (select rowid from receipts where notified_at is not null and notified_at < ? limit ?) returning rowid",
        now - RETAIN_MS,
      ],
      [
        "delete from receipts where rowid in (select rowid from receipts where notified_at is null and state != 'pending' and final_at < ? limit ?) returning rowid",
        now - RETAIN_MS,
      ],
    ] as const)
      if (purge(sql, q, t)) more = true;

    const want = this.#armWant;
    this.#armWant = null;
    const at = more ? now + 1 : this.#nextDeadline(want);
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(at, now + 1));
  }

  /** The earliest remaining deadline, each one indexed lookup; null if none. */
  #nextDeadline(want: number | null): number | null {
    const sql = this.ctx.storage.sql;
    const min = (q: string, add = 0): number | null => {
      const t = one<{ t: number | null }>(sql, q)?.t ?? null;
      return t === null ? null : t + add;
    };
    let heldNext: number | null = null;
    for (const h of this.#held.values())
      if (heldNext === null || h.at < heldNext) heldNext = h.at;
    const ts = [
      want,
      heldNext === null ? null : heldNext + LIMITS.ackTimeoutMs,
      min(
        "select min(held_at) as t from receipts where state = 'pending' and held_at is not null",
        LIMITS.ackTimeoutMs,
      ),
      min("select min(expires_at) as t from receipts where state = 'pending'"),
      min("select min(expires_at) as t from mail"),
      min(
        "select min(notified_at) as t from receipts where notified_at is not null",
        RETAIN_MS,
      ),
      min(
        "select min(final_at) as t from receipts where notified_at is null and state != 'pending'",
        RETAIN_MS,
      ),
    ].filter((t): t is number => t !== null);
    return ts.length === 0 ? null : Math.min(...ts);
  }

  // ------------------------------------------------------------ auth storage

  /**
   * Marks an OIDC state as used: true the first time, false on any reuse.
   * Also false, storing nothing, when the state is empty or over 256 chars, or
   * expiresAt is not an integer in (now, now + 1 h] (so a replay after the
   * purge fails). Atomic: the DO is single-threaded and the insert is one
   * statement. Also purges a bounded batch of states expired over an hour ago.
   */
  async consumeState(state: string, expiresAt: number): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    const now = this.#now();
    sql.exec(
      "delete from oidc_states where rowid in (select rowid from oidc_states where expires_at < ? limit ?)",
      now - STATE_GRACE_MS,
      STATE_PURGE_BATCH,
    );
    if (
      typeof state !== "string" ||
      state.length === 0 ||
      state.length > MAX_STATE_CHARS
    )
      return false;
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + MAX_STATE_TTL_MS
    )
      return false;
    const cur = sql.exec(
      "insert into oidc_states (org_id, state, expires_at) values (?, ?, ?) on conflict(org_id, state) do nothing",
      OWNER_ORG_ID,
      state,
      expiresAt,
    );
    return cur.rowsWritten > 0;
  }

  /**
   * The current session generation: 0 before the first bump.
   *
   * Callers must compare a session's generation with `!==` only, never `<`:
   * -1 means the stored value is corrupt, and since no session carries -1,
   * `!==` then refuses every session (fails closed).
   */
  async sessionGeneration(): Promise<number> {
    return readSessionGeneration(this.ctx.storage.sql);
  }

  /**
   * Invalidates every session (logout, revoke-all) and returns the new
   * generation. A corrupt stored value restarts at 1.
   */
  async bumpSessionGeneration(): Promise<number> {
    const sql = this.ctx.storage.sql;
    const cur = readSessionGeneration(sql);
    const next = cur < 0 ? 1 : cur + 1;
    sql.exec(
      "insert into meta (org_id, key, value) values (?, ?, ?) on conflict(org_id, key) do update set value = excluded.value",
      OWNER_ORG_ID,
      SESSION_GEN_KEY,
      String(next),
    );
    return next;
  }
}

/**
 * The type the Worker and tests hold. Every method on `Hub.prototype` is
 * callable over RPC; helpers are module-level functions, which are not.
 */
export type HubStub = Hub;
