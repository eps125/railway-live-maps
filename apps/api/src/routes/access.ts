import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { mapsForAccessCode, redeemAccessCode } from "@railway/database";
import { apiError } from "../lib/queryRange.js";
import { checkAccessCodeRateLimit } from "../auth/loginRateLimit.js";
import {
  ACCESS_COOKIE_MAX_AGE_SECONDS,
  ACCESS_COOKIE_NAME,
  type SiteAccess,
} from "../lib/siteAccess.js";
import { resolveViewer, viewerMayUseSite, type ViewerDeps } from "../lib/viewer.js";

export interface AccessRoutesDeps extends ViewerDeps {
  pool: Pool;
  redis: Redis;
  siteAccess: SiteAccess;
  cookieSecure: boolean;
  rateLimit: { maxAttempts: number; windowSeconds: number };
}

const REDEEM_ERRORS = {
  unknown: "That code isn't recognised. Check it and try again.",
  revoked: "That code has been withdrawn.",
  expired: "That code has expired.",
  used_up: "That code has already been used as many times as it allows.",
} as const;

/**
 * Milestone 84 (docs/adr/0018 §6): the guest side of access codes. Always reachable, whatever the
 * site mode (the site-access hook lets `/api/v1/access/*` through).
 *
 * - `GET /api/v1/access/status` — the site mode and this visitor's access, so the web app knows
 *   whether to show the code entry page.
 * - `POST /api/v1/access/redeem` `{ code }` — enter a code (rate-limited per IP).
 * - `POST /api/v1/access/leave` — forget this browser's code.
 */
export async function registerAccessRoutes(
  app: FastifyInstance,
  deps: AccessRoutesDeps,
): Promise<void> {
  const { pool, redis, cookieSecure, rateLimit } = deps;

  async function status(request: Parameters<typeof resolveViewer>[0], fresh = false) {
    const viewer = await resolveViewer(request, deps, { fresh });
    const grant = viewer.grant;
    return {
      mode: viewer.siteMode,
      access: viewer.user ? "user" : grant ? "code" : "none",
      allowed: viewerMayUseSite(viewer),
      expiresAt: grant ? grant.expiresAt.toISOString() : null,
      scope: grant?.scope ?? null,
      maps: grant?.scope === "maps" ? await mapsForAccessCode(pool, grant.codeId) : [],
    };
  }

  app.get("/api/v1/access/status", async (request) => status(request));

  app.post<{ Body: { code?: unknown } }>("/api/v1/access/redeem", async (request, reply) => {
    const code = request.body?.code;
    if (typeof code !== "string" || !code.trim() || code.length > 64) {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "code (string) is required");
    }
    const limited = await checkAccessCodeRateLimit(redis, request.ip, rateLimit);
    if (!limited.allowed) {
      reply.code(429);
      reply.header("Retry-After", String(limited.retryAfterSeconds));
      return apiError("RATE_LIMITED", "Too many attempts — try again shortly", {
        retryAfterSeconds: limited.retryAfterSeconds,
      });
    }

    const userAgent = request.headers["user-agent"];
    const client = await pool.connect();
    let result;
    try {
      await client.query("begin");
      result = await redeemAccessCode(client, {
        code,
        ip: request.ip ?? null,
        userAgent: typeof userAgent === "string" ? userAgent : null,
      });
      await client.query(result.ok ? "commit" : "rollback");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    if (!result.ok) {
      reply.code(401);
      return apiError("INVALID_ACCESS_CODE", REDEEM_ERRORS[result.reason], {
        reason: result.reason,
      });
    }

    reply.setCookie(ACCESS_COOKIE_NAME, result.token, {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: "lax",
      path: "/",
      maxAge: ACCESS_COOKIE_MAX_AGE_SECONDS,
    });
    // The status for this request must see the new cookie.
    request.cookies[ACCESS_COOKIE_NAME] = result.token;
    request.viewer = null;
    return status(request, true);
  });

  app.post("/api/v1/access/leave", async (_request, reply) => {
    reply.clearCookie(ACCESS_COOKIE_NAME, { path: "/" });
    reply.code(204);
    return null;
  });
}
