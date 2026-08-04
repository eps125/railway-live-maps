import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { registerHealthRoutes } from "./health.js";

function fakePool(ok: boolean): Pool {
  return {
    query: async () => {
      if (!ok) throw new Error("connection refused");
      return { rows: [{ ok: 1 }] };
    },
  } as unknown as Pool;
}

function fakeRedis(ok: boolean): Redis {
  return {
    ping: async () => {
      if (!ok) throw new Error("connection refused");
      return "PONG";
    },
  } as unknown as Redis;
}

describe("health routes", () => {
  it("/health/live always returns ok", async () => {
    const app = Fastify();
    await registerHealthRoutes(app, { pool: fakePool(true), redis: fakeRedis(true) });

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("/health/ready returns 200 when postgres and redis are reachable", async () => {
    const app = Fastify();
    await registerHealthRoutes(app, { pool: fakePool(true), redis: fakeRedis(true) });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", postgres: "ok", redis: "ok" });
  });

  it("/health/ready returns 503 when postgres is unreachable", async () => {
    const app = Fastify();
    await registerHealthRoutes(app, { pool: fakePool(false), redis: fakeRedis(true) });

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "not-ready",
      postgres: "unreachable",
      redis: "ok",
    });
  });
});
