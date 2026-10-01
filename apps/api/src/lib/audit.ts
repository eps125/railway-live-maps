import type { FastifyRequest } from "fastify";
import { recordAudit, type Queryable } from "@railway/database";

/**
 * Milestone 83 (docs/adr/0018): writes one admin audit log entry for the request's logged-in
 * user. Pass the transaction's client when the change itself runs in one, so the entry commits
 * (or rolls back) with it.
 */
export async function audit(
  db: Queryable,
  request: FastifyRequest,
  action: string,
  target: { type: string; id: string | null } | null = null,
  details: Record<string, unknown> = {},
): Promise<void> {
  const session = request.authSession;
  await recordAudit(db, {
    actor: { userId: session?.userId ?? null, username: session?.username ?? null },
    action,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    details,
    clientIp: request.ip ?? null,
  });
}
