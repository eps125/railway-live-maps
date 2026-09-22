import { useState } from "react";
import { readApiJson } from "../editor/apiJson.js";
import { navigate } from "../useRoute.js";

interface PairStep {
  eventAt: string;
  description: string | null;
}

interface PairStepsResponse {
  tdArea: string;
  fromBerth: string;
  toBerth: string;
  since: string;
  steps: PairStep[];
}

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
 */
export function BerthStepsPage(): JSX.Element {
  const [tdArea, setTdArea] = useState("");
  const [fromBerth, setFromBerth] = useState("");
  const [toBerth, setToBerth] = useState("");
  const [result, setResult] = useState<PairStepsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  async function search(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSearching(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        tdArea: tdArea.trim().toUpperCase(),
        fromBerth: fromBerth.trim().toUpperCase(),
        toBerth: toBerth.trim().toUpperCase(),
        limit: "50",
      });
      const response = await fetch(`/api/v1/admin/berths/steps?${params.toString()}`);
      if (!response.ok) {
        const body = await readApiJson<{ error?: { message?: string } }>(response);
        setResult(null);
        setError(body.error?.message ?? "Search failed.");
        return;
      }
      setResult(await readApiJson<PairStepsResponse>(response));
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
        The last 50 steps from one berth to another, newest first, within the last 90 days. Times
        are UK time.
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
            placeholder="e.g. 3881"
            required
          />
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
          No steps from {result.fromBerth} to {result.toBerth} in {result.tdArea} in the last 90
          days.
        </p>
      ) : null}

      {result && result.steps.length > 0 ? (
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
    </div>
  );
}
