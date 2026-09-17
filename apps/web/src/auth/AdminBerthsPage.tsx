import { navigate } from "../useRoute.js";

interface BerthTool {
  title: string;
  path: string;
  description: string;
}

/** Add another entry here as more "Berths" tooling ships — the hub page and its layout need no
 * further changes. */
const TOOLS: BerthTool[] = [
  {
    title: "Query Berths",
    path: "/admin/berths/query",
    description:
      "Look up every recorded berth-to-berth step for a headcode across one or more train " +
      "describer areas and a date/time range.",
  },
];

/**
 * Milestone 51: admin-only "Berths" hub — a landing page under the "Berths" nav item so tooling
 * added here later has somewhere to live without growing the top-level nav bar. Each tool is a
 * clickable card (not a plain link list) so the page reads as a small dashboard rather than a
 * bare index.
 */
export function AdminBerthsPage(): JSX.Element {
  return (
    <div className="admin-users-page">
      <h2>Berths</h2>
      <div className="berths-hub">
        {TOOLS.map((tool) => (
          <a
            key={tool.path}
            className="berths-hub__tool"
            href={tool.path}
            onClick={(e) => {
              e.preventDefault();
              navigate(tool.path);
            }}
          >
            <h3>{tool.title}</h3>
            <p>{tool.description}</p>
          </a>
        ))}
      </div>
    </div>
  );
}
