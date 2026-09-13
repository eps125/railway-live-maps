import { describe, expect, it } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { createSession } from "./session.js";
import { requireRole } from "./requireRole.js";

class FakeRedis {
  private store = new Map<string, string>();

  async set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, value);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async expire(): Promise<number> {
    return 1;
  }
}

function fakeRequest(cookieValue: string | undefined): FastifyRequest {
  return {
    cookies: cookieValue === undefined ? {} : { rlm_session: cookieValue },
  } as unknown as FastifyRequest;
}

function fakeReply(): FastifyReply & { statusCode?: number; body?: unknown } {
  const reply: Partial<FastifyReply> & { statusCode?: number; body?: unknown } = {
    code(status: number) {
      reply.statusCode = status;
      return reply as FastifyReply;
    },
    send(payload: unknown) {
      reply.body = payload;
      return reply as FastifyReply;
    },
  };
  return reply as FastifyReply & { statusCode?: number; body?: unknown };
}

describe("requireRole", () => {
  const deps = { sessionTtlSeconds: 3600 };

  it("401s with no cookie at all", async () => {
    const redis = new FakeRedis() as unknown as Redis;
    const request = fakeRequest(undefined);
    const reply = fakeReply();

    await requireRole("editor", { redis, ...deps })(request, reply);

    expect(reply.statusCode).toBe(401);
    expect(request.authSession).toBeNull();
  });

  it("401s for a cookie that doesn't match any session", async () => {
    const redis = new FakeRedis() as unknown as Redis;
    const request = fakeRequest("bogus-token");
    const reply = fakeReply();

    await requireRole("editor", { redis, ...deps })(request, reply);

    expect(reply.statusCode).toBe(401);
  });

  it("403s an editor session against an admin-only route, without touching authSession's role", async () => {
    const redis = new FakeRedis() as unknown as Redis;
    const token = await createSession(redis, { userId: "1", username: "ed", role: "editor" }, 3600);
    const request = fakeRequest(token);
    const reply = fakeReply();

    await requireRole("admin", { redis, ...deps })(request, reply);

    expect(reply.statusCode).toBe(403);
    expect(request.authSession).toEqual({ userId: "1", username: "ed", role: "editor" });
  });

  it("passes an admin session through both editor and admin gates, setting no status code", async () => {
    const redis = new FakeRedis() as unknown as Redis;
    const token = await createSession(
      redis,
      { userId: "2", username: "boss", role: "admin" },
      3600,
    );

    for (const minRole of ["editor", "admin"] as const) {
      const request = fakeRequest(token);
      const reply = fakeReply();
      await requireRole(minRole, { redis, ...deps })(request, reply);
      expect(reply.statusCode).toBeUndefined();
      expect(request.authSession?.role).toBe("admin");
    }
  });
});
