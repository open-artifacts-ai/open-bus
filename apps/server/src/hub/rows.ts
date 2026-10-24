/** A machine as the hub returns it. Never carries the token or its hash. */
export type MachineRow = {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  /** True while the hub holds a socket tagged with this id; always false once revoked. */
  connected: boolean;
};

// AgentRow / ReceiptRow / DeviceCodeRow and AGENT_COLS / RECEIPT_COLS are not
// used in B3; they are kept for B4 (device codes), B5 (agents) and B6–B8 (receipts).

export type AgentRow = {
  id: string;
  namespace: string;
  name: string;
  lastName: string | null;
  kind: string;
  machineId: string;
  nativeRef: string;
  global: number;
  live: number;
  updatedAt: number;
  /** max(receipts.rowid) when the current session began (B11 L1); 0 for older rows. */
  sessionStartRowid: number;
};

export type ReceiptRow = {
  id: string;
  namespace: string;
  toAgent: string | null;
  toName: string;
  fromAgent: string;
  fromName: string;
  state: string;
  reason: string | null;
  size: number;
  createdAt: number;
  expiresAt: number;
};

export type DeviceCodeRow = {
  userCode: string;
  codeHash: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  approvedAt: number | null;
  deniedAt: number | null;
  machineId: string | null;
  consumedAt: number | null;
  lastPolledAt: number | null;
};

/** Fixed column list for DeviceCodeRow (no values). */
export const DEVICE_CODE_COLS =
  "user_code as userCode, code_hash as codeHash, label, created_at as createdAt, expires_at as expiresAt, approved_at as approvedAt, denied_at as deniedAt, machine_id as machineId, consumed_at as consumedAt, last_polled_at as lastPolledAt";

/** Fixed column lists (no values): every value in a query stays a bound parameter. */
export const MACHINE_COLS =
  "id, label, created_at as createdAt, last_used as lastUsedAt, revoked_at as revokedAt";
export const AGENT_COLS =
  "id, namespace, name, last_name as lastName, kind, machine_id as machineId, native_ref as nativeRef, global, live, updated_at as updatedAt, session_start_rowid as sessionStartRowid";
export const RECEIPT_COLS =
  "id, namespace, to_agent as toAgent, to_name as toName, from_agent as fromAgent, from_name as fromName, state, reason, size, created_at as createdAt, expires_at as expiresAt";
