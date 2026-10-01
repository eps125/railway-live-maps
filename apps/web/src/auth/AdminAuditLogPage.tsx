import { useCallback, useEffect, useState } from "react";
import { readApiJson } from "../editor/apiJson.js";

interface AuditEntry {
  id: string;
  occurredAt: string;
  actorUsername: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  clientIp: string | null;
}

/** The action filter's choices: a prefix (`map.`) covers every action on that kind of thing. */
const ACTION_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All actions" },
  { value: "map.", label: "Maps" },
  { value: "map.publish", label: "Map publishes" },
  { value: "user.", label: "Users" },
  { value: "group.", label: "Groups" },
  { value: "region.", label: "Regions" },
  { value: "setting.", label: "Settings" },
  { value: "access.", label: "Access codes" },
];

const londonTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  dateStyle: "medium",
  timeStyle: "medium",
});

/** One-line summary of an entry's details, for the table; the full JSON is a click away. */
function summarise(entry: AuditEntry): string {
  const details = entry.details;
  const name =
    (details.slug as string | undefined) ??
    (details.username as string | undefined) ??
    (details.name as string | undefined) ??
    (details.label as string | undefined);
  return [entry.targetType, name ?? entry.targetId].filter(Boolean).join(" ");
}

/**
 * Milestone 83 (docs/adr/0018): Admin › Audit log — every configuration change made through the
 * site (maps, publishes, users, groups, regions, settings, access codes), newest first. The log
 * itself cannot be edited or deleted.
 */
export function AdminAuditLogPage(): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [user, setUser] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (before: string | null): Promise<void> => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (action) params.set("action", action);
        if (user.trim()) params.set("user", user.trim());
        if (before) params.set("before", before);
        const response = await fetch(`/api/v1/admin/audit-log?${params.toString()}`);
        if (!response.ok) {
          setError(`Failed to load the audit log (${response.status})`);
          return;
        }
        const body = await readApiJson<{ entries: AuditEntry[]; nextCursor: string | null }>(
          response,
        );
        setEntries((current) => (before ? [...current, ...body.entries] : body.entries));
        setNextCursor(body.nextCursor);
        setError(null);
      } catch {
        setError("Failed to load the audit log.");
      } finally {
        setLoading(false);
      }
    },
    [action, user],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchPage(null), 250);
    return () => window.clearTimeout(timer);
  }, [fetchPage]);

  return (
    <div className="admin-users-page audit-log-page">
      <h2>Audit log</h2>
      <div className="audit-log-page__filters">
        <label className="field">
          Action
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            {ACTION_FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          User
          <input
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="username"
          />
        </label>
      </div>

      {error && (
        <p role="alert" className="login-form__error">
          {error}
        </p>
      )}

      {!loading && entries.length === 0 && !error && (
        <p className="panel-card panel-card--empty">Nothing recorded yet.</p>
      )}

      {entries.length > 0 && (
        <div className="table-scroll">
          <table className="users-table">
            <thead>
              <tr>
                <th>When (UK)</th>
                <th>Who</th>
                <th>Action</th>
                <th>What</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.id}
                  className="audit-log-page__row"
                  onClick={() => setOpenId(openId === entry.id ? null : entry.id)}
                >
                  <td>{londonTime.format(new Date(entry.occurredAt))}</td>
                  <td>{entry.actorUsername ?? "—"}</td>
                  <td>
                    <code>{entry.action}</code>
                  </td>
                  <td>
                    {summarise(entry)}
                    {openId === entry.id && (
                      <pre className="audit-log-page__details">
                        {JSON.stringify(entry.details, null, 2)}
                      </pre>
                    )}
                  </td>
                  <td>{entry.clientIp ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {loading && <p className="app-loading">Loading…</p>}
      {!loading && nextCursor && (
        <button type="button" className="btn" onClick={() => void fetchPage(nextCursor)}>
          Older entries
        </button>
      )}
    </div>
  );
}
