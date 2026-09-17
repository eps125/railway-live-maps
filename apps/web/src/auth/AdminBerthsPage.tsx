import { navigate } from "../useRoute.js";

/**
 * Milestone 51: admin-only "Berths" hub — a landing page under the "Berths" nav item so tooling
 * added here later (beyond "Query Berths") has somewhere to live without growing the top-level
 * nav bar. Mirrors `AdminUsersPage`/`TdBoundariesPage`'s visual language even though it has no
 * data of its own to load.
 */
export function AdminBerthsPage(): JSX.Element {
  return (
    <div className="admin-users-page">
      <h2>Berths</h2>
      <ul className="admin-berths-page__tools">
        <li>
          <a
            href="/admin/berths/query"
            onClick={(e) => {
              e.preventDefault();
              navigate("/admin/berths/query");
            }}
          >
            Query Berths
          </a>
          <p className="field-hint">
            Look up every recorded berth-to-berth step for a headcode across one or more train
            describer areas and a date/time range.
          </p>
        </li>
      </ul>
    </div>
  );
}
