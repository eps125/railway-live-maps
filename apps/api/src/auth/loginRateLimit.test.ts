import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { checkLoginRateLimit } from "./loginRateLimit.js";

/** Minimal in-memory stand-in for ioredis's `Redis` — INCR/EXPIRE/TTL only, no real expiry timer
 * (tests don't wait out a real window), matching the FakeRedis pattern used elsewhere in this
 * codebase for a sandbox with no real Redis server. */
class FakeRedis {
  private counters = new Map<string, number>();
  private ttls = new Map<string, number>();

  async incr(key: string): Promise<number> {
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    this.ttls.set(key, ttlSeconds);
    return 1;
  }

  async ttl(key: string): Promise<number> {
    return this.ttls.get(key) ?? -1;
  }
}

describe("checkLoginRateLimit", () => {
  it("allows attempts under the max, then blocks once exceeded", async () => {
    const redis = new FakeRedis() as unknown as Redis;
    const options = { maxAttempts: 3, windowSeconds: 900 };

    for (let i = 0; i < 3; i++) {
      const result = await checkLoginRateLimit(redis, "1.2.3.4", "matt", options);
      expect(result.allowed).toBe(true);
    }

    const blocked = await checkLoginRateLimit(redis, "1.2.3.4", "matt", options);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("scopes counters independently per IP and per username", async () => {
    const redis = new FakeRedis() as unknown as Redis;
    const options = { maxAttempts: 1, windowSeconds: 900 };

    await checkLoginRateLimit(redis, "1.1.1.1", "alice", options);
    // Different IP, different username — neither counter has been touched, so this still passes.
    const result = await checkLoginRateLimit(redis, "2.2.2.2", "bob", options);
    expect(result.allowed).toBe(true);
  });

  it("blocks a distributed attempt against one username even from a fresh IP", async () => {
    const redis = new FakeRedis() as unknown as Redis;
    const options = { maxAttempts: 1, windowSeconds: 900 };

    await checkLoginRateLimit(redis, "1.1.1.1", "alice", options);
    const result = await checkLoginRateLimit(redis, "9.9.9.9", "alice", options);
    expect(result.allowed).toBe(false);
  });
});
