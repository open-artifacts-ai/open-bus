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
const SESSION_GEN_KEY = "session_gen";

type StoredMachine = Omit<MachineRow, "connected">;

/**
 * The hub: one SQLite Durable Object per owner. B3 holds machines and the
 * auth storage B1/B1b call; later tasks add the socket, mail and alarm paths.
 */
export class Hub extends DurableObject<Env> {
  /** Tests only: a frozen clock so expiry can be exercised without waiting. */
  private clock: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(HUB_SCHEMA);
    });
  }

  protected now(): number {
    return this.clock ?? Date.now();
  }

  /** Tests only. */
  async setClock(ms: number | null): Promise<void> {
    this.clock = ms;
  }

  private all<T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...b: SqlStorageValue[]
  ): T[] {
    return this.ctx.storage.sql.exec<T>(sql, ...b).toArray();
  }

  private one<T extends Record<string, SqlStorageValue>>(
    sql: string,
    ...b: SqlStorageValue[]
  ): T | null {
    return this.all<T>(sql, ...b)[0] ?? null;
  }

  /** True only while the hub holds a socket tagged with the machine id (B5). */
  private withLiveness(m: StoredMachine): MachineRow {
    return {
      ...m,
      connected:
        m.revokedAt === null && this.ctx.getWebSockets(m.id).length > 0,
    };
  }

  // ---------------------------------------------------------------- machines

  /**
   * Called by the device flow once a user code is approved. The label must
   * already pass MachineLabelSchema (callers sanitize with newMachineLabel).
   * Stores only the token's SHA-256 and returns the token once.
   */
  async createMachine(
    label: string,
    id: string = newId(),
  ): Promise<{ id: string; label: string; token: string }> {
    if (!MachineLabelSchema.safeParse(label).success)
      throw new Error("invalid machine label");
    if (!isId(id)) throw new Error("invalid machine id");
    const token = newMachineToken();
    const tokenHash = await sha256Hex(token);
    this.ctx.storage.sql.exec(
      "insert into machines (id, org_id, label, token_hash, created_at) values (?, ?, ?, ?, ?)",
      id,
      OWNER_ORG_ID,
      label,
      tokenHash,
      this.now(),
    );
    return { id, label, token };
  }

  /** One lookup per WebSocket upgrade; last_used is throttled to once an hour. */
  async verifyToken(
    tokenHash: string,
  ): Promise<{ id: string; label: string } | null> {
    const row = this.one<{
      id: string;
      label: string;
      revokedAt: number | null;
      lastUsedAt: number | null;
    }>(
      "select id, label, revoked_at as revokedAt, last_used as lastUsedAt from machines where token_hash = ? and org_id = ? limit 1",
      tokenHash,
      OWNER_ORG_ID,
    );
    if (!row || row.revokedAt !== null) return null;
    const now = this.now();
    if (row.lastUsedAt === null || row.lastUsedAt < now - HOUR_MS)
      this.ctx.storage.sql.exec(
        "update machines set last_used = ? where id = ?",
        now,
        row.id,
      );
    return { id: row.id, label: row.label };
  }

  /** Active and revoked machines, newest first, at most maxMachinesListed. */
  async listMachines(): Promise<MachineRow[]> {
    return this.all<StoredMachine>(
      `select ${MACHINE_COLS} from machines where org_id = ? order by created_at desc, rowid desc limit ?`,
      OWNER_ORG_ID,
      LIMITS.maxMachinesListed,
    ).map((m) => this.withLiveness(m));
  }

  /**
   * The lookup revoke (B9) uses: an unknown or already-revoked machine is null
   * (404). Protected, not private, so it is not dead code until B9 calls it;
   * being synchronous and non-public it is not part of the RPC surface tests use.
   */
  protected machine(id: string): MachineRow | null {
    const m = this.one<StoredMachine>(
      `select ${MACHINE_COLS} from machines where id = ? and org_id = ? and revoked_at is null`,
      id,
      OWNER_ORG_ID,
    );
    return m && this.withLiveness(m);
  }

  // ------------------------------------------------------------ auth storage

  /**
   * Marks an OIDC state as used: true the first time, false on any reuse.
   * Atomic because the DO is single-threaded and the insert is one statement.
   * Also purges a bounded batch of states that expired over an hour ago.
   */
  async consumeState(state: string, expiresAt: number): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "delete from oidc_states where state in (select state from oidc_states where expires_at < ? limit ?)",
      this.now() - STATE_GRACE_MS,
      STATE_PURGE_BATCH,
    );
    const cur = sql.exec(
      "insert into oidc_states (state, org_id, expires_at) values (?, ?, ?) on conflict(state) do nothing",
      state,
      OWNER_ORG_ID,
      expiresAt,
    );
    return cur.rowsWritten > 0;
  }

  /** The current session generation; 0 before the first bump. */
  async sessionGeneration(): Promise<number> {
    return this.readSessionGeneration();
  }

  /** Invalidates every session (logout, revoke-all) and returns the new generation. */
  async bumpSessionGeneration(): Promise<number> {
    const next = this.readSessionGeneration() + 1;
    this.ctx.storage.sql.exec(
      "insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
      SESSION_GEN_KEY,
      String(next),
    );
    return next;
  }

  private readSessionGeneration(): number {
    const row = this.one<{ value: string }>(
      "select value from meta where key = ?",
      SESSION_GEN_KEY,
    );
    return row ? Number(row.value) : 0;
  }
}

/**
 * The Worker and tests see the whole public RPC surface. Every `async` method
 * on `Hub` is callable; private helpers stay private and are not reachable
 * across the boundary.
 */
export type HubStub = Hub;
