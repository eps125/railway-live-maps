import { useCallback, useEffect, useState } from "react";
import { readApiJson } from "../editor/apiJson.js";
import { navigate } from "../useRoute.js";

/**
 * Milestone 36c (docs/adr/0013): admin S-Class explorer, for any TD area with S-Class data —
 * lives under the admin "Berths" hub. Shows every byte's live bits, each bit's history, and
 * lets the owner record what a bit is (a definition). The two "suggest" tools rank bits against
 * berth-step timing as an *authoring aid only* — nothing is applied automatically, and a map
 * signal's displayed state is still only ever its explicitly bound bit (CLAUDE.md rule 10).
 */

interface AreaSummary {
  tdArea: string;
  bytes: number;
  lastEventAt: string;
  definitions: number;
}

interface Definition {
  tdArea: string;
  address: string;
  bit: number;
  kind: string;
  label: string | null;
  destination: string | null;
  source: string;
  notes: string | null;
  updatedBy: string;
  updatedAt: string;
}

interface BitCell {
  bit: number;
  value: boolean;
  lastChangedAt: string | null;
  changes24h: number;
  definition: Definition | null;
}

interface ByteRow {
  address: string;
  value: number;
  confirmedAt: string;
  sourceKind: string | null;
  lastRefreshAt: string | null;
  bits: BitCell[];
}

interface Transition {
  eventAt: string;
  previousValue: boolean | null;
  newValue: boolean;
  sourceKind: string;
}

interface CorrelatedStep {
  direction: "set" | "cleared";
  fromBerth: string | null;
  toBerth: string | null;
  hits: number;
  ofTransitions: number;
  medianOffsetSeconds: number;
}

interface CorrelatedBit {
  address: string;
  bit: number;
  direction: "set" | "cleared";
  hits: number;
  ofSteps: number;
  medianOffsetSeconds: number;
  definition: Definition | null;
}

interface ImportRow {
  line: number;
  address: string;
  bit: number;
  kind: string;
  label: string;
  destination: string | null;
  status: "new" | "unchanged" | "conflict";
  existing: Definition | null;
}

interface ImportIssue {
  line: number;
  code: string;
  message: string;
}

interface ImportReport {
  rows: ImportRow[];
  counts: {
    new: number;
    unchanged: number;
    conflict: number;
    skippedUnidentified: number;
    ignoredLines: number;
  };
  errors: ImportIssue[];
  warnings: ImportIssue[];
  committed: boolean;
  applied?: number;
}

const KINDS = ["signal", "route", "points", "track", "trts", "level_crossing", "unknown"];
const SOURCES = ["observed", "wiki", "sop", "ecs", "other"];
const REFRESH_MS = 5000;

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = await readApiJson<{ error?: { message?: string } }>(response);
  return body.error?.message ?? fallback;
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "not in 24 h";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function londonTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London" });
}

