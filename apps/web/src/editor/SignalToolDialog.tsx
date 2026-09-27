import { useEffect, useMemo, useState } from "react";
import { useEditorDispatch, useEditorState } from "./EditorState.js";
import {
  DEFAULT_SIGNAL_TOOL_OPTIONS,
  planSignalTool,
  sClassLabelKey,
  summariseSignalTool,
  type SignalToolOptions,
  type SignalToolOutcome,
} from "./signalTool.js";

interface DefinitionRow {
  tdArea?: string;
  address: string;
  bit: number;
  label: string | null;
}

/** Every S-Class label for the TD areas this map's signals are bound to, keyed for lookup. */
function useSignalLabels(areas: readonly string[]): {
  labels: Map<string, string>;
  loading: boolean;
  error: string | null;
} {
  const [state, setState] = useState<{
    labels: Map<string, string>;
    loading: boolean;
    error: string | null;
  }>({ labels: new Map(), loading: areas.length > 0, error: null });
  const key = areas.join(",");

  useEffect(() => {
    let cancelled = false;
    if (areas.length === 0) {
      setState({ labels: new Map(), loading: false, error: null });
      return;
    }
    setState((prev) => ({ ...prev, loading: true, error: null }));
    Promise.all(
      areas.map(async (area) => {
        const response = await fetch(
          `/api/v1/editor/s-class/areas/${encodeURIComponent(area)}/definitions`,
        );
        if (!response.ok) throw new Error(`Could not load S-Class labels for ${area}`);
        const body = (await response.json()) as { definitions: DefinitionRow[] };
        return body.definitions.map((d) => ({ ...d, tdArea: area }));
      }),
    )
      .then((perArea) => {
        if (cancelled) return;
        const labels = new Map<string, string>();
        for (const d of perArea.flat()) {
          if (d.label) labels.set(sClassLabelKey(d.tdArea, d.address, d.bit), d.label);
        }
        setState({ labels, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          labels: new Map(),
          loading: false,
          error: error instanceof Error ? error.message : "Could not load S-Class labels",
        });
      });
    return () => {
      cancelled = true;
    };
    // `key` stands for `areas`' contents, so a new-but-equal array doesn't refetch.
  }, [key]);

  return state;
}

function outcomeText(outcome: SignalToolOutcome): string {
  switch (outcome.status) {
    case "change":
      return `${outcome.from} → ${outcome.to}`;
    case "unchanged":
      return "already set";
    case "skipped":
      return `skipped: ${outcome.reason}`;
    case "off":
      return "";
  }
}

/**
 * ADR 0017 §5: name and orient every signal on the map at once. Names come from the bound bit's
 * S-Class label (with an optional prefix replacing its leading letters); directions from the
 * owner's berth rule. Anything set by hand is left alone unless its overwrite box is ticked.
 * Previews first; applying is one undoable step.
 */
export function SignalToolDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { document: doc } = useEditorState();
  const dispatch = useEditorDispatch();
  const [options, setOptions] = useState<SignalToolOptions>(DEFAULT_SIGNAL_TOOL_OPTIONS);

  const areas = useMemo(
    () =>
      [
        ...new Set(
          doc.bindings.flatMap((b) => (b.type === "tdSBit" ? [b.tdArea.toUpperCase()] : [])),
        ),
      ].sort(),
    [doc.bindings],
  );
  const { labels, loading, error } = useSignalLabels(areas);

  const plan = useMemo(() => planSignalTool(doc, labels, options), [doc, labels, options]);
  const summary = summariseSignalTool(plan);
  const listed = plan.rows.filter(
    (row) =>
      row.name.status === "change" ||
      row.name.status === "skipped" ||
      row.direction.status === "change" ||
      row.direction.status === "skipped",
  );

  function set<K extends keyof SignalToolOptions>(key: K, value: SignalToolOptions[K]): void {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }

  function apply(): void {
    if (plan.patches.length === 0) return;
    dispatch({
      type: "dispatchCommand",
      command: { type: "patchElements", patches: plan.patches },
    });
    onClose();
  }

  return (
    <div className="signal-tool-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="signal-tool-title"
        className="panel-card signal-tool"
      >
        <h3 id="signal-tool-title">Name and orient signals</h3>
        <p className="field-hint">
          {summary.signals} signals on this map. Anything you set by hand is left alone unless you
          tick its overwrite box. Applying is one step you can undo.
        </p>

        <fieldset>
          <legend>Signal numbers</legend>
          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={options.setNames}
              onChange={(e) => set("setNames", e.target.checked)}
            />
            Number signals from their bit&apos;s S-Class label
          </label>
          <label className="field">
            Prefix (replaces the label&apos;s leading letters, e.g. S001 → CE001)
            <input
              type="text"
              value={options.prefix}
              placeholder="optional, e.g. CE"
              disabled={!options.setNames}
              onChange={(e) => set("prefix", e.target.value)}
            />
          </label>
          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={options.overwriteCustomNames}
              disabled={!options.setNames}
              onChange={(e) => set("overwriteCustomNames", e.target.checked)}
            />
            Overwrite numbers I set by hand
          </label>
        </fieldset>

        <fieldset>
          <legend>Direction and side</legend>
          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={options.setDirections}
              onChange={(e) => set("setDirections", e.target.checked)}
            />
            Right of a berth: above, → ; left of a berth: below, ←
          </label>
          <label className="field field--checkbox">
            <input
              type="checkbox"
              checked={options.overwriteCustomDirections}
              disabled={!options.setDirections}
              onChange={(e) => set("overwriteCustomDirections", e.target.checked)}
            />
            Overwrite directions I set by hand
          </label>
        </fieldset>

        {error ? (
          <p role="alert" className="login-form__error">
            {error}
          </p>
        ) : null}
        <p role="status" className="field-hint">
          {loading
            ? "Loading S-Class labels…"
            : `Numbers: ${summary.namesChanged} to change, ${summary.namesSkipped} skipped. Directions: ${summary.directionsChanged} to change, ${summary.directionsSkipped} skipped.`}
        </p>

        {listed.length > 0 ? (
          <div className="signal-tool__preview">
            <table className="users-table" aria-label="Signal tool preview">
              <thead>
                <tr>
                  <th>Signal</th>
                  <th>Number</th>
                  <th>Direction</th>
                </tr>
              </thead>
              <tbody>
                {listed.map((row) => (
                  <tr key={row.elementId}>
                    <td className="mono">{row.current ?? row.elementId}</td>
                    <td>{outcomeText(row.name)}</td>
                    <td>{outcomeText(row.direction)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div className="signal-tool__actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={loading || plan.patches.length === 0}
            onClick={apply}
          >
            Apply to {plan.patches.length} signals
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
