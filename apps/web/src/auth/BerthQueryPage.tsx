import { useState } from "react";
import { readApiJson } from "../editor/apiJson.js";
import { navigate } from "../useRoute.js";

interface BerthEvent {
  id: string;
  tdArea: string;
  messageType: string;
  fromBerth: string | null;
  toBerth: string | null;
  description: string | null;
  eventAt: string;
  ingestionSequence: string;
}

interface ErrorBody {
  error?: { message?: string };
}

async function extractError(response: Response, fallback: string): Promise<string> {
  const body = await readApiJson<ErrorBody>(response);
  return body.error?.message ?? fallback;
}

const STEP_LABELS: Record<string, string> = {
  CA: "Berth step (CA)",
  CB: "Berth interpose (CB)",
  CC: "Berth cancel (CC)",
  CT: "Timestamp (CT)",
};

function stepLabel(messageType: string): string {
  return STEP_LABELS[messageType] ?? messageType;
}

/** Mirrors the server's own `tdAreas` parsing (`apps/api/src/routes/admin/berthQuery.ts`) so the
 * client-side "at least one area" check agrees with what the API will actually accept. */
function parseAreas(value: string): string[] {
  return value
    .split(",")
    .map((area) => area.trim().toUpperCase())
    .filter((area) => area.length > 0);
}

/**
 * Milestone 51: admin-only "Query Berths" tool — the web-app replacement for asking for a one-off
 * SQL query against `td_berth_event` by hand. Queries the raw C-Class event log directly (not the
 * `berth_occupancy` projection), so results show every individual step (from/to berth, step type)
 * in time order across one or more TD areas for a given headcode/description and time range.
 */
export function BerthQueryPage(): JSX.Element {
  const [areasInput, setAreasInput] = useState("");
  const [headcode, setHeadcode] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [events, setEvents] = useState<BerthEvent[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  function buildQueryUrl(areas: string[], after: string | null): string {
    const params = new URLSearchParams();
    params.set("tdAreas", areas.join(","));
    params.set("headcode", headcode.trim().toUpperCase());
    if (from) params.set("from", new Date(from).toISOString());
    if (to) params.set("to", new Date(to).toISOString());
    if (after) params.set("after", after);
    return `/api/v1/admin/berths/query?${params.toString()}`;
  }

  async function handleSearch(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const areas = parseAreas(areasInput);
    if (areas.length === 0) {
      setSearchError("Enter at least one train describer area.");
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const response = await fetch(buildQueryUrl(areas, null));
      if (!response.ok) {
        setEvents(null);
        setNextCursor(null);
        setSearchError(await extractError(response, "Search failed."));
        return;
      }
      const body = await readApiJson<{ events: BerthEvent[]; nextCursor: string | null }>(response);
      setEvents(body.events);
      setNextCursor(body.nextCursor);
    } catch {
      setEvents(null);
      setNextCursor(null);
      setSearchError("Search failed.");
    } finally {
      setSearching(false);
    }
  }

  async function handleLoadMore(): Promise<void> {
    if (!nextCursor) return;
    setSearching(true);
    setSearchError(null);
    try {
      const response = await fetch(buildQueryUrl(parseAreas(areasInput), nextCursor));
      if (!response.ok) {
        setSearchError(await extractError(response, "Search failed."));
        return;
      }
      const body = await readApiJson<{ events: BerthEvent[]; nextCursor: string | null }>(response);
      setEvents((prev) => [...(prev ?? []), ...body.events]);
      setNextCursor(body.nextCursor);
    } catch {
      setSearchError("Search failed.");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="admin-users-page berth-query-page">
      <h2>Query Berths</h2>
      <p className="field-hint">
        <a
          href="/admin/berths"
          onClick={(e) => {
            e.preventDefault();
            navigate("/admin/berths");
          }}
        >
          Berths
        </a>{" "}
        &gt; Query Berths
      </p>
      <p className="field-hint">
        Raw berth-to-berth steps for a headcode, in time order. Times are shown in your browser's
        local time; the maximum range per search is 7 days.
      </p>

      <form className="panel-card" onSubmit={(e) => void handleSearch(e)}>
        <label className="field">
          Train describer area(s)
          <input
            type="text"
            value={areasInput}
            onChange={(e) => setAreasInput(e.target.value)}
            placeholder="e.g. PX, LA"
          />
        </label>

        <label className="field">
          Headcode
          <input
            type="text"
            value={headcode}
            onChange={(e) => setHeadcode(e.target.value)}
            placeholder="e.g. 1A23"
            required
          />
        </label>

        <label className="field">
          From
          <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>

        <label className="field">
          To
          <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>

        {searchError && (
          <p role="alert" className="login-form__error">
            {searchError}
          </p>
        )}

        <button type="submit" className="btn btn--primary" disabled={searching}>
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      {events !== null && events.length === 0 && (
        <p className="panel-card panel-card--empty">No matching berth events.</p>
      )}

      {events !== null && events.length > 0 && (
        <>
          <table className="users-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>TD area</th>
                <th>Step</th>
                <th>From berth</th>
                <th>To berth</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>{new Date(event.eventAt).toLocaleString()}</td>
                  <td>{event.tdArea}</td>
                  <td>{stepLabel(event.messageType)}</td>
                  <td>{event.fromBerth ?? ""}</td>
                  <td>{event.toBerth ?? ""}</td>
                  <td>{event.description ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {nextCursor && (
            <button
              type="button"
              className="btn"
              onClick={() => void handleLoadMore()}
              disabled={searching}
            >
              {searching ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </div>
  );
}
