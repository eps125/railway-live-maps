import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCookie from "@fastify/cookie";
import { Redis } from "ioredis";
import { checkPermissionTable, createPool } from "@railway/database";
import type { Config } from "./config.js";
import { resolveCookieSecure } from "./config.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTdRoutes } from "./routes/td.js";
import { registerMapRoutes } from "./routes/maps.js";
import { registerPlaceRoutes } from "./routes/places.js";
import { registerScheduleRoutes } from "./routes/schedule.js";
import { registerVstpRoutes } from "./routes/vstp.js";
import { registerCurrentRunRoutes } from "./routes/currentRun.js";
import { registerLiveMapRoutes } from "./routes/liveMap.js";
import { registerEditorRoutes } from "./routes/editor/index.js";
import { registerCreateMapRoute } from "./routes/editor/createMap.js";
import { registerManageMapRoutes } from "./routes/editor/manageMap.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAdminUserRoutes } from "./routes/admin/users.js";
import { registerTdBoundaryRoutes } from "./routes/admin/tdBoundaries.js";
import { registerOutageRoutes } from "./routes/admin/outages.js";
import { registerMaintenanceRoutes } from "./routes/admin/maintenance.js";
import { registerBerthQueryRoutes } from "./routes/admin/berthQuery.js";
import { registerBerthExplorerRoutes } from "./routes/admin/berthExplorer.js";
import { registerSClassAdminRoutes, registerSClassEditorRoutes } from "./routes/admin/sClass.js";
import { registerSiteAdminRoutes } from "./routes/admin/siteAdmin.js";
import {
  mapAccessForSlug,
  mapVisibilityHook,
  requirePermission,
  resolveViewer,
  siteAccessHook,
  viewerMayUseSite,
} from "./lib/viewer.js";
import { editorRouteGuard } from "./lib/editorPermissions.js";
import { registerUserTypeRoutes } from "./routes/admin/userTypes.js";
import { createSiteAccess } from "./lib/siteAccess.js";
import { registerAccessRoutes } from "./routes/access.js";
import { registerAccessCodeAdminRoutes } from "./routes/admin/accessCodes.js";
import { registerAdminModuleRoutes } from "./routes/editor/moduleRoutes.js";
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
  // Milestone 99 (docs/adr/0022): the permission registry in code and the `permission` table
  // must agree, or a grant could name something the code never checks (or vice versa).
  const permissionDrift = await checkPermissionTable(pool);
  if (permissionDrift.missingFromTable.length > 0 || permissionDrift.unknownInTable.length > 0) {
    await pool.end();
    throw new Error(
      `Permission registry and table disagree (missing from table: ${permissionDrift.missingFromTable.join(", ") || "none"}; unknown in table: ${permissionDrift.unknownInTable.join(", ") || "none"}) — run the migrations`,
    );
  }
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });

  await app.register(fastifyWebsocket);
  await app.register(fastifyCookie);
  // Populated when the viewer is resolved (lib/viewer.ts) for a valid session; null otherwise.
  app.decorateRequest("authSession", null);
  // Milestone 83: who is looking, for map visibility (lib/viewer.ts).
  app.decorateRequest("viewer", null);

  const sessionTtlSeconds = config.SESSION_TTL_SECONDS;
  const cookieSecure = resolveCookieSecure(config);

  // Milestone 84 (docs/adr/0018 §6) / Milestone 99 (docs/adr/0022): guest access codes and the
  // permission matrix. The root hook runs for every request, so a visitor without `site.view`
  // reaches nothing past `/api/v1/auth/*`, `/api/v1/access/*` and the health checks.
  const siteAccess = createSiteAccess(pool);
  const visibilityDeps = { pool, redis, sessionTtlSeconds, siteAccess };
  app.addHook("onRequest", siteAccessHook(visibilityDeps));

  await registerHealthRoutes(app, { pool, redis });
  await registerAuthRoutes(app, {
    pool,
    redis,
    sessionTtlSeconds,
    cookieSecure,
    siteAccess,
    loginRateLimit: {
      maxAttempts: config.LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
      windowSeconds: config.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    },
  });
  await registerAccessRoutes(app, {
    pool,
    redis,
    siteAccess,
    sessionTtlSeconds,
    cookieSecure,
    rateLimit: {
      maxAttempts: config.LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
      windowSeconds: config.LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    },
  });
  await registerTdRoutes(app, { pool });
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

  // Milestone 83 (docs/adr/0018): every public map route, the map list and place search sit in
  // one scope whose hook resolves the viewer and hides a map they may not see (404, before any
  // cache or WebSocket upgrade). Anything reading a map by slug must be registered in here.
  await app.register(async (publicMapScope) => {
    publicMapScope.addHook("preHandler", mapVisibilityHook(visibilityDeps));
    await registerMapRoutes(publicMapScope, { pool });
    await registerPlaceRoutes(publicMapScope, { pool });
    await registerLiveMapRoutes(publicMapScope, {
      pool,
      deltaSource,
      heartbeatIntervalMs: config.LIVE_WS_HEARTBEAT_INTERVAL_MS,
      versionCheckIntervalMs: config.LIVE_WS_POLL_INTERVAL_MS,
      // A map made restricted while someone is watching it closes their socket; so does the end
      // of the viewer's access code (expired, revoked, or the site switched to needing one).
      stillVisible: async (request, slug) => {
        const viewer = await resolveViewer(request, visibilityDeps, { fresh: true });
        return (
          viewerMayUseSite(viewer) && (await mapAccessForSlug(pool, viewer, slug)) !== "hidden"
        );
      },
    });
  });

  // Milestone 29 / 99: editor routes are always registered, behind `editor.view`, with each write
  // route's own permission (`maps.edit`, `maps.publish`) checked from one table
  // (lib/editorPermissions.ts). `app.register` creates an encapsulated Fastify context, so these
  // hooks apply to every route inside it and nothing outside it (docs/ARCHITECTURE.md §12).
  await app.register(async (editorScope) => {
    editorScope.addHook("preHandler", requirePermission("editor.view", visibilityDeps));
    editorScope.addHook("preHandler", editorRouteGuard);
    // Milestone 83: an editor cannot open a map they may not see.
    editorScope.addHook("preHandler", mapVisibilityHook(visibilityDeps));
    await registerEditorRoutes(editorScope, { pool });
    // Milestone 36c: read-only S-Class areas/definitions for binding signals in the editor.
    await registerSClassEditorRoutes(editorScope, { pool });
  });

  // Users, groups, user types, site settings, the audit log and access codes. Each route checks
  // its own permission (`admin.*`, or `maps.manage` for regions and group lists); the scope hook
  // only resolves the viewer.
  await app.register(async (adminScope) => {
    adminScope.addHook(
      "preHandler",
      requirePermission(
        [
          "admin.users",
          "admin.user_types",
          "admin.access_codes",
          "admin.site_settings",
          "admin.audit_log",
          "maps.manage",
        ],
        visibilityDeps,
      ),
    );
    await adminScope.register(async (usersScope) => {
      usersScope.addHook("preHandler", requirePermission("admin.users", visibilityDeps));
      await registerAdminUserRoutes(usersScope, { pool, siteAccess });
    });
    // Milestone 99: user types and the permission matrix.
    await registerUserTypeRoutes(adminScope, { pool, siteAccess });
    // Milestone 83: groups, regions, site settings and the audit log.
    await registerSiteAdminRoutes(adminScope, {
      pool,
      onSettingsChanged: () => siteAccess.invalidate(),
    });
    // Milestone 84: access codes.
    await adminScope.register(async (codesScope) => {
      codesScope.addHook("preHandler", requirePermission("admin.access_codes", visibilityDeps));
      await registerAccessCodeAdminRoutes(codesScope, { pool, siteAccess });
    });
  });

  // The tools (Milestones 36c, 39, 72, 97a) — one permission each.
  await app.register(async (scope) => {
    scope.addHook("preHandler", requirePermission("tools.td_boundaries", visibilityDeps));
    await registerTdBoundaryRoutes(scope, { pool });
  });
  // Data outages (owner request 2026-10-30): the same permission as outage details on the maps.
  await app.register(async (scope) => {
    scope.addHook("preHandler", requirePermission("map.feed_gap_details", visibilityDeps));
    await registerOutageRoutes(scope, { pool });
  });
  await app.register(async (scope) => {
    scope.addHook("preHandler", requirePermission("tools.maintenance", visibilityDeps));
    await registerMaintenanceRoutes(scope, { pool });
  });
  await app.register(async (scope) => {
    scope.addHook("preHandler", requirePermission("tools.berth_query", visibilityDeps));
    await registerBerthQueryRoutes(scope, { pool });
  });
  await app.register(async (scope) => {
    scope.addHook("preHandler", requirePermission("tools.berth_explorer", visibilityDeps));
    await registerBerthExplorerRoutes(scope, { pool });
  });
  // The S-Class explorer and definitions. Authoring/diagnostics only — never feeds displayed
  // signal state. The snapshot route also serves the map's S-Class panel (`map.s_class_panel`);
  // every other route needs `tools.s_class` (checked per route).
  await app.register(async (scope) => {
    scope.addHook(
      "preHandler",
      requirePermission(["tools.s_class", "map.s_class_panel"], visibilityDeps),
    );
    await registerSClassAdminRoutes(scope, { pool });
  });

  // Milestone 30 / owner request 2026-09-13: creating, renaming and deleting maps (`maps.manage`).
  await app.register(async (scope) => {
    scope.addHook("preHandler", requirePermission("maps.manage", visibilityDeps));
    await registerCreateMapRoute(scope, { pool });
    await registerManageMapRoutes(scope, { pool });
  });
  // Milestone 85: make a module from a selection (`maps.manage`); republish every map
  // (`maps.publish`) — checked per route.
  await app.register(async (scope) => {
    scope.addHook("preHandler", requirePermission(["maps.manage", "maps.publish"], visibilityDeps));
    await registerAdminModuleRoutes(scope, { pool });
  });

  const close = async (): Promise<void> => {
    await app.close();
    await siteAccess.close();
    await pool.end();
    redis.disconnect();
    deltaSubscriberRedis?.disconnect();
  };

  return { app, close };
}