export function SClassExplorerPage(): JSX.Element {
  const [areas, setAreas] = useState<AreaSummary[]>([]);
  const [area, setArea] = useState("");
  const [bytes, setBytes] = useState<ByteRow[] | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [onlyActive, setOnlyActive] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<{ address: string; bit: number } | null>(null);

  useEffect(() => {
    fetch("/api/v1/admin/s-class/areas")
      .then(async (response) => {
        if (!response.ok) throw new Error(await errorMessage(response, "Could not load areas"));
        return readApiJson<{ areas: AreaSummary[] }>(response);
      })
      .then((body) => setAreas(body.areas))
      .catch((error: unknown) =>
        setGridError(error instanceof Error ? error.message : "Could not load areas"),
      );
  }, []);

  const loadGrid = useCallback(async (): Promise<void> => {
    if (!area) return;
    try {
      const response = await fetch(`/api/v1/admin/s-class/areas/${area}/bits`);
      if (!response.ok) throw new Error(await errorMessage(response, "Could not load bits"));
      const body = await readApiJson<{ bytes: ByteRow[] }>(response);
      setBytes(body.bytes);
      setNow(Date.now());
      setGridError(null);
    } catch (error) {
      setGridError(error instanceof Error ? error.message : "Could not load bits");
    }
  }, [area]);

  useEffect(() => {
    setBytes(null);
    setSelected(null);
    void loadGrid();
  }, [loadGrid]);

  useEffect(() => {
    if (!area || !autoRefresh) return;
    const interval = setInterval(() => void loadGrid(), REFRESH_MS);
    return () => clearInterval(interval);
  }, [area, autoRefresh, loadGrid]);

  const selectedCell =
    selected && bytes
      ? bytes.find((b) => b.address === selected.address)?.bits[selected.bit]
      : undefined;
  const visibleBytes = (bytes ?? []).filter(
    (row) => !onlyActive || row.bits.some((b) => b.changes24h > 0),
  );

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
      <h2>S-Class explorer</h2>
      <p className="field-hint">
        Live S-Class bits for any train describer area. Bit 0 is the least significant bit. Record
        what a bit is below; the suggestion tools rank bits against berth-step timing to help
        identify them — they never bind anything on a map.
      </p>

      <div className="panel-card s-class-toolbar">
        <label className="field">
          TD area
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">— choose —</option>
            {areas.map((a) => (
              <option key={a.tdArea} value={a.tdArea}>
                {a.tdArea} — {a.bytes} bytes, {a.definitions} defined
              </option>
            ))}
          </select>
        </label>
        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Refresh every 5 s
        </label>
        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={onlyActive}
            onChange={(e) => setOnlyActive(e.target.checked)}
          />
          Only bytes with changes in 24 h
        </label>
      </div>

      {gridError ? (
        <p role="alert" className="login-form__error">
          {gridError}
        </p>
      ) : null}

      {area && bytes ? (
        <div className="s-class-layout">
          <table className="users-table s-class-grid" aria-label={`${area} S-Class bits`}>
            <thead>
              <tr>
                <th>Addr</th>
                <th>Hex</th>
                {Array.from({ length: 8 }, (_, bit) => (
                  <th key={bit}>{bit}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleBytes.map((row) => (
                <tr key={row.address}>
                  <td className="mono">{row.address}</td>
                  <td className="mono" title={`Confirmed ${londonTime(row.confirmedAt)}`}>
                    {row.value.toString(16).toUpperCase().padStart(2, "0")}
                  </td>
                  {row.bits.map((cell) => {
                    const recent =
                      cell.lastChangedAt !== null && now - Date.parse(cell.lastChangedAt) < 30_000;
                    const isSelected =
                      selected?.address === row.address && selected.bit === cell.bit;
                    return (
                      <td key={cell.bit}>
                        <button
                          type="button"
                          className={[
                            "s-class-bit",
                            cell.value ? "s-class-bit--set" : "",
                            recent ? "s-class-bit--recent" : "",
                            isSelected ? "s-class-bit--selected" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          title={`${row.address}:${cell.bit} = ${cell.value ? 1 : 0} · changed ${ago(cell.lastChangedAt, now)} · ${cell.changes24h} changes/24 h${cell.definition?.label ? ` · ${cell.definition.label}` : ""}`}
                          onClick={() => setSelected({ address: row.address, bit: cell.bit })}
                        >
                          <span className="s-class-bit__value">{cell.value ? 1 : 0}</span>
                          <span className="s-class-bit__label">
                            {cell.definition?.label ?? (cell.changes24h > 0 ? "·" : "")}
                          </span>
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          <div className="s-class-side">
            {selected && selectedCell ? (
              <BitPanel
                key={`${area}:${selected.address}:${selected.bit}`}
                tdArea={area}
                address={selected.address}
                bit={selected.bit}
                cell={selectedCell}
                onSaved={() => void loadGrid()}
              />
            ) : (
              <p className="panel-card panel-card--empty">Select a bit to see its history.</p>
            )}
            <StepSuggestPanel
              tdArea={area}
              onPick={(address, bit) => setSelected({ address, bit })}
            />
            <ImportPanel tdArea={area} onImported={() => void loadGrid()} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BitPanel({
  tdArea,
  address,
  bit,
  cell,
  onSaved,
}: {
  tdArea: string;
  address: string;
  bit: number;
  cell: BitCell;
  onSaved: () => void;
}): JSX.Element {
  const def = cell.definition;
  const [kind, setKind] = useState(def?.kind ?? "signal");
  const [label, setLabel] = useState(def?.label ?? "");
  const [destination, setDestination] = useState(def?.destination ?? "");
  const [source, setSource] = useState(def?.source ?? "observed");
  const [notes, setNotes] = useState(def?.notes ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<Transition[] | null>(null);
  const [steps, setSteps] = useState<{
    transitions: { set: number; cleared: number };
    steps: CorrelatedStep[];
  } | null>(null);
  const [loadingSteps, setLoadingSteps] = useState(false);
  const base = `/api/v1/admin/s-class/areas/${tdArea}`;

  useEffect(() => {
    fetch(`${base}/bits/${address}/${bit}/history?limit=30`)
      .then((response) => readApiJson<{ transitions: Transition[] }>(response))
      .then((body) => setHistory(body.transitions ?? []))
      .catch(() => setHistory([]));
  }, [base, address, bit]);

  async function save(): Promise<void> {
    const response = await fetch(`${base}/definitions/${address}/${bit}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, label, destination, source, notes }),
    });
    setMessage(response.ok ? "Saved." : await errorMessage(response, "Save failed"));
    if (response.ok) onSaved();
  }

  async function remove(): Promise<void> {
    const response = await fetch(`${base}/definitions/${address}/${bit}`, { method: "DELETE" });
    setMessage(response.ok ? "Definition removed." : await errorMessage(response, "Delete failed"));
    if (response.ok) onSaved();
  }

  async function suggest(): Promise<void> {
    setLoadingSteps(true);
    try {
      const response = await fetch(`${base}/bits/${address}/${bit}/correlated-steps`);
      if (!response.ok) throw new Error(await errorMessage(response, "Suggestion failed"));
      setSteps(await readApiJson(response));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Suggestion failed");
    } finally {
      setLoadingSteps(false);
    }
  }

  return (
    <section className="panel-card" aria-label={`Bit ${address}:${bit}`}>
      <h3>
        {tdArea} {address}:{bit} — currently {cell.value ? 1 : 0}
      </h3>
      <p className="field-hint">
        {cell.changes24h} changes in the last 24 h
        {cell.lastChangedAt ? `, last at ${londonTime(cell.lastChangedAt)}` : ""}.
      </p>

      <fieldset>
        <legend>Definition</legend>
        <label className="field">
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Label (e.g. S3003, R1007)
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="field">
          Destination (routes)
          <input value={destination} onChange={(e) => setDestination(e.target.value)} />
        </label>
        <label className="field">
          Source
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <button type="button" className="btn btn--primary" onClick={() => void save()}>
          Save definition
        </button>{" "}
        {def ? (
          <button type="button" className="btn" onClick={() => void remove()}>
            Remove
          </button>
        ) : null}
        {def ? (
          <p className="field-hint">
            Last changed by {def.updatedBy}, {londonTime(def.updatedAt)} ({def.source}).
          </p>
        ) : null}
        {message ? <p className="field-hint">{message}</p> : null}
      </fieldset>

      <h4>Suggest berth steps (authoring aid)</h4>
      <button type="button" className="btn" disabled={loadingSteps} onClick={() => void suggest()}>
        {loadingSteps ? "Working…" : "Find berth steps near this bit's changes (24 h)"}
      </button>
      {steps ? (
        steps.steps.length === 0 ? (
          <p className="field-hint">No CA berth steps within ±10 s of this bit's changes.</p>
        ) : (
          <table className="users-table">
            <thead>
              <tr>
                <th>Bit went</th>
                <th>Step</th>
                <th>Matched</th>
                <th>Median offset</th>
              </tr>
            </thead>
            <tbody>
              {steps.steps.map((s, i) => (
                <tr key={i}>
                  <td>{s.direction === "set" ? "0 → 1" : "1 → 0"}</td>
                  <td className="mono">
                    {s.fromBerth} → {s.toBerth}
                  </td>
                  <td>
                    {s.hits}/{s.ofTransitions}
                  </td>
                  <td>{s.medianOffsetSeconds.toFixed(1)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}

      <h4>Recent changes</h4>
      {history === null ? (
        <p className="field-hint">Loading…</p>
      ) : history.length === 0 ? (
        <p className="field-hint">No recorded changes.</p>
      ) : (
        <table className="users-table">
          <thead>
            <tr>
              <th>Time (London)</th>
              <th>Change</th>
              <th>From</th>
            </tr>
          </thead>
          <tbody>
            {history.map((t, i) => (
              <tr key={i}>
                <td>{londonTime(t.eventAt)}</td>
                <td>
                  {t.previousValue === null ? "first seen" : t.previousValue ? "1" : "0"} →{" "}
                  {t.newValue ? "1" : "0"}
                </td>
                <td>{t.sourceKind === "refresh" ? "refresh (missed update)" : "update"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function StepSuggestPanel({
  tdArea,
  onPick,
}: {
  tdArea: string;
  onPick: (address: string, bit: number) => void;
}): JSX.Element {
  const [fromBerth, setFromBerth] = useState("");
  const [toBerth, setToBerth] = useState("");
  const [result, setResult] = useState<{ steps: number; bits: CorrelatedBit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function search(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ fromBerth, toBerth });
      const response = await fetch(
        `/api/v1/admin/s-class/areas/${tdArea}/correlated-bits?${params.toString()}`,
      );
      if (!response.ok) throw new Error(await errorMessage(response, "Search failed"));
      setResult(await readApiJson(response));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="panel-card" onSubmit={(e) => void search(e)}>
      <h3>Which bit is the signal between two berths?</h3>
      <p className="field-hint">
        Ranks bits that change within ±10 s of trains stepping between these berths over the last 24
        h — a signal usually returns to red (its bit changes) as a train steps past it. A suggestion
        to check against the diagram, not a binding.
      </p>
      <label className="field">
        From berth
        <input value={fromBerth} onChange={(e) => setFromBerth(e.target.value.toUpperCase())} />
      </label>
      <label className="field">
        To berth
        <input value={toBerth} onChange={(e) => setToBerth(e.target.value.toUpperCase())} />
      </label>
      <button
        type="submit"
        className="btn btn--primary"
        disabled={loading || !fromBerth || !toBerth}
      >
        {loading ? "Working…" : "Suggest bits"}
      </button>
      {error ? (
        <p role="alert" className="login-form__error">
          {error}
        </p>
      ) : null}
      {result ? (
        result.steps === 0 ? (
          <p className="field-hint">
            No {fromBerth} → {toBerth} steps in the last 24 h.
          </p>
        ) : (
          <table className="users-table">
            <thead>
              <tr>
                <th>Bit</th>
                <th>Went</th>
                <th>Matched</th>
                <th>Median</th>
                <th>Defined as</th>
              </tr>
            </thead>
            <tbody>
              {result.bits.map((b) => (
                <tr key={`${b.address}:${b.bit}:${b.direction}`}>
                  <td>
                    <button type="button" className="btn" onClick={() => onPick(b.address, b.bit)}>
                      {b.address}:{b.bit}
                    </button>
                  </td>
                  <td>{b.direction === "set" ? "0 → 1" : "1 → 0"}</td>
                  <td>
                    {b.hits}/{b.ofSteps}
                  </td>
                  <td>{b.medianOffsetSeconds.toFixed(1)} s</td>
                  <td>{b.definition?.label ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : null}
    </form>
  );
}

function ImportPanel({
  tdArea,
  onImported,
}: {
  tdArea: string;
  onImported: () => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const [radix, setRadix] = useState<"" | "hex" | "decimal">("");
  const [source, setSource] = useState("wiki");
  const [overwrite, setOverwrite] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(dryRun: boolean): Promise<void> {
    setError(null);
    const response = await fetch(`/api/v1/admin/s-class/areas/${tdArea}/definitions/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, radix, source, dryRun, overwriteConflicts: overwrite }),
    });
    if (!response.ok) {
      setError(await errorMessage(response, "Import failed"));
      return;
    }
    const body = await readApiJson<ImportReport>(response);
    setReport(body);
    if (body.committed) onImported();
  }

  return (
    <details className="panel-card">
      <summary>Import a published definition table</summary>
      <p className="field-hint">
        Paste a table (e.g. from the Open Rail Data wiki). Byte numbering differs between tables —
        some use hex addresses (<span className="mono">0A:3</span>), others decimal byte numbers (
        <span className="mono">10 3</span>) — so choose which this one uses; it is never guessed.
      </p>
      <label className="field">
        Table
        <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <fieldset>
        <legend>Byte numbering</legend>
        <label className="field field--checkbox">
          <input
            type="radio"
            name="radix"
            checked={radix === "hex"}
            onChange={() => setRadix("hex")}
          />
          Hex (e.g. 03:0, 1A:3)
        </label>
        <label className="field field--checkbox">
          <input
            type="radio"
            name="radix"
            checked={radix === "decimal"}
            onChange={() => setRadix("decimal")}
          />
          Decimal (e.g. 25 1)
        </label>
      </fieldset>
      <label className="field">
        Source
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn"
        disabled={!text.trim() || !radix}
        onClick={() => void send(true)}
      >
        Preview
      </button>
      {error ? (
        <p role="alert" className="login-form__error">
          {error}
        </p>
      ) : null}
      {report ? (
        <div>
          <p className="field-hint">
            {report.committed
              ? `Imported: ${report.applied ?? 0} definitions written.`
              : `Preview: ${report.counts.new} new, ${report.counts.unchanged} unchanged, ${report.counts.conflict} conflicting, ${report.counts.skippedUnidentified} unidentified rows skipped.`}
          </p>
          {report.errors.map((issue) => (
            <p key={`e${issue.line}${issue.code}`} className="login-form__error">
              Line {issue.line}: {issue.message}
            </p>
          ))}
          {report.warnings.map((issue) => (
            <p key={`w${issue.line}${issue.code}`} className="field-hint">
              ⚠ Line {issue.line}: {issue.message}
            </p>
          ))}
          {report.rows.some((r) => r.status === "conflict") ? (
            <table className="users-table">
              <thead>
                <tr>
                  <th>Bit</th>
                  <th>Table says</th>
                  <th>Currently</th>
                </tr>
              </thead>
              <tbody>
                {report.rows
                  .filter((r) => r.status === "conflict")
                  .map((r) => (
                    <tr key={`${r.address}:${r.bit}`}>
                      <td className="mono">
                        {r.address}:{r.bit}
                      </td>
                      <td>{r.label}</td>
                      <td>{r.existing?.label ?? "—"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : null}
          {!report.committed && report.errors.length === 0 ? (
            <>
              {report.counts.conflict > 0 ? (
                <label className="field field--checkbox">
                  <input
                    type="checkbox"
                    checked={overwrite}
                    onChange={(e) => setOverwrite(e.target.checked)}
                  />
                  Overwrite the {report.counts.conflict} conflicting definitions
                </label>
              ) : null}
              <button type="button" className="btn btn--primary" onClick={() => void send(false)}>
                Import
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
