import Fastify, { type FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { createPool } from "@railway/database";
import type { Config } from "./config.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTdRoutes } from "./routes/td.js";
import { registerMapRoutes } from "./routes/maps.js";

export interface BuiltServer {
  app: FastifyInstance;
  close: () => Promise<void>;
}

export async function buildServer(config: Config): Promise<BuiltServer> {
  const app = Fastify({ logger: true });

  const pool = createPool({ connectionString: config.DATABASE_URL });
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });

  await registerHealthRoutes(app, { pool, redis });
  await registerTdRoutes(app, { pool });
  await registerMapRoutes(app, { pool });

  const close = async (): Promise<void> => {
    await app.close();
    await pool.end();
    redis.disconnect();
  };

  return { app, close };
}
