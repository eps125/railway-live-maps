import { useCallback, useEffect, useMemo, useState } from "react";
import { readApiJson } from "../editor/apiJson.js";
import { navigate } from "../useRoute.js";

interface AreaOption {
  tdArea: string;
  lastEventAt: string | null;
}

interface Allocation {
  kind: "published" | "draft";
  mapSlug: string;
  mapName: string;
  elementId: string;
  displayName: string | null;
  combinedOrder: number | null;
  combinedMembers: Array<{ tdArea: string; berth: string }> | null;
}

interface ExplorerBerth {
  berth: string;
  eventsIn: number;
  eventsOut: number;
  activeDays: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastSeenEverAt: string | null;
  allocations: Allocation[];
}

interface BerthsResponse {
  tdArea: string;
  days: number;
  sinceDate: string;
  coverageFromDate: string | null;
  berths: ExplorerBerth[];
}

interface Step {
  id: string;
  eventAt: string;
  description: string | null;
  messageType: string;
  fromBerth: string | null;
  toBerth: string | null;
}

interface StepsResponse {
  steps: Step[];
  next: { before: string; beforeId: string | null } | null;
}

/** The API's own choices (UTC days, today included). */
const WINDOWS = [7, 14, 30, 60, 90] as const;

const FILTERS = [
  { value: "all", label: "All berths" },
  { value: "unallocated", label: "Seen, not on any map" },
  { value: "allocated", label: "On a map" },
  { value: "unseen", label: "On a map, not seen" },
] as const;
type Filter = (typeof FILTERS)[number]["value"];

const STEP_TYPES: Record<string, string> = { CA: "Step", CB: "Cancel", CC: "Interpose" };

/** Europe/London, as every user-facing time in this app (CLAUDE.md rule 4). */
function londonDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await readApiJson<{ error?: { message?: string } }>(response);
  return body.error?.message ?? fallback;
}

function allocationText(a: Allocation, tdArea: string): string {
  const where = `${a.mapName} (${a.kind})${a.displayName ? ` — ${a.displayName}` : ""}`;
  if (!a.combinedMembers) return where;
  const members = a.combinedMembers
    .map((m) => (m.tdArea === tdArea ? m.berth : `${m.tdArea} ${m.berth}`))
    .join(" + ");
  return `${where} · combined: ${members}`;
}

/**
 * Milestone 72: which berths a TD area has used over a window, and whether each is on a map yet —
 * published or draft, alone or in a combined berth. Reads per-day counts, so even a 90-day window
 * and a berth used once in it load quickly. Clicking a berth lists its newest steps, like the
 * S-Class explorer's bit history.
 */
