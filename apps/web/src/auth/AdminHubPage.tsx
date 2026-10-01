import { navigate } from "../useRoute.js";

interface AdminSection {
  title: string;
  path: string;
  description: string;
}

/** Add an entry here as admin areas are added — the top-level nav keeps one "Admin" link. */
const SECTIONS: AdminSection[] = [
  {
    title: "Maps",
    path: "/admin/maps",
    description:
      "Create maps; change a map's name, address, description, region and who can see it; keep " +
      "the region list; group the public map list by region.",
  },
  {
    title: "Users and groups",
    path: "/admin/users",
    description: "Add users, set their role, and put them in groups that can see restricted maps.",
  },
  {
    title: "Access codes",
    path: "/admin/access",
    description:
      "Require an access code to use the site, and create, view, limit and revoke codes; see " +
      "where each code has been used.",
  },
  {
    title: "Audit log",
    path: "/admin/audit-log",
    description: "Every configuration change made through the site, who made it and when.",
  },
  {
    title: "Berths",
    path: "/admin/berths",
    description: "Berth queries, berth steps, the berth explorer and the S-Class explorer.",
  },
  {
    title: "TD boundaries",
    path: "/admin/td-boundaries",
    description: "Where train describer areas meet, so a train keeps its match across them.",
  },
];

/**
 * Milestone 83: the admin hub. The header's single "Admin" link lands here, so the nav fits a
 * phone however many admin areas there are (same card layout as the Berths hub).
 */
export function AdminHubPage(): JSX.Element {
  return (
    <div className="admin-users-page">
      <h2>Admin</h2>
      <div className="berths-hub">
        {SECTIONS.map((section) => (
          <a
            key={section.path}
            className="berths-hub__tool"
            href={section.path}
            onClick={(e) => {
              e.preventDefault();
              navigate(section.path);
            }}
          >
            <h3>{section.title}</h3>
            <p>{section.description}</p>
          </a>
        ))}
      </div>
    </div>
  );
}
