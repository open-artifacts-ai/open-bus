/**
 * Apps the owner linked through /link (agent card, AC4b): the hub signs a
 * card only for a linked `aud` (isLinked). At most MAX_LINKED_APPS: a new app
 * is refused at the cap (never evicting an older link), a relink of a linked
 * app is a no-op that keeps its first linked_at.
 */
import { MAX_LINKED_APPS, OWNER_ORG_ID } from "@ob/shared";

export type LinkedAppRow = { aud: string; linkedAt: number };

export function isLinked(sql: SqlStorage, aud: string): boolean {
  return (
    sql
      .exec(
        "select 1 as x from linked_apps where org_id = ? and aud = ?",
        OWNER_ORG_ID,
        aud,
      )
      .toArray().length > 0
  );
}

/** True when `aud` is linked afterwards; false when it is new and the cap is full. */
export function linkApp(sql: SqlStorage, aud: string, now: number): boolean {
  if (isLinked(sql, aud)) return true;
  const n = sql
    .exec<{ n: number }>(
      "select count(*) as n from linked_apps where org_id = ?",
      OWNER_ORG_ID,
    )
    .one().n;
  if (n >= MAX_LINKED_APPS) return false;
  sql.exec(
    "insert into linked_apps (org_id, aud, linked_at) values (?, ?, ?) on conflict do nothing",
    OWNER_ORG_ID,
    aud,
    now,
  );
  return true;
}

/** Newest first, at most MAX_LINKED_APPS. */
export function listLinkedApps(sql: SqlStorage): LinkedAppRow[] {
  return sql
    .exec<LinkedAppRow>(
      "select aud, linked_at as linkedAt from linked_apps where org_id = ? order by linked_at desc, rowid desc limit ?",
      OWNER_ORG_ID,
      MAX_LINKED_APPS,
    )
    .toArray();
}

/** True when `aud` was linked and now is not. */
export function unlinkApp(sql: SqlStorage, aud: string): boolean {
  return (
    sql.exec(
      "delete from linked_apps where org_id = ? and aud = ?",
      OWNER_ORG_ID,
      aud,
    ).rowsWritten > 0
  );
}
