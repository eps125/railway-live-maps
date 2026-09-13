import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";
import type { UserRole } from "@railway/database";

/**
 * Milestone 29: server-side sessions live only in Redis (CLAUDE.md: "Redis only for ephemeral
 * pub/sub, cache and coordination... never as source of truth") — `app_user` in Postgres is the
 * durable identity/role record, this is just "who is currently logged in," fine to lose on a
 * Redis restart (that just forces a re-login). The cookie carries nothing but an opaque, unguessable
 * random token that indexes this store — there is nothing to forge or tamper with client-side.
 */
export const SESSION_COOKIE_NAME = "rlm_session";

export interface SessionData {
  userId: string;
  username: string;
  role: UserRole;
}

function sessionKey(token: string): string {
  return `session:${token}`;
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export async function createSession(
  redis: Redis,
  data: SessionData,
  ttlSeconds: number,
): Promise<string> {
  const token = generateSessionToken();
  await redis.set(sessionKey(token), JSON.stringify(data), "EX", ttlSeconds);
  return token;
}

/** Looks up a session and, if found, slides its expiry forward another `ttlSeconds` — an active
 * user never gets logged out mid-session, only one genuinely idle past the TTL does. */
export async function getSession(
  redis: Redis,
  token: string | undefined,
  ttlSeconds: number,
): Promise<SessionData | null> {
  if (!token) return null;
  const raw = await redis.get(sessionKey(token));
  if (!raw) return null;
  await redis.expire(sessionKey(token), ttlSeconds);
  try {
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

export async function destroySession(redis: Redis, token: string | undefined): Promise<void> {
  if (!token) return;
  await redis.del(sessionKey(token));
}
