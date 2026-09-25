import { useState } from "react";
import { readApiJson } from "../editor/apiJson.js";
import { navigate } from "../useRoute.js";

interface Step {
  eventAt: string;
  description: string | null;
  messageType: string;
  fromBerth: string | null;
  toBerth: string | null;
}

interface StepsResponse {
  tdArea: string;
  fromBerth: string;
  /** Null for a single-berth search: every step into or out of `fromBerth`. */
  toBerth: string | null;
  days: number;
  since: string;
  steps: Step[];
}

/** The C-Class message types a berth search can return (CT heartbeats carry no berth). */
const STEP_TYPES: Record<string, string> = {
  CA: "Step",
  CB: "Cancel",
  CC: "Interpose",
};

/** Matches the API's own choices; longer is slower, so the default is a week. */
const LOOKBACKS = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

/** Europe/London, as every user-facing time in this app (CLAUDE.md rule 4). */
function londonDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Owner request 2026-09-22: "give a pair of berths and the tool gives me the date and time of the
 * last 50 steps between those berths" — newest first, with each train's description, from the
 * raw berth steps (`GET /api/v1/admin/berths/steps`). Useful for timing a bit against real train
 * movements, and for seeing how often a move actually happens.
 *
 * Owner request 2026-09-25: leave "To berth" empty to list every step at one berth instead —
 * into it or out of it, including cancels and interposes — with each row's from/to and type.
 */
export function BerthStepsPage(): JSX.Element {
  const [tdArea, setTdArea] = useState("");
  const [fromBerth, setFromBerth] = useState("");
  const [toBerth, setToBerth] = useState("");
  const [days, setDays] = useState(7);
  const [result, setResult] = useState<StepsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  async function search(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSearching(true);
    setError(null);
    try {
      const to = toBerth.trim().toUpperCase();
      const params = new URLSearchParams({
        tdArea: tdArea.trim().toUpperCase(),
        fromBerth: fromBerth.trim().toUpperCase(),
        ...(to ? { toBerth: to } : {}),
        limit: "50",
        days: String(days),
      });
      const response = await fetch(`/api/v1/admin/berths/steps?${params.toString()}`);
      if (!response.ok) {
        const body = await readApiJson<{ error?: { message?: string } }>(response);
        setResult(null);
        setError(body.error?.message ?? "Search failed.");
        return;
      }
      setResult(await readApiJson<StepsResponse>(response));
    } catch {
      setResult(null);
      setError("Search failed.");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="admin-users-page berth-query-page">
      <h2>Berth steps</h2>
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
        &gt; Berth steps
      </p>
      <p className="field-hint">
        The last 50 steps from one berth to another, newest first. Leave &ldquo;To berth&rdquo;
        empty to see every step at a single berth instead &mdash; into it or out of it, including
        cancels and interposes. Times are UK time. A longer period takes longer to search, and a
        berth or pair that is rarely used is the slowest case of all, because every step in the
        period has to be checked.
      </p>

      <form className="panel-card" onSubmit={(e) => void search(e)}>
        <label className="field">
          Train describer area
          <input
            type="text"
            value={tdArea}
            onChange={(e) => setTdArea(e.target.value)}
            placeholder="e.g. M9"
            required
          />
        </label>
        <label className="field">
          From berth
          <input
            type="text"
            value={fromBerth}
            onChange={(e) => setFromBerth(e.target.value)}
            placeholder="e.g. 3879"
            required
          />
        </label>
        <label className="field">
          To berth
          <input
            type="text"
            value={toBerth}
            onChange={(e) => setToBerth(e.target.value)}
            placeholder="optional, e.g. 3881"
          />
        </label>
        <label className="field">
          Look back
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {LOOKBACKS.map((l) => (
              <option key={l.days} value={l.days}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        {error ? (
          <p role="alert" className="login-form__error">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn btn--primary" disabled={searching}>
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      {result && result.steps.length === 0 ? (
        <p className="panel-card panel-card--empty">
          No steps{" "}
          {result.toBerth
            ? `from ${result.fromBerth} to ${result.toBerth}`
            : `at ${result.fromBerth}`}{" "}
          in {result.tdArea} in the last{" "}
          {LOOKBACKS.find((l) => l.days === result.days)?.label ?? `${result.days} days`}.
        </p>
      ) : null}

      {result && result.steps.length > 0 && result.toBerth !== null ? (
        <table className="users-table" aria-label={`${result.fromBerth} to ${result.toBerth}`}>
          <thead>
            <tr>
              <th>#</th>
              <th>Date and time (UK)</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {result.steps.map((step, index) => (
              <tr key={`${step.eventAt}-${index}`}>
                <td>{index + 1}</td>
                <td>{londonDateTime(step.eventAt)}</td>
                <td className="mono">{step.description ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {result && result.steps.length > 0 && result.toBerth === null ? (
        <table className="users-table" aria-label={`Steps at ${result.fromBerth}`}>
          <thead>
            <tr>
              <th>#</th>
              <th>Date and time (UK)</th>
              <th>Description</th>
              <th>From</th>
              <th>To</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {result.steps.map((step, index) => (
              <tr key={`${step.eventAt}-${index}`}>
                <td>{index + 1}</td>
                <td>{londonDateTime(step.eventAt)}</td>
                <td className="mono">{step.description ?? ""}</td>
                <td className="mono">{step.fromBerth ?? ""}</td>
                <td className="mono">{step.toBerth ?? ""}</td>
                <td>
                  {STEP_TYPES[step.messageType] ?? step.messageType}{" "}
                  <span className="mono">({step.messageType})</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
