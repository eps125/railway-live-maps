import { createContext, useContext, type ReactNode } from "react";

/**
 * Milestone 99 (docs/adr/0022): what this visitor may do — the permission keys from
 * `/api/v1/auth/me` when logged in, else from `/api/v1/access/status` (the public type's, plus an
 * access code's). Used only to show and hide UI: the API enforces every permission itself.
 */
export type PermissionSet = ReadonlySet<string>;

const PermissionsContext = createContext<PermissionSet>(new Set());

export function PermissionsProvider({
  permissions,
  children,
}: {
  permissions: PermissionSet;
  children: ReactNode;
}): JSX.Element {
  return <PermissionsContext.Provider value={permissions}>{children}</PermissionsContext.Provider>;
}

export function usePermissions(): PermissionSet {
  return useContext(PermissionsContext);
}

/** `can("map.playback")`, or `can(["a", "b"])` for any of several. */
export function useCan(): (permission: string | readonly string[]) => boolean {
  const permissions = usePermissions();
  return (permission) =>
    typeof permission === "string"
      ? permissions.has(permission)
      : permission.some((p) => permissions.has(p));
}

/** Every admin-area route and the permissions (any of) that open it. */
export const ROUTE_PERMISSIONS: Record<string, readonly string[]> = {
  adminMaps: ["maps.manage"],
  adminAuditLog: ["admin.audit_log"],
  adminAccess: ["admin.access_codes"],
  adminUsers: ["admin.users"],
  adminUserTypes: ["admin.user_types"],
  adminTdBoundaries: ["tools.td_boundaries"],
  adminBerths: ["tools.berth_query", "tools.berth_explorer", "tools.s_class"],
  adminBerthQuery: ["tools.berth_query"],
  adminBerthSteps: ["tools.berth_query"],
  adminBerthExplorer: ["tools.berth_explorer"],
  adminSClass: ["tools.s_class"],
  adminMaintenance: ["tools.maintenance"],
};

/** The Admin hub opens for anyone who can reach any page in it. */
ROUTE_PERMISSIONS.adminHub = [...new Set(Object.values(ROUTE_PERMISSIONS).flat())];
