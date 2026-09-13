import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { createSession, destroySession, getSession, SESSION_COOKIE_NAME } from "./session.js";

/** Minimal in-memory stand-in for ioredis's `Redis` (this sandbox has no real Redis server —
 * mirrors the FakeRedis pattern in `../live/redisDeltaSource.test.ts`). Only the handful of
 * commands session.ts actually calls. */
class FakeRedis {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  async set(key: string, value: string, _mode: "EX", ttlSeconds: number): Promise<"OK"> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + ttlSeconds * 1000;
    return 1;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  has(key: string): boolean {
    return this.store.has(key);
  }
}

describe("session store", () => {
  it("SESSION_COOKIE_NAME is a stable, non-obvious cookie name", () => {
    expect(SESSION_COOKIE_NAME).toBe("rlm_session");
  });

  it("creates a session and reads it back with the same data", async () => {
    const redis = new FakeRedis();
    const token = await createSession(
      redis as unknown as Redis,
      { userId: "1", username: "matt", role: "admin" },
      3600,
    );

    const session = await getSession(redis as unknown as Redis, token, 3600);
    expect(session).toEqual({ userId: "1", username: "matt", role: "admin" });
  });

  it("returns null for a missing or undefined token, without throwing", async () => {
    const redis = new FakeRedis();
    await expect(getSession(redis as unknown as Redis, undefined, 3600)).resolves.toBeNull();
    await expect(getSession(redis as unknown as Redis, "no-such-token", 3600)).resolves.toBeNull();
  });

  it("destroySession removes the session so a later lookup fails", async () => {
    const redis = new FakeRedis();
    const token = await createSession(
      redis as unknown as Redis,
      { userId: "2", username: "editor1", role: "editor" },
      3600,
    );

    await destroySession(redis as unknown as Redis, token);
    await expect(getSession(redis as unknown as Redis, token, 3600)).resolves.toBeNull();
  });

  it("destroySession on an undefined token is a no-op, not an error", async () => {
    const redis = new FakeRedis();
    await expect(destroySession(redis as unknown as Redis, undefined)).resolves.toBeUndefined();
  });
});
