import { DurableObject } from "cloudflare:workers";
import {
  type AgentUpFrame,
  type ClientFrame,
  candidateName,
  decodeClientFrame,
  encodeFrame,
  frameId,
  isId,
  LIMITS,
  MachineLabelSchema,
  newId,
  newMachineToken,
  OWNER_ORG_ID,
  PING,
  PONG,
  type ServerFrame,
  suffixName,
} from "@ob/shared";
import type { Env } from "../env.js";
import { version } from "../version.js";
import { sha256Hex } from "./hash.js";
import {
  AGENT_COLS,
  type AgentRow,
  MACHINE_COLS,
  type MachineRow,
} from "./rows.js";
import { HUB_SCHEMA } from "./schema.js";

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

/** Highest numeric suffix tried before agent_up gives up on a name. */
const MAX_NAME_SUFFIX = 99;
const DAEMON_TAG = "daemon";
const OPEN = 1; // WebSocket.READY_STATE_OPEN

type ErrorCode = Extract<ServerFrame, { type: "error" }>["code"];
type Attachment = { machineId: string };

function machineOf(ws: WebSocket): string | null {
  const a = ws.deserializeAttachment() as Attachment | null;
  return typeof a?.machineId === "string" ? a.machineId : null;
}

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

/** True while the machine holds an open socket other than `except`. */
function machineOnline(
  ctx: DurableObjectState,
  machineId: string,
  except?: WebSocket,
): boolean {
  return ctx
    .getWebSockets(machineId)
    .some((w) => w !== except && w.readyState === OPEN);
}

/**
 * The one roster broadcast: every daemon socket hears one `roster_changed`
 * per changed namespace. B10 adds the dashboard observers here.
 */
function notifyRoster(ctx: DurableObjectState, namespaces: Iterable<string>) {
  const changed = [...new Set(namespaces)];
  if (changed.length === 0) return;
  for (const ws of ctx.getWebSockets(DAEMON_TAG))
    for (const namespace of changed)
      sendFrame(ws, { v: 1, id: frameId(), type: "roster_changed", namespace });
}

