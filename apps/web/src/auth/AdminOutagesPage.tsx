import { useCallback, useEffect, useState } from "react";
import { readApiJson } from "../editor/apiJson.js";
import { formatLondon } from "./accessCodeFormat.js";
import { OUTAGES_SEEN_EVENT } from "./useOutageSummary.js";

type Recoverability = "recoverable" | "unrecoverable" | "unknown";

export interface OutageView {
  id: string;
  feed: string;
  tdArea: string | null;
  start: string;
  end: string | null;
  durationSeconds: number | null;
  reason: string;
  recoverability: Recoverability;
  note: string | null;
  recordedAt: string;
}

interface LiveTd {
  lastFrameAt: string | null;
  silentForSeconds: number | null;
  ongoing: boolean;
}

interface OutagesResponse {
  days: number;
  outages: OutageView[];
  liveTd: LiveTd;
  seenThroughGapId: string | null;
}

const PERIODS = [7, 30, 90, 365];

const REASON_LABEL: Record<string, string> = {
  td_receive_silence: "No TD messages received",
};

const RECOVERABILITY_LABEL: Record<Recoverability, string> = {
  recoverable: "Recovered — arrived late",
  unrecoverable: "Lost — never sent",
  unknown: "Not yet known",
};

/** "12 min 20 s", "1 h 05 min", "48 s". Exported for tests. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "ongoing";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** The newest gap id in a list (ids are bigints as strings). Exported for tests. */
export function newestGapId(outages: readonly OutageView[]): string | null {
  let newest: bigint | null = null;
  for (const outage of outages) {
    const id = BigInt(outage.id);
    if (newest === null || id > newest) newest = id;
  }
  return newest === null ? null : newest.toString();
}

/**
 * 2026-10-30 (owner request): admin "Data outages" — every recorded feed gap (`feed_gap`): when,
 * how long, and whether the missing data arrived late or was never sent; and whether TD is
 * silent right now, which no recorded gap shows until the silence ends. Opening the page marks
 * the outages it shows as seen, which clears the pill on the Admin link.
 */
export function AdminOutagesPage(): JSX.Element {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<OutagesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What had been seen before this visit, so this visit's new outages stay marked "New". */
  const [seenBefore, setSeenBefore] = useState<string | null>(null);

  const load = useCallback(async (period: number): Promise<void> => {
    try {
      const response = await fetch(`/api/v1/admin/outages?days=${period}`);
      if (!response.ok) {
        setError(`Failed to load outages (${response.status})`);
        return;
      }
      const body = await readApiJson<OutagesResponse>(response);
      setData(body);
      setSeenBefore((current) => current ?? body.seenThroughGapId);
      setError(null);
      const newest = newestGapId(body.outages);
      if (
        newest !== null &&
        body.seenThroughGapId !== null &&
        BigInt(newest) > BigInt(body.seenThroughGapId)
      ) {
        const seen = await fetch("/api/v1/admin/outages/seen", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ throughGapId: newest }),
        });
        if (seen.ok) window.dispatchEvent(new Event(OUTAGES_SEEN_EVENT));
      }
    } catch {
      setError("Failed to load outages.");
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const live = data?.liveTd;
  return (
    <div className="admin-users-page admin-outages">
      <h2>Data outages</h2>
      <p className="admin-outages__intro">
        Times the train describer feed stopped for longer than five minutes. Outages are recorded
        when the feed resumes; one happening now shows above the list.
      </p>
      {error && (
        <p role="alert" className="app-error">
          {error}
        </p>
      )}
      {live && (
        <p
          className={`admin-outages__live${live.ongoing ? " admin-outages__live--down" : ""}`}
          role="status"
        >
          {live.ongoing
            ? live.lastFrameAt
              ? `TD outage now: nothing received for ${formatDuration(live.silentForSeconds)} (last message ${formatLondon(live.lastFrameAt)}).`
              : "TD outage now: nothing has ever been received."
            : `TD is receiving normally (last message ${formatLondon(live.lastFrameAt)}).`}
        </p>
      )}
      <label className="admin-outages__period">
        Show the last{" "}
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {PERIODS.map((period) => (
            <option key={period} value={period}>
              {period} days
            </option>
          ))}
        </select>
      </label>
      {data && data.outages.length === 0 && (
        <p>No outages recorded in the last {data.days} days.</p>
      )}
      {data && data.outages.length > 0 && (
        <div className="admin-outages__table-wrap">
          <table className="users-table admin-outages__table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Ended</th>
                <th>Length</th>
                <th>Feed</th>
                <th>What happened</th>
                <th>Data</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {data.outages.map((outage) => {
                const isNew = seenBefore !== null && BigInt(outage.id) > BigInt(seenBefore);
                return (
                  <tr key={outage.id} className={isNew ? "admin-outages__row--new" : undefined}>
                    <td>
                      {formatLondon(outage.start)}
                      {isNew && <span className="admin-outages__new">New</span>}
                    </td>
                    <td>{outage.end ? formatLondon(outage.end) : "—"}</td>
                    <td>{formatDuration(outage.durationSeconds)}</td>
                    <td>
                      {outage.feed}
                      {outage.tdArea ? ` ${outage.tdArea}` : " (all areas)"}
                    </td>
                    <td>{REASON_LABEL[outage.reason] ?? outage.reason}</td>
                    <td
                      className={`admin-outages__data admin-outages__data--${outage.recoverability}`}
                    >
                      {RECOVERABILITY_LABEL[outage.recoverability]}
                    </td>
                    <td>{outage.note ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
