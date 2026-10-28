import Fastify, { type FastifyInstance } from "fastify";
import { PERMISSION_KEYS, type Permission } from "@railway/database";
import type { Viewer } from "./viewer.js";

/**
 * Test helper (Milestone 99): a viewer holding exactly `permissions` — every permission by
 * default, like an Admin — for exercising a route's handler directly, without the session and
 * matrix plumbing in front of it.
 */
export function viewerWith(
  permissions: readonly Permission[] = PERMISSION_KEYS,
  user: Viewer["user"] = { id: "0", username: "test-admin", userTypeId: "0" },
): Viewer {
  const set = new Set(permissions);
  return { user, grant: null, userPermissions: set, permissions: set };
}

/** The seeded Basic User permissions — what a guest had on an open site before Milestone 99. */
export const OPEN_SITE_GUEST: readonly Permission[] = [
  "site.view",
  "maps.view_public",
  "map.playback",
  "map.delay_colours",
  "popup.headcode",
  "popup.delay",
  "popup.origin_destination",
  "popup.calling_points",
  "popup.formation",
];

/** A bare Fastify app whose every request is made by `viewer` (an open-site guest by default). */
export function appAs(viewer: Viewer = viewerWith(OPEN_SITE_GUEST, null)): FastifyInstance {
  const app = Fastify();
  app.decorateRequest("viewer", null);
  app.addHook("onRequest", async (request) => {
    request.viewer = viewer;
  });
  return app;
}
