import type { Queryable } from "./checkpoint.js";

/**
 * Milestone 83 (docs/adr/0018): the admin audit log. `admin_audit_log` is append-only (a trigger
 * rejects update and delete), so this module only ever inserts and reads.
 */

export interface AuditActor {
  userId: string | null;
  username: string | null;
}

export interface AuditEntryInput {
  actor: AuditActor;
  /** Dotted verb, e.g. `map.publish`, `user.update`, `group.create`. */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
  clientIp?: string | null;
}

export interface AuditEntry {
  id: string;
  occurredAt: Date;
  actorUserId: string | null;
  actorUsername: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  clientIp: string | null;
}

interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_user_id: string | null;
  actor_username: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
  client_ip: string | null;
}

export async function recordAudit(db: Queryable, entry: AuditEntryInput): Promise<void> {
  await db.query(
    `insert into admin_audit_log
       (actor_user_id, actor_username, action, target_type, target_id, details, client_ip)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      entry.actor.userId,
      entry.actor.username,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      JSON.stringify(entry.details ?? {}),
      entry.clientIp ?? null,
    ],
  );
}

export interface ListAuditOptions {
  /** Exact action, or a prefix ending in `.` (e.g. `map.`). */
  action?: string | undefined;
  actorUsername?: string | undefined;
  /** Return entries with an id below this (the previous page's `nextCursor`). */
  before?: string | undefined;
  limit: number;
}

export async function listAuditEntries(
  db: Queryable,
  options: ListAuditOptions,
): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
  const action = options.action?.trim() || null;
  const actionIsPrefix = action?.endsWith(".") ?? false;
  const { rows } = await db.query<AuditRow>(
    `select id::text, occurred_at, actor_user_id::text, actor_username, action, target_type,
            target_id, details, client_ip
       from admin_audit_log
      where ($1::text is null or (case when $2 then action like $1 || '%' else action = $1 end))
        and ($3::text is null or actor_username = $3)
        and ($4::bigint is null or id < $4)
      order by id desc
      limit $5`,
    [
      action,
      actionIsPrefix,
      options.actorUsername?.trim().toLowerCase() || null,
      options.before ?? null,
      options.limit + 1,
    ],
  );
  const more = rows.length > options.limit;
  const page = rows.slice(0, options.limit);
  return {
    entries: page.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      actorUserId: row.actor_user_id,
      actorUsername: row.actor_username,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      details: row.details,
      clientIp: row.client_ip,
    })),
    nextCursor: more && page.length > 0 ? page[page.length - 1]!.id : null,
  };
}
