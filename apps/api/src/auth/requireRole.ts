import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { roleSatisfies, type UserRole } from "@railway/database";
import { apiError } from "../lib/queryRange.js";
import { SESSION_COOKIE_NAME, getSession, type SessionData } from "./session.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `requireRole`'s preHandler once a valid session is found. `null` until then. */
    authSession: SessionData | null;
  }
}

export interface RequireRoleDeps {
  redis: Redis;
  sessionTtlSeconds: number;
}

/**
 * Fastify preHandler factory gating a route (or, applied via `app.addHook` inside an encapsulated
 * `app.register(...)` scope, a whole group of routes) behind a minimum role. Replaces the old
 * `EDITOR_ENABLED` env-var gate (Milestone 11) — routes are now always registered, and always
 * behind real authentication instead of a boolean.
 */
export function requireRole(minRole: UserRole, deps: RequireRoleDeps) {
  return async function requireRolePreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = request.cookies[SESSION_COOKIE_NAME];
    const session = await getSession(deps.redis, token, deps.sessionTtlSeconds);
    request.authSession = session;

    if (!session) {
      reply.code(401);
      await reply.send(apiError("UNAUTHENTICATED", "Login required"));
      return;
    }
    if (!roleSatisfies(session.role, minRole)) {
      reply.code(403);
      await reply.send(apiError("FORBIDDEN", `Requires the "${minRole}" role or higher`));
      return;
    }
  };
}
