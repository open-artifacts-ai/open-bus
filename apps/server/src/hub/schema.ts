/**
 * The hub's whole database. Every row in every table carries org_id
 * (OWNER_ORG_ID today, an org id later), and keys that must be unique per org
 * include it. Migrations add columns only: `create ... if not exists` is safe
 * to run on every wake, but it cannot change a key once deployed, so a key
 * change after the first deploy needs a new table.
 *
 * receipts is the durable spine of a message: one row per send, written before
 * any delivery attempt, so an eviction can never make a receipt lie. The body
 * lives in `mail` only when the hub had to store it (miss, oversized, or ack
 * timeout).
 *
 * B7 columns (added in place on an existing table by migrateHub):
 * notified_at is when the sender's machine was told the final state (null:
 * not yet told, replayed on its next agent_up); held_at is when the body was
 * last held in memory for an unacked inline push (null: not held), so a body
 * lost to an eviction is found with an index instead of a scan.
 *
 * oidc_states and meta are the auth storage the hub owns for B1/B1b: one row
 * per consumed OIDC state (replay guard) and the session generation.
 */
export const HUB_SCHEMA = `
create table if not exists machines (
  id text primary key,
  org_id text not null,
  label text not null,
  token_hash text not null unique,
  created_at integer not null,
  last_used integer,
  revoked_at integer
);
create index if not exists machines_org on machines(org_id);
create index if not exists machines_list
  on machines(org_id, (revoked_at is null), created_at);

create table if not exists agents (
  id text primary key,
  org_id text not null,
  namespace text not null,
  name text not null,
  last_name text,
  kind text not null,
  machine_id text not null,
  native_ref text not null,
  global integer not null default 0,
  live integer not null default 0,
  updated_at integer not null,
  unique(machine_id, native_ref)
);
create unique index if not exists agents_live_name
  on agents(org_id, namespace, name) where live = 1;
create unique index if not exists agents_global_name
  on agents(org_id, name) where live = 1 and global = 1;
create index if not exists agents_ns on agents(org_id, namespace, live);
create index if not exists agents_machine on agents(machine_id, live);
-- B5 fix 1: case-insensitive name checks (bus names are ASCII) and the
-- roster_changed fan-out (which machines host a live agent in a namespace).
create index if not exists agents_live_lname
  on agents(org_id, lower(name)) where live = 1;
create index if not exists agents_live_ns_machine
  on agents(org_id, namespace, machine_id) where live = 1;
create index if not exists agents_live_global_machine
  on agents(org_id, machine_id) where live = 1 and global = 1;
-- B6: send resolution also looks up closed agents by name (refused: closed).
create index if not exists agents_lname on agents(org_id, lower(name), live);

create table if not exists receipts (
  id text primary key,
  org_id text not null,
  namespace text not null,
  to_agent text,
  to_name text not null,
  from_agent text not null,
  from_name text not null,
  state text not null,
  reason text,
  size integer not null,
  created_at integer not null,
  expires_at integer not null,
  acked_at integer,
  notified_at integer,
  held_at integer
);
create index if not exists receipts_to on receipts(to_agent, state);
create index if not exists receipts_due on receipts(state, expires_at);

create table if not exists mail (
  id text primary key,
  org_id text not null,
  body text not null,
  created_at integer not null,
  expires_at integer not null
);
create index if not exists mail_due on mail(expires_at);

create table if not exists device_codes (
  user_code text primary key,
  org_id text not null,
  code_hash text not null unique,
  label text not null,
  created_at integer not null,
  expires_at integer not null,
  approved_at integer,
  denied_at integer,
  machine_id text,
  consumed_at integer
);
create index if not exists device_codes_due on device_codes(expires_at);

create table if not exists oidc_states (
  org_id text not null,
  state text not null,
  expires_at integer not null,
  primary key (org_id, state)
);
create index if not exists oidc_states_due on oidc_states(expires_at);

create table if not exists meta (
  org_id text not null,
  key text not null,
  value text not null,
  primary key (org_id, key)
);
`;

const HUB_SCHEMA_B7_INDEXES = `
-- Flush: a recipient's pending mail, oldest first.
create index if not exists receipts_to_age on receipts(to_agent, state, created_at);
-- Lost bodies: pending receipts whose body was held in memory.
create index if not exists receipts_held on receipts(held_at)
  where state = 'pending' and held_at is not null;
-- Replay: a sender's final receipts it was never told about, oldest first.
create index if not exists receipts_unnotified on receipts(from_agent, created_at)
  where notified_at is null and state != 'pending';
-- Retention of final receipts.
create index if not exists receipts_unnotified_due on receipts(expires_at)
  where notified_at is null and state != 'pending';
create index if not exists receipts_notified on receipts(notified_at)
  where notified_at is not null;
`;

/**
 * Add-only migrations for tables created before the column existed, then the
 * indexes on those columns. Idempotent: run on every wake after HUB_SCHEMA.
 * Each statement is a fixed literal (no identifier is concatenated).
 */
export function migrateHub(sql: SqlStorage): void {
  const cols = new Set(
    sql
      .exec<{ name: string }>("select name from pragma_table_info('receipts')")
      .toArray()
      .map((r) => r.name),
  );
  if (!cols.has("notified_at"))
    sql.exec("alter table receipts add column notified_at integer");
  if (!cols.has("held_at"))
    sql.exec("alter table receipts add column held_at integer");
  sql.exec(HUB_SCHEMA_B7_INDEXES);
}
