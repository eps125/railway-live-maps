import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import type { AccessCodeScope, SiteAccessMode, UserRole } from "@railway/database";
import { SESSION_COOKIE_NAME, getSession } from "../auth/session.js";
import { apiError } from "./queryRange.js";
import { ACCESS_COOKIE_NAME, type SiteAccess } from "./siteAccess.js";

/**
 * Milestone 83 (docs/adr/0018): who is looking, for map visibility — a logged-in user (any role)
 * or a guest. Milestone 84 adds the guest's access-code grant, if any, and the site access mode.
 */
export interface Viewer {
  user: { id: string; username: string; role: UserRole } | null;
  grant: { id: string; codeId: string; scope: AccessCodeScope; expiresAt: Date } | null;
  siteMode: SiteAccessMode;
}

export const GUEST_VIEWER: Viewer = { user: null, grant: null, siteMode: "open" };

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the site-access / map-visibility hooks (or `resolveViewer`); `null` until then. */
    viewer: Viewer | null;
  }
}

export interface ViewerDeps {
  redis: Redis;
  sessionTtlSeconds: number;
  /** Milestone 84. Absent (unit tests) means open mode with no access codes. */
  siteAccess?: SiteAccess;
}

/**
 * Resolves (once per request, unless `fresh`) who is making it. A request with no session cookie
 * never touches Redis; one with no access cookie never looks up a grant. A logged-in user's grant
 * cookie, if any, is still read: it can add maps.
 */
export async function resolveViewer(
  request: FastifyRequest,
  deps: ViewerDeps,
  options: { fresh?: boolean } = {},
): Promise<Viewer> {
  if (request.viewer && !options.fresh) return request.viewer;
  let session = options.fresh ? null : request.authSession;
  if (!session) {
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    session = token ? await getSession(deps.redis, token, deps.sessionTtlSeconds) : null;
  }
  const siteMode = deps.siteAccess ? await deps.siteAccess.siteMode() : "open";
  const grant = deps.siteAccess
    ? await deps.siteAccess.grantForToken(request.cookies?.[ACCESS_COOKIE_NAME], options.fresh)
    : null;
  const viewer: Viewer = {
    user: session ? { id: session.userId, username: session.username, role: session.role } : null,
    grant: grant
      ? { id: grant.id, codeId: grant.codeId, scope: grant.scope, expiresAt: grant.expiresAt }
      : null,
    siteMode,
  };
  request.viewer = viewer;
  return viewer;
}

/** In `code_required` mode only a logged-in user or a valid grant may use the site. */
export function viewerMayUseSite(viewer: Viewer): boolean {
  return viewer.siteMode === "open" || viewer.user !== null || viewer.grant !== null;
}

/**
 * SQL that is true when the viewer may see map row `alias`. `nextParam` is the number of the
 * first placeholder the fragment may use; its values come back in `params`, to append in order.
 * Every map list and map lookup that a viewer reaches must use this one predicate.
 *
 * - Admins: every map.
 * - Public maps: everyone — except a guest whose code names specific maps while the site needs a
 *   code (that code gives exactly its maps).
 * - Restricted maps: members of a group they are shared with, and holders of a code naming them.
 */
export function mapVisibilitySql(
  viewer: Viewer,
  alias: string,
  nextParam: number,
): { sql: string; params: unknown[] } {
  const user = viewer.user;
  if (user?.role === "admin") return { sql: "true", params: [] };

  const clauses: string[] = [];
  const params: unknown[] = [];
  const mapsOnlyGuest =
    !user && viewer.siteMode === "code_required" && viewer.grant?.scope === "maps";
  if (!mapsOnlyGuest) clauses.push(`${alias}.visibility = 'public'`);
  if (user) {
    params.push(user.id);
    clauses.push(`exists (
              select 1 from map_visibility_group mvg
                join app_user_group aug on aug.group_id = mvg.group_id
               where mvg.map_id = ${alias}.id and aug.user_id = $${nextParam + params.length - 1}::bigint)`);
  }
  if (viewer.grant?.scope === "maps") {
    params.push(viewer.grant.codeId);
    clauses.push(`exists (
              select 1 from access_code_map acm
               where acm.map_id = ${alias}.id and acm.code_id = $${nextParam + params.length - 1}::bigint)`);
  }
  if (clauses.length === 0) return { sql: "false", params: [] };
  return { sql: clauses.length === 1 ? clauses[0]! : `(${clauses.join(" or ")})`, params };
}

export type MapAccess = "visible" | "hidden" | "missing";

export async function mapAccessForSlug(
  pool: Pool,
  viewer: Viewer,
  slug: string,
): Promise<MapAccess> {
  const predicate = mapVisibilitySql(viewer, "m", 2);
  const result = await pool.query<{ visible: boolean }>(
    `select ${predicate.sql} as visible from map m where m.slug = $1`,
    [slug, ...predicate.params],
  );
  const row = result.rows[0];
  if (!row) return "missing";
  return row.visible ? "visible" : "hidden";
}

export interface MapVisibilityHookDeps extends ViewerDeps {
  pool: Pool;
}

/**
 * preHandler for a scope of routes: resolves the viewer for every request, and for a route with a
 * `:slug` param answers 404 `MAP_NOT_FOUND` when the map exists but the viewer may not see it —
 * the same answer as a map that doesn't exist, so a hidden map's existence never leaks. A slug
 * with no `map` row passes through, so each route's own not-found handling still applies.
 * Runs before any cache in the route, and before a WebSocket upgrade.
 */
export function mapVisibilityHook(deps: MapVisibilityHookDeps) {
  return async function mapVisibilityPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const viewer = await resolveViewer(request, deps);
    const slug = (request.params as { slug?: unknown } | undefined)?.slug;
    if (typeof slug !== "string") return;
    if ((await mapAccessForSlug(deps.pool, viewer, slug)) === "hidden") {
      reply.code(404);
      await reply.send(apiError("MAP_NOT_FOUND", `No map "${slug}" is available`));
    }
  };
}

/** API paths a guest may always reach, whatever the site mode: logging in, entering a code,
 * and the health checks. */
const ALWAYS_OPEN_PREFIXES = ["/api/v1/auth/", "/api/v1/access/", "/health/"];

/**
 * Milestone 84: root `onRequest` hook. When the site needs an access code, every other API
 * request from a guest without a valid grant gets `401 ACCESS_CODE_REQUIRED` (the WebSocket
 * upgrade included). A request made with a grant is counted for the code's activity log.
 */
export function siteAccessHook(deps: ViewerDeps & { siteAccess: SiteAccess }) {
  return async function siteAccessOnRequest(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const path = request.url.split("?")[0] ?? "";
    if (ALWAYS_OPEN_PREFIXES.some((prefix) => path.startsWith(prefix))) return;
    const viewer = await resolveViewer(request, deps);
    if (viewer.grant) {
      const userAgent = request.headers["user-agent"];
      deps.siteAccess.noteActivity(
        viewer.grant.id,
        request.ip,
        typeof userAgent === "string" ? userAgent : null,
      );
    }
    if (!viewerMayUseSite(viewer)) {
      reply.code(401);
      await reply.send(
        apiError("ACCESS_CODE_REQUIRED", "This site needs an access code. Enter one to continue."),
      );
    }
  };
}
