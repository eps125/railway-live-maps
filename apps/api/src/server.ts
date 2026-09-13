import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCookie from "@fastify/cookie";
import { Redis } from "ioredis";
import { createPool } from "@railway/database";
import type { Config } from "./config.js";
import { resolveCookieSecure } from "./config.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTdRoutes } from "./routes/td.js";
import { registerMapRoutes } from "./routes/maps.js";
import { registerScheduleRoutes } from "./routes/schedule.js";
import { registerVstpRoutes } from "./routes/vstp.js";
import { registerCurrentRunRoutes } from "./routes/currentRun.js";
import { registerLiveMapRoutes } from "./routes/liveMap.js";
import { registerEditorRoutes } from "./routes/editor/index.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAdminUserRoutes } from "./routes/admin/users.js";
import { requireRole } from "./auth/requireRole.js";
import { createPollingDeltaSource } from "./live/pollingDeltaSource.js";
import { createRedisDeltaSource } from "./live/redisDeltaSource.js";
import type { LiveDeltaSource } from "./live/deltaSource.js";

export interface BuiltServer {
  app: FastifyInstance;
  close: () => Promise<void>;
}

export async function buildServer(config: Config): Promise<BuiltServer> {
  // Milestone 29: login rate limiting and session cookies need the real client address, not the
  // reverse proxy's — this deployment always sits behind one (docs/ARCHITECTURE.md, Milestone 20's
  // Watchtower/runner setup), so `trustProxy` reading `X-Forwarded-For` is correct here rather than
  // a footgun.
  const app = Fastify({ logger: true, trustProxy: true });

  const pool = createPool({ connectionString: config.DATABASE_URL });
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });

  await app.register(fastifyWebsocket);
  await app.register(fastifyCookie);
  // Populated by requireRole's preHandler once a valid session is found; null for every other
  // request (an unauthenticated one, or a route with no auth gate at all).
  app.decorateRequest("authSession", null);

  const sessionTtlSeconds = config.SESSION_TTL_SECONDS;
  const cookieSecure = resolveCookieSecure(config);

  await registerHealthRoutes(app, { pool, redis });
  await registerAuthRoutes(app, {
    pool,
    redis,
    sessionTtlSeconds,
    cookieSecure,
    loginRateLimit: {
      maxAttempts: config.LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
      windowSeconds: config.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    },
  });
  await registerTdRoutes(app, { pool });
  await registerMapRoutes(app, { pool });
  await registerScheduleRoutes(app, { pool });
  await registerVstpRoutes(app, { pool });
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

  // Milestone 29: editor routes are now always registered (the old `EDITOR_ENABLED` env-var gate
  // is gone) but always require at least the "editor" role — `app.register` here creates an
  // encapsulated Fastify context, so this `addHook` applies to every route `registerEditorRoutes`
  // adds inside it and nothing outside it (docs/ARCHITECTURE.md §12).
  await app.register(async (editorScope) => {
    editorScope.addHook("preHandler", requireRole("editor", { redis, sessionTtlSeconds }));
    await registerEditorRoutes(editorScope, { pool });
  });

  // Admin-only user management (Milestone 29) — same encapsulation trick, one level up.
  await app.register(async (adminScope) => {
    adminScope.addHook("preHandler", requireRole("admin", { redis, sessionTtlSeconds }));
    await registerAdminUserRoutes(adminScope, { pool });
  });

  const close = async (): Promise<void> => {
    await app.close();
    await pool.end();
    redis.disconnect();
    deltaSubscriberRedis?.disconnect();
  };

  return { app, close };
}