/** Namespaces with open agents on a machine: their state flips with its socket. */
function machineNamespaces(sql: SqlStorage, machineId: string): string[] {
  return all<{ namespace: string }>(
    sql,
    "select distinct namespace from agents where machine_id = ? and live = 1 limit ?",
    machineId,
    LIMITS.maxRosterAgents,
  ).map((r) => r.namespace);
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
 * Names are unique per namespace among open agents; a global agent's name is
 * also unique among open globals (the two partial unique indexes).
 */
function nameTaken(
  sql: SqlStorage,
  namespace: string,
  name: string,
  global: boolean,
  selfId: string,
): boolean {
  if (
    one(
      sql,
      "select 1 as x from agents where org_id = ? and namespace = ? and name = ? and live = 1 and id != ? limit 1",
      OWNER_ORG_ID,
      namespace,
      name,
      selfId,
    )
  )
    return true;
  return (
    global &&
    one(
      sql,
      "select 1 as x from agents where org_id = ? and name = ? and live = 1 and global = 1 and id != ? limit 1",
      OWNER_ORG_ID,
      name,
      selfId,
    ) !== null
  );
}

function assignName(
  sql: SqlStorage,
  namespace: string,
  proposed: string,
  global: boolean,
  selfId: string,
): string | null {
  const base = candidateName(proposed);
  if (!nameTaken(sql, namespace, base, global, selfId)) return base;
  for (let n = 2; n <= MAX_NAME_SUFFIX; n++) {
    const next = suffixName(base, n);
    if (!nameTaken(sql, namespace, next, global, selfId)) return next;
  }
  return null;
}

/** Registers (or re-registers) an agent; returns the reply and changed namespaces. */
function agentUp(
  sql: SqlStorage,
  machineId: string,
  f: AgentUpFrame,
  now: number,
): { reply: ServerFrame; changed: string[] } {
  const existing = one<{ id: string; namespace: string; live: number }>(
    sql,
    "select id, namespace, live from agents where machine_id = ? and native_ref = ? and org_id = ?",
    machineId,
    f.agent_ref,
    OWNER_ORG_ID,
  );
  const id = existing?.id ?? newId();
  const name = assignName(sql, f.namespace, f.proposed_name, f.global, id);
  if (name === null)
    return {
      reply: {
        v: 1,
        id: f.id,
        type: "error",
        code: "internal",
        message: "No free bus name for this agent",
      },
      changed: [],
    };
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
  const changed = [f.namespace];
  if (existing?.live === 1 && existing.namespace !== f.namespace)
    changed.push(existing.namespace);
  return {
    reply: {
      v: 1,
      id: f.id,
      type: "agent_ok",
      agent_ref: f.agent_ref,
      bus_name: name,
    },
    changed,
  };
}

/** Closes an open agent (its session ended); returns its namespace, or null. */
function agentDown(
  sql: SqlStorage,
  machineId: string,
  ref: string,
  now: number,
): string | null {
  const agent = registeredAgent(sql, machineId, ref);
  if (!agent) return null;
  sql.exec(
    "update agents set live = 0, last_name = name, updated_at = ? where id = ?",
    now,
    agent.id,
  );
  return agent.namespace;
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
  const rows =
    agent.global === 1
      ? all<AgentRow>(
          sql,
          `select ${AGENT_COLS} from agents where org_id = ? and live = 1 order by namespace, name limit ?`,
          OWNER_ORG_ID,
          LIMITS.maxRosterAgents,
        )
      : all<AgentRow>(
          sql,
          `select ${AGENT_COLS} from agents where org_id = ? and namespace = ? and live = 1
           union
           select ${AGENT_COLS} from agents indexed by agents_global_name where org_id = ? and live = 1 and global = 1
           order by namespace, name limit ?`,
          OWNER_ORG_ID,
          agent.namespace,
          OWNER_ORG_ID,
          LIMITS.maxRosterAgents,
        );
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
    });
  }

  #now(): number {
    return this.#clock ?? Date.now();
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

    // One socket per machine: a reconnect replaces the previous one.
    const previous = this.ctx.getWebSockets(machineId);
    for (const old of previous) closeSocket(old, 1000, "replaced");

    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [DAEMON_TAG, machineId]);
    server.serializeAttachment({ machineId } satisfies Attachment);
    // Answered by the runtime, so a keepalive never wakes the hub.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(PING, PONG),
    );
    // The machine's open agents flip from queued to live.
    if (previous.length === 0)
      notifyRoster(
        this.ctx,
        machineNamespaces(this.ctx.storage.sql, machineId),
      );
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const machineId = machineOf(ws);
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
        const changed: string[] = [];
        for (const r of f.closed) {
          const n = agentDown(sql, machineId, r, this.#now());
          if (n !== null) changed.push(n);
        }
        notifyRoster(this.ctx, changed);
        return;
      }
      case "agent_up": {
        const { reply, changed } = agentUp(sql, machineId, f, this.#now());
        sendFrame(ws, reply);
        notifyRoster(this.ctx, changed);
        return;
      }
      case "agent_down": {
        const n = agentDown(sql, machineId, f.agent_ref, this.#now());
        if (n !== null) notifyRoster(this.ctx, [n]);
        return;
      }
      case "list":
        if (sender) sendFrame(ws, roster(this.ctx, sender, f.id));
        return;
      // Mail lands in B6 (send/ack/refuse) and B8 (fetch).
      case "send":
      case "ack":
      case "refuse":
      case "fetch":
        sendError(ws, f.id, "not_found", "Mail is not available yet");
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
    if (!machineId || machineOnline(this.ctx, machineId, ws)) return;
    notifyRoster(this.ctx, machineNamespaces(this.ctx.storage.sql, machineId));
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
