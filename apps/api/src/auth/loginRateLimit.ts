import type { Redis } from "ioredis";

/**
 * Milestone 29: "`POST /api/v1/auth/login` (rate-limited)" per the plan — a minimal fixed-window
 * counter scoped to this one route, not the app-wide rate limiting Milestone 13 owns. Keyed by
 * client IP (`server.ts` enables Fastify's `trustProxy` so this is the real client behind the
 * reverse proxy, not the proxy's own address) so one attacker can't lock out every other visitor,
 * and independently by normalized username so a distributed attempt against one account is still
 * caught even from many IPs.
 */
export interface LoginRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

async function checkWindow(
  redis: Redis,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<LoginRateLimitResult> {
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSeconds);
  }
  if (count <= max) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const ttl = await redis.ttl(key);
  return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
}

export async function checkLoginRateLimit(
  redis: Redis,
  ip: string,
  normalizedUsername: string,
  options: { maxAttempts: number; windowSeconds: number },
): Promise<LoginRateLimitResult> {
  const byIp = await checkWindow(
    redis,
    `login-rate:ip:${ip}`,
    options.maxAttempts,
    options.windowSeconds,
  );
  if (!byIp.allowed) return byIp;
  return checkWindow(
    redis,
    `login-rate:user:${normalizedUsername}`,
    options.maxAttempts,
    options.windowSeconds,
  );
}
