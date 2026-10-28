import type { FastifyReply, FastifyRequest } from "fastify";
import type { Permission } from "@railway/database";
import { needs } from "./viewer.js";

/**
 * Milestone 99 (docs/adr/0022): what each `/api/v1/editor/*` route needs beyond `editor.view`
 * (which the whole editor scope requires). One table here rather than an option on each route,
 * so the editor's write paths are visible in one place. A route not listed needs `editor.view`
 * when it only reads (GET) and `maps.edit` otherwise — a new write route is never open by
 * accident.
 */
export const EDITOR_ROUTE_PERMISSIONS: Record<string, Permission> = {
  "PUT /api/v1/editor/maps/:slug/draft": "maps.edit",
  "POST /api/v1/editor/berths/:tdArea/:berth/clear": "maps.edit",
  "POST /api/v1/editor/maps/:slug/validate": "editor.view",
  "POST /api/v1/editor/maps/:slug/publish": "maps.publish",
};

export function editorRoutePermission(method: string, routeUrl: string): Permission {
  const listed = EDITOR_ROUTE_PERMISSIONS[`${method} ${routeUrl}`];
  if (listed) return listed;
  return method === "GET" || method === "HEAD" ? "editor.view" : "maps.edit";
}

/** preHandler for the editor scope, after the viewer is resolved. */
export async function editorRouteGuard(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const permission = editorRoutePermission(request.method, request.routeOptions.url ?? "");
  await needs(permission)(request, reply);
}
