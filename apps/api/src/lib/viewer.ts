import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import {
  isCodeGrantable,
  type AccessCodeMapLimit,
  type Permission,
  type PermissionMatrix,
} from "@railway/database";
import { SESSION_COOKIE_NAME, getSession } from "../auth/session.js";
import { apiError } from "./queryRange.js";
import { ACCESS_COOKIE_NAME, type SiteAccess } from "./siteAccess.js";

/**
 * Who is making a request, and what they may do (Milestone 83 visibility, Milestone 84 access
 * codes, Milestone 99 permissions — docs/adr/0022).
 *
 * A viewer's permissions are the union of the public type's (everyone has those), their user
 * type's (when logged in), and their access code's (when they hold one). Visibility of maps is
 * kept apart for the code's share, because a code can be limited to named maps.
 */
export interface Viewer {
  user: { id: string; username: string; userTypeId: string } | null;
  grant: {
    id: string;
    codeId: string;
    codeLabel: string;
    expiresAt: Date;
    mapLimit: AccessCodeMapLimit;
    /** What the code itself gives (never an admin permission). */
    permissions: ReadonlySet<Permission>;
  } | null;
  /** The public type's permissions plus the user's type's. */
  userPermissions: ReadonlySet<Permission>;
  /** Everything the viewer may do: `userPermissions` plus the code's. */
  permissions: ReadonlySet<Permission>;
}

const NO_PERMISSIONS: ReadonlySet<Permission> = new Set();

/** A visitor with nothing at all — the fallback where no viewer was resolved. */
export const GUEST_VIEWER: Viewer = {
  user: null,
  grant: null,
  userPermissions: NO_PERMISSIONS,
  permissions: NO_PERMISSIONS,
};

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the site-access hook (or `resolveViewer`); `null` until then. */
    viewer: Viewer | null;
  }
}

export interface ViewerDeps {
  redis: Redis;
  sessionTtlSeconds: number;
  siteAccess: SiteAccess;
}

export function can(viewer: Viewer | null | undefined, permission: Permission): boolean {
  return viewer?.permissions.has(permission) ?? false;
}

export function canAny(
  viewer: Viewer | null | undefined,
  permissions: readonly Permission[],
): boolean {
  return permissions.some((p) => can(viewer, p));
}

/** Builds a viewer from its parts and the matrix. Pure, for tests. */
export function buildViewer(
  matrix: PermissionMatrix,
  user: Viewer["user"],
  grant:
    | (Omit<NonNullable<Viewer["grant"]>, "permissions"> & {
        userTypeId: string | null;
        permissions: readonly Permission[];
      })
    | null,
): Viewer {
  // The public type's permissions count only while it holds `site.view`: a site that needs a
  // login or code gives a guest nothing (so a code limited to maps gives exactly its maps), even
  // if the public type keeps other ticks for when the site opens again.
  const publicPermissions = matrix.byType.get(matrix.publicTypeId);
  const userPermissions = new Set<Permission>(
    publicPermissions?.has("site.view") ? publicPermissions : [],
  );
  if (user) for (const p of matrix.byType.get(user.userTypeId) ?? []) userPermissions.add(p);
  let viewerGrant: Viewer["grant"] = null;
  const permissions = new Set(userPermissions);
  if (grant) {
    const granted = grant.userTypeId
      ? [...(matrix.byType.get(grant.userTypeId) ?? [])]
      : grant.permissions;
    // Never trust a stored grant to carry an admin permission (docs/adr/0022 §4).
    const codePermissions = new Set(granted.filter(isCodeGrantable));
    for (const p of codePermissions) permissions.add(p);
    viewerGrant = {
      id: grant.id,
      codeId: grant.codeId,
      codeLabel: grant.codeLabel,
      expiresAt: grant.expiresAt,
      mapLimit: grant.mapLimit,
      permissions: codePermissions,
    };
  }
  return { user, grant: viewerGrant, userPermissions, permissions };
}

/**
 * Resolves (once per request, unless `fresh`) who is making it. A request with no session cookie
 * never touches Redis; one with no access cookie never looks up a grant. A logged-in user's grant
 * cookie, if any, is still read: it can add maps and permissions.
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
  const access = session ? await deps.siteAccess.userAccess(session.userId, options.fresh) : null;
  // A session whose user has since been deactivated or deleted counts as no login at all.
  request.authSession = access ? session : null;
  const matrix = await deps.siteAccess.matrix();
  const grant = await deps.siteAccess.grantForToken(
    request.cookies?.[ACCESS_COOKIE_NAME],
    options.fresh,
  );
  const viewer = buildViewer(
    matrix,
    session && access
      ? { id: session.userId, username: session.username, userTypeId: access.userTypeId }
      : null,
    grant
      ? {
          id: grant.id,
          codeId: grant.codeId,
          codeLabel: grant.codeLabel,
          expiresAt: grant.expiresAt,
          mapLimit: grant.mapLimit,
          userTypeId: grant.grantKind === "user_type" ? grant.userTypeId : null,
          permissions: grant.permissions,
        }
      : null,
  );
  request.viewer = viewer;
  return viewer;
}

/** Without `site.view` a visitor only reaches login, code entry and the health checks. */
export function viewerMayUseSite(viewer: Viewer): boolean {
  return can(viewer, "site.view");
}

