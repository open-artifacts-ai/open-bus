import { DurableObject } from "cloudflare:workers";
import {
  isId,
  LIMITS,
  MachineLabelSchema,
  newId,
  newMachineToken,
  OWNER_ORG_ID,
} from "@ob/shared";
import type { Env } from "../env.js";
import { sha256Hex } from "./hash.js";
import { MACHINE_COLS, type MachineRow } from "./rows.js";
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
