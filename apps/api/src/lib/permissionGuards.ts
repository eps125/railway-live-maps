import type { Permission, PermissionMatrix } from "@railway/database";
import type { Viewer } from "./viewer.js";

/**
 * Milestone 99 (docs/adr/0022 §3) escalation guard: nobody can hand out more than they hold. A
 * user may give (or change, or remove) a user type, or give an access code a permission set, only
 * when they hold every permission in it themselves.
 */
export function permissionsWithinViewer(
  permissions: Iterable<Permission>,
  viewer: Viewer,
): boolean {
  for (const p of permissions) if (!viewer.permissions.has(p)) return false;
  return true;
}

/** False for an unknown type, so a bad id is never waved through. */
export function typeWithinViewer(
  matrix: PermissionMatrix,
  typeId: string,
  viewer: Viewer,
): boolean {
  const permissions = matrix.byType.get(typeId);
  return permissions !== undefined && permissionsWithinViewer(permissions, viewer);
}