export function BerthExplorerPage(): JSX.Element {
  const [areas, setAreas] = useState<AreaOption[]>([]);
  const [area, setArea] = useState("");
  const [days, setDays] = useState<number>(7);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<BerthsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v1/admin/berth-explorer/areas")
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorMessage(response, "Could not load areas"));
        return readApiJson<{ areas: AreaOption[] }>(response);
      })
      .then((body) => setAreas(body.areas))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load areas"));
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (!area) return;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/v1/admin/berth-explorer/areas/${area}/berths?days=${days}`,
      );
      if (!response.ok) throw new Error(await errorMessage(response, "Could not load berths"));
      setResult(await readApiJson<BerthsResponse>(response));
      setError(null);
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : "Could not load berths");
    } finally {
      setLoading(false);
    }
  }, [area, days]);

  useEffect(() => {
    setResult(null);
    void load();
  }, [load]);

  useEffect(() => setSelected(null), [area]);

  const visible = useMemo(() => {
    const term = search.trim().toUpperCase();
    return (result?.berths ?? []).filter((b) => {
      if (term && !b.berth.includes(term)) return false;
      const seen = b.lastSeenAt !== null;
      const onMap = b.allocations.length > 0;
      if (filter === "unallocated") return seen && !onMap;
      if (filter === "allocated") return onMap;
      if (filter === "unseen") return onMap && !seen;
      return true;
    });
  }, [result, filter, search]);

  const counts = useMemo(() => {
    const berths = result?.berths ?? [];
    return {
      seen: berths.filter((b) => b.lastSeenAt !== null).length,
      unallocated: berths.filter((b) => b.lastSeenAt !== null && b.allocations.length === 0).length,
      unseen: berths.filter((b) => b.lastSeenAt === null).length,
    };
  }, [result]);

  const selectedBerth = result?.berths.find((b) => b.berth === selected) ?? null;

  return (
    <div className="admin-users-page s-class-page">
      <p>
        <a
          href="/admin/berths"
          onClick={(e) => {
            e.preventDefault();
            navigate("/admin/berths");
          }}
        >
          ← Berths
        </a>
      </p>
      <h2>Berth explorer</h2>
      <p className="field-hint">
        Every berth a train describer area has used in the window, and whether it is on a map yet
        (published or draft, alone or as part of a combined berth). &ldquo;In&rdquo; counts steps
        and interposes into the berth; &ldquo;out&rdquo; counts steps and cancels out of it. Days
        are UTC days, today included. Select a berth to see its latest steps.
      </p>

      <div className="panel-card s-class-toolbar">
        <label className="field">
          TD area
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">— choose —</option>
            {areas.map((a) => (
              <option key={a.tdArea} value={a.tdArea}>
                {a.tdArea}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Window
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {WINDOWS.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Show
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Berth
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="filter, e.g. 38"
          />
        </label>
      </div>

      {error ? (
        <p role="alert" className="login-form__error">
          {error}
        </p>
      ) : null}
      {loading && !result ? <p className="field-hint">Loading…</p> : null}

      {result ? (
        <>
          <p className="field-hint">
            {counts.seen} berths seen in {result.tdArea} since {result.sinceDate} (UTC),{" "}
            {counts.unallocated} of them on no map; {counts.unseen} mapped berths not seen.
            {result.coverageFromDate && result.coverageFromDate > result.sinceDate
              ? ` Counts for ${result.tdArea} only go back to ${result.coverageFromDate}.`
              : ""}
          </p>
          <div className="s-class-layout">
            <table
              className="users-table berth-explorer-table"
              aria-label={`${result.tdArea} berths`}
            >
              <thead>
                <tr>
                  <th>Berth</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Days</th>
                  <th>Last seen (UK)</th>
                  <th>Map</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((b) => (
                  <tr
                    key={b.berth}
                    className={[
                      "berth-explorer-row",
                      b.berth === selected ? "berth-explorer-row--selected" : "",
                      b.lastSeenAt === null ? "berth-explorer-row--unseen" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <td>
                      <button
                        type="button"
                        className="link-button mono"
                        onClick={() => setSelected(b.berth)}
                      >
                        {b.berth}
                      </button>
                    </td>
                    <td>{b.eventsIn}</td>
                    <td>{b.eventsOut}</td>
                    <td>{b.activeDays}</td>
                    <td>
                      {b.lastSeenAt
                        ? londonDateTime(b.lastSeenAt)
                        : b.lastSeenEverAt
                          ? `not in window (last ${londonDateTime(b.lastSeenEverAt)})`
                          : "never seen"}
                    </td>
                    <td>
                      {b.allocations.length === 0 ? (
                        <span className="berth-explorer-tag berth-explorer-tag--none">
                          not on a map
                        </span>
                      ) : (
                        b.allocations.map((a) => (
                          <span
                            key={`${a.kind}|${a.mapSlug}|${a.elementId}`}
                            className={`berth-explorer-tag berth-explorer-tag--${a.kind}`}
                          >
                            {allocationText(a, result.tdArea)}
                          </span>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="s-class-side">
              {selectedBerth ? (
                <BerthPanel
                  key={`${result.tdArea}:${selectedBerth.berth}`}
                  tdArea={result.tdArea}
                  berth={selectedBerth}
                />
              ) : (
                <p className="panel-card panel-card--empty">Select a berth to see its steps.</p>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function BerthPanel({ tdArea, berth }: { tdArea: string; berth: ExplorerBerth }): JSX.Element {
  const [steps, setSteps] = useState<Step[]>([]);
  const [next, setNext] = useState<StepsResponse["next"]>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/v1/admin/berth-explorer/areas/${tdArea}/berths/${encodeURIComponent(berth.berth)}/steps`;

  const fetchPage = useCallback(
    async (cursor: StepsResponse["next"]): Promise<void> => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: "30" });
        if (cursor) {
          params.set("before", cursor.before);
          if (cursor.beforeId) params.set("beforeId", cursor.beforeId);
        }
        const response = await fetch(`${base}?${params.toString()}`);
        if (!response.ok) throw new Error(await errorMessage(response, "Could not load steps"));
        const body = await readApiJson<StepsResponse>(response);
        setSteps((previous) => (cursor ? [...previous, ...body.steps] : body.steps));
        setNext(body.next);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load steps");
      } finally {
        setLoading(false);
      }
    },
    [base],
  );

  useEffect(() => {
    void fetchPage(null);
  }, [fetchPage]);

  return (
    <div className="panel-card">
      <h3>
        {tdArea} <span className="mono">{berth.berth}</span>
      </h3>
      {berth.allocations.length === 0 ? (
        <p className="field-hint">Not on any map.</p>
      ) : (
        <ul className="berth-explorer-allocations">
          {berth.allocations.map((a) => (
            <li key={`${a.kind}|${a.mapSlug}|${a.elementId}`}>{allocationText(a, tdArea)}</li>
          ))}
        </ul>
      )}
      <h4>Latest steps</h4>
      {error ? (
        <p role="alert" className="login-form__error">
          {error}
        </p>
      ) : null}
      {!loading && steps.length === 0 && !error ? (
        <p className="field-hint">No steps recorded for this berth.</p>
      ) : null}
      {steps.length > 0 ? (
        <table className="users-table" aria-label={`Steps at ${berth.berth}`}>
          <thead>
            <tr>
              <th>Time (UK)</th>
              <th>Descr</th>
              <th>From</th>
              <th>To</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s) => (
              <tr key={s.id}>
                <td>{londonDateTime(s.eventAt)}</td>
                <td className="mono">{s.description ?? ""}</td>
                <td className="mono">{s.fromBerth ?? ""}</td>
                <td className="mono">{s.toBerth ?? ""}</td>
                <td title={s.messageType}>{STEP_TYPES[s.messageType] ?? s.messageType}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {loading ? <p className="field-hint">Loading…</p> : null}
      {next && !loading ? (
        <button type="button" className="btn" onClick={() => void fetchPage(next)}>
          Load more
        </button>
      ) : null}
    </div>
  );
}