/** Who to record as having made a change: the user, or `code:<label>` for a code holder. */
export function actorName(request: FastifyRequest): string | null {
  const viewer = request.viewer;
  if (viewer?.user) return viewer.user.username;
  if (request.authSession) return request.authSession.username;
  if (viewer?.grant) return `code:${viewer.grant.codeLabel}`;
  return null;
}

/**
 * SQL that is true when the viewer may see map row `alias`. `nextParam` is the number of the
 * first placeholder the fragment may use; its values come back in `params`, to append in order.
 * Every map list and map lookup that a viewer reaches must use this one predicate.
 *
 * - `maps.view_all` (public or user type): every map and module.
 * - `maps.view_public`: public maps.
 * - A logged-in user: restricted maps shared with one of their groups.
 * - An access code limited to maps: exactly those maps. Otherwise a code's own `maps.view_all`
 *   opens every map and its `maps.view_public` the public ones. A code never opens a module
 *   (owner, 2026-10-12): modules are parts of maps, not maps.
 */
export function mapVisibilitySql(
  viewer: Viewer,
  alias: string,
  nextParam: number,
): { sql: string; params: unknown[] } {
  const own = viewer.userPermissions;
  if (own.has("maps.view_all")) return { sql: "true", params: [] };

  const clauses: string[] = [];
  const params: unknown[] = [];
  let publicClause = own.has("maps.view_public");
  if (viewer.user) {
    params.push(viewer.user.id);
    clauses.push(`exists (
              select 1 from map_visibility_group mvg
                join app_user_group aug on aug.group_id = mvg.group_id
               where mvg.map_id = ${alias}.id and aug.user_id = $${nextParam + params.length - 1}::bigint)`);
  }
  const grant = viewer.grant;
  if (grant?.mapLimit === "maps") {
    params.push(grant.codeId);
    clauses.push(`(${alias}.kind = 'map' and exists (
              select 1 from access_code_map acm
               where acm.map_id = ${alias}.id and acm.code_id = $${nextParam + params.length - 1}::bigint))`);
  } else if (grant?.permissions.has("maps.view_all")) {
    clauses.push(`${alias}.kind = 'map'`);
  } else if (grant?.permissions.has("maps.view_public")) {
    publicClause = true;
  }
  if (publicClause) clauses.unshift(`${alias}.visibility = 'public'`);
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

async function refuse(
  viewer: Viewer,
  reply: FastifyReply,
  permissions: readonly Permission[],
): Promise<void> {
  if (!viewer.user && !viewer.grant) {
    reply.code(401);
    await reply.send(apiError("UNAUTHENTICATED", "Login required"));
    return;
  }
  reply.code(403);
  await reply.send(
    apiError(
      "FORBIDDEN",
      permissions.length === 1
        ? `Requires the "${permissions[0]}" permission`
        : `Requires one of the permissions: ${permissions.join(", ")}`,
    ),
  );
}

/**
 * Milestone 99: preHandler factory gating a route, or (via `addHook` inside an encapsulated
 * `app.register` scope) a group of routes, behind one permission or any of several. Replaces
 * `requireRole`. Answers 401 to a visitor with no login and no code, 403 to anyone else lacking it.
 */
export function requirePermission(
  permission: Permission | readonly Permission[],
  deps: ViewerDeps,
) {
  const permissions = typeof permission === "string" ? [permission] : permission;
  return async function requirePermissionPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const viewer = await resolveViewer(request, deps);
    if (!canAny(viewer, permissions)) await refuse(viewer, reply, permissions);
  };
}

/**
 * The same check for one route inside a scope whose hook has already resolved the viewer (a
 * route file with no Redis/session dependencies of its own). Fails closed when no viewer was
 * resolved.
 */
export function needs(permission: Permission | readonly Permission[]) {
  const permissions = typeof permission === "string" ? [permission] : permission;
  return async function needsPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const viewer = request.viewer ?? GUEST_VIEWER;
    if (!canAny(viewer, permissions)) await refuse(viewer, reply, permissions);
  };
}

/** API paths a guest may always reach, whatever their permissions: logging in, entering a code,
 * and the health checks. */
const ALWAYS_OPEN_PREFIXES = ["/api/v1/auth/", "/api/v1/access/", "/health/"];

/**
 * Root `onRequest` hook. Without `site.view` every other API request gets
 * `401 ACCESS_CODE_REQUIRED` (the WebSocket upgrade included). A request made with a grant is
 * counted for the code's activity log.
 */
export function siteAccessHook(deps: ViewerDeps) {
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
