import { navigate } from "../useRoute.js";
import { useCan } from "./permissions.js";

interface BerthTool {
  title: string;
  path: string;
  /** Milestone 99: the permission that shows this tool. */
  permission: string;
  description: string;
}

/** Add another entry here as more "Berths" tooling ships — the hub page and its layout need no
 * further changes. */
const TOOLS: BerthTool[] = [
  {
    title: "Query Berths",
    path: "/admin/berths/query",
    permission: "tools.berth_query",
    description:
      "Look up every recorded berth-to-berth step for a headcode across one or more train " +
      "describer areas and a date/time range.",
  },
  {
    title: "Berth steps",
    path: "/admin/berths/steps",
    permission: "tools.berth_query",
    description:
      "Give a pair of berths (or just one) and see the date and time of the last 50 steps " +
      "between them (or at it), with each train's description.",
  },
  {
    title: "Berth explorer",
    path: "/admin/berths/explorer",
    permission: "tools.berth_explorer",
    description:
      "See every berth a train describer area has used in the last 7 to 90 days, whether each " +
      "is on a map yet (including combined berths), and each berth's latest steps.",
  },
  {
    title: "S-Class explorer",
    path: "/admin/berths/s-class",
    permission: "tools.s_class",
    description:
      "Watch any train describer area's live S-Class bits, see each bit's history, record what " +
      "a bit is (signal, route, ...) and import published definition tables. Includes " +
      "berth-step timing suggestions to help identify signal bits.",
  },
];

/**
 * Milestone 51: admin-only "Berths" hub — a landing page under the "Berths" nav item so tooling
 * added here later has somewhere to live without growing the top-level nav bar. Each tool is a
 * clickable card (not a plain link list) so the page reads as a small dashboard rather than a
 * bare index.
 */
export function AdminBerthsPage(): JSX.Element {
  const can = useCan();
  return (
    <div className="admin-users-page">
      <h2>Berths</h2>
      <div className="berths-hub">
        {TOOLS.filter((tool) => can(tool.permission)).map((tool) => (
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
