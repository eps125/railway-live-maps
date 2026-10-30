import { navigate } from "../useRoute.js";
import { ROUTE_PERMISSIONS, useCan } from "./permissions.js";
import { outagePillClass, outagePillCount, useOutageSummary } from "./useOutageSummary.js";

interface AdminSection {
  title: string;
  path: string;
  /** The route whose permissions (auth/permissions.tsx) show this card. */
  route: string;
  description: string;
}

/** Add an entry here as admin areas are added — the top-level nav keeps one "Admin" link. */
const SECTIONS: AdminSection[] = [
  {
    title: "Maps",
    path: "/admin/maps",
    route: "adminMaps",
    description:
      "Create maps; change a map's name, address, description, region and who can see it; keep " +
      "the region list; group the public map list by region.",
  },
  {
    title: "Users and groups",
    path: "/admin/users",
    route: "adminUsers",
    description:
      "Add users, choose their user type, and put them in groups that can see restricted maps.",
  },
  {
    title: "User types",
    path: "/admin/user-types",
    route: "adminUserTypes",
    description:
      "What each type of user — and the public, and access codes — may do: the permission matrix.",
  },
  {
    title: "Access codes",
    path: "/admin/access",
    route: "adminAccess",
    description:
      "Require an access code to use the site, and create, view, limit and revoke codes; see " +
      "where each code has been used.",
  },
  {
    title: "Audit log",
    path: "/admin/audit-log",
    route: "adminAuditLog",
    description: "Every configuration change made through the site, who made it and when.",
  },
  {
    title: "Berths",
    path: "/admin/berths",
    route: "adminBerths",
    description: "Berth queries, berth steps, the berth explorer and the S-Class explorer.",
  },
  {
    title: "TD boundaries",
    path: "/admin/td-boundaries",
    route: "adminTdBoundaries",
    description: "Where train describer areas meet, so a train keeps its match across them.",
  },
  {
    title: "Data outages",
    path: "/admin/outages",
    route: "adminOutages",
    description:
      "When the train describer feed stopped, for how long, and whether the missing data arrived " +
      "later or was lost; and whether it is down right now.",
  },
  {
    title: "Area maintenance",
    path: "/admin/maintenance",
    route: "adminMaintenance",
    description:
      "Recalculate berth allowances and backfill run links for a train describer area, and " +
      "follow the jobs as they run.",
  },
];

/**
 * Milestone 83: the admin hub. The header's single "Admin" link lands here, so the nav fits a
 * phone however many admin areas there are (same card layout as the Berths hub). Milestone 99:
 * each card shows only with a permission behind it.
 */
export function AdminHubPage(): JSX.Element {
  // Milestone 99: only the areas this user's permissions open.
  const can = useCan();
  const sections = SECTIONS.filter((section) => can(ROUTE_PERMISSIONS[section.route] ?? []));
  const outageSummary = useOutageSummary(can(ROUTE_PERMISSIONS.adminOutages ?? []));
  const outageCount = outagePillCount(outageSummary);
  return (
    <div className="admin-users-page">
      <h2>Admin</h2>
      <div className="berths-hub">
        {sections.map((section) => (
          <a
            key={section.path}
            className="berths-hub__tool"
            href={section.path}
            onClick={(e) => {
              e.preventDefault();
              navigate(section.path);
            }}
          >
            <h3>
              {section.title}
              {section.route === "adminOutages" && outageCount > 0 && (
                <span
                  className={outagePillClass(outageSummary)}
                  aria-label={`${outageCount} not yet seen`}
                >
                  {outageCount}
                </span>
              )}
            </h3>
            <p>{section.description}</p>
          </a>
        ))}
      </div>
    </div>
  );
}
