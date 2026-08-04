import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import { checkConnectivity } from "@railway/database";

export interface HealthDeps {
  pool: Pool;
  redis: Redis;
}

export async function registerHealthRoutes(app: FastifyInstance, deps: HealthDeps): Promise<void> {
  app.get("/health/live", async () => {
    return { status: "ok" };
  });

  app.get("/health/ready", async (_request, reply) => {
    const checks = await Promise.allSettled([checkConnectivity(deps.pool), deps.redis.ping()]);

    const [postgres, redis] = checks;
    const ready = postgres.status === "fulfilled" && redis.status === "fulfilled";

    const body = {
      status: ready ? "ok" : "not-ready",
      postgres: postgres.status === "fulfilled" ? "ok" : "unreachable",
      redis: redis.status === "fulfilled" ? "ok" : "unreachable",
    };

    reply.code(ready ? 200 : 503);
    return body;
  });
}
