import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { findUserByUsername, touchLastLogin, verifyPassword } from "@railway/database";
import { apiError } from "../lib/queryRange.js";
import { checkLoginRateLimit } from "../auth/loginRateLimit.js";
import { createSession, destroySession, SESSION_COOKIE_NAME } from "../auth/session.js";
import { requireRole } from "../auth/requireRole.js";

export interface AuthRoutesDeps {
  pool: Pool;
  redis: Redis;
  sessionTtlSeconds: number;
  cookieSecure: boolean;
  loginRateLimit: { maxAttempts: number; windowSeconds: number };
}

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

/**
 * Milestone 29 (docs/IMPLEMENTATION_PLAN.md, docs/API_CONTRACT.md §4a): login/logout/session
 * check. Not gated by `requireRole` itself — `/login` obviously can't be, and `/logout`/`/me` need
 * to work for a request that may or may not currently be authenticated.
 */
export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRoutesDeps,
): Promise<void> {
  const { pool, redis, sessionTtlSeconds, cookieSecure, loginRateLimit } = deps;

  app.post<{ Body: LoginBody }>("/api/v1/auth/login", async (request, reply) => {
    const { username, password } = request.body ?? {};
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "username and password (strings) are required");
    }

    const normalizedUsername = username.trim().toLowerCase();
    const rateLimit = await checkLoginRateLimit(
      redis,
      request.ip,
      normalizedUsername,
      loginRateLimit,
    );
    if (!rateLimit.allowed) {
      reply.code(429);
      reply.header("Retry-After", String(rateLimit.retryAfterSeconds));
      return apiError("RATE_LIMITED", "Too many login attempts — try again shortly", {
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
    }

    const user = await findUserByUsername(pool, username);
    const passwordOk = await verifyPassword(password, user?.passwordHash ?? null);

    if (!user || !user.isActive || !passwordOk) {
      reply.code(401);
      return apiError("INVALID_CREDENTIALS", "Invalid username or password");
    }

    const token = await createSession(
      redis,
      { userId: user.id, username: user.username, role: user.role },
      sessionTtlSeconds,
    );
    await touchLastLogin(pool, user.id);

    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: "lax",
      path: "/",
      maxAge: sessionTtlSeconds,
    });

    return { username: user.username, role: user.role };
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    await destroySession(redis, token);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    reply.code(204);
  });

  // "editor" is the lowest role rank, so this preHandler's only real job here is "is there a
  // valid session at all" — it already returns 401 with the right error shape when not.
  app.get(
    "/api/v1/auth/me",
    { preHandler: requireRole("editor", { redis, sessionTtlSeconds }) },
    async (request) => {
      const session = request.authSession!;
      return { username: session.username, role: session.role };
    },
  );
}
