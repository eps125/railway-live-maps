import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { Redis } from "ioredis";
import { createPool } from "@railway/database";
import type { Config } from "./config.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTdRoutes } from "./routes/td.js";
import { registerMapRoutes } from "./routes/maps.js";
import { registerScheduleRoutes } from "./routes/schedule.js";
import { registerVstpRoutes } from "./routes/vstp.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerCurrentRunRoutes } from "./routes/currentRun.js";
import { registerLiveMapRoutes } from "./routes/liveMap.js";
import { registerEditorRoutes } from "./routes/editor/index.js";
import { createPollingDeltaSource } from "./live/pollingDeltaSource.js";
import { createRedisDeltaSource } from "./live/redisDeltaSource.js";
import type { LiveDeltaSource } from "./live/deltaSource.js";

export interface BuiltServer {
  app: FastifyInstance;
  close: () => Promise<void>;
}

export async function buildServer(config: Config): Promise<BuiltServer> {
  const app = Fastify({ logger: true });

  const pool = createPool({ connectionString: config.DATABASE_URL });
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });

  await app.register(fastifyWebsocket);
  await registerHealthRoutes(app, { pool, redis });
  await registerTdRoutes(app, { pool });
  await registerMapRoutes(app, { pool });
  await registerScheduleRoutes(app, { pool });
  await registerVstpRoutes(app, { pool });
  await registerRunRoutes(app, { pool });
  await registerCurrentRunRoutes(app, { pool });

  // Milestone 6: polling is the default delta source (no extra infrastructure required). When
  // LIVE_WS_REDIS_PUBSUB_ENABLED=true, a *dedicated* subscriber connection is used instead —
  // once an ioredis connection issues SUBSCRIBE it can no longer run other commands, so it must
  // never be the same connection the health check uses.
  let deltaSource: LiveDeltaSource;
  let deltaSubscriberRedis: Redis | undefined;
  if (config.LIVE_WS_REDIS_PUBSUB_ENABLED) {
    deltaSubscriberRedis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    deltaSource = createRedisDeltaSource(deltaSubscriberRedis);
  } else {
    deltaSource = createPollingDeltaSource(pool, config.LIVE_WS_POLL_INTERVAL_MS);
  }

  await registerLiveMapRoutes(app, {
    pool,
    deltaSource,
    heartbeatIntervalMs: config.LIVE_WS_HEARTBEAT_INTERVAL_MS,
    versionCheckIntervalMs: config.LIVE_WS_POLL_INTERVAL_MS,
  });

  // Milestone 11/12: editor routes only exist at all when explicitly enabled
  // (docs/ARCHITECTURE.md §12: "Editor endpoints are disabled or private by default") — when
  // false, `app.register` is simply never called, so every /api/v1/editor/... path 404s.
  if (config.EDITOR_ENABLED) {
    await registerEditorRoutes(app, { pool });
  }

  const close = async (): Promise<void> => {
    await app.close();
    await pool.end();
    redis.disconnect();
    deltaSubscriberRedis?.disconnect();
  };

  return { app, close };
}
