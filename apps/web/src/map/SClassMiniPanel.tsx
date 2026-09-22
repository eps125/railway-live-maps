import { useEffect, useMemo, useRef, useState } from "react";
import type { CompiledMapBundle } from "@railway/map-schema";

/**
 * Milestone 65 (owner request 2026-09-22): an admin-only S-Class mini explorer over the map — the
 * bits of one TD area as they are now (live) or were at the playback clock, which changed in the
 * last few minutes, and which map elements each bit is bound to, highlighted on the map as a
 * visual reference. Diagnostics only: it reads `/api/v1/admin/s-class/areas/{area}/snapshot` and
 * never changes what the map shows.
 */

interface SnapshotChange {
  address: string;
  bit: number;
  previousValue: boolean;
  newValue: boolean;
  eventAt: string;
}

interface SnapshotDefinition {
  address: string;
  bit: number;
  kind: string;
  label: string | null;
  destination: string | null;
}

interface Snapshot {
  at: string;
  bytes: Array<{ address: string; value: number | null }>;
  changes: SnapshotChange[];
  truncated: boolean;
  overlayTruncated?: boolean;
  definitions: SnapshotDefinition[];
}

/** Live: once a second, so a bit change shows while the train that caused it is still moving. */
const LIVE_POLL_MS = 1000;
/** In playback the clock ticks constantly; ask at most this often, and never overlap requests. */
const PLAYBACK_MIN_INTERVAL_MS = 2000;
/** A bound element counts as "just changed" (and is highlighted, if chosen) for this long. */
const RECENT_HIGHLIGHT_MS = 10_000;
const WINDOWS = [
  { seconds: 30, label: "30 s" },
  { seconds: 120, label: "2 min" },
  { seconds: 600, label: "10 min" },
  { seconds: 1800, label: "30 min" },
];

/** Every TD area this map has S-Class bindings in (signals, crossings, inferred crossing inputs,
 * routes), falling back to its berth areas so a map with nothing bound yet can still be explored. */
export function sClassAreasForBundle(bundle: CompiledMapBundle): string[] {
  const areas = new Set<string>();
  const addKeys = (index: Record<string, unknown> | undefined): void => {
    for (const key of Object.keys(index ?? {})) {
      const area = key.split("|")[0];
      if (area) areas.add(area);
    }
  };
  addKeys(bundle.sBitBindingIndex);
  addKeys(bundle.barrierBindingIndex);
  addKeys(bundle.routeBindingIndex);
  for (const inputs of Object.values(bundle.inferredBarrierBindings ?? {})) {
    for (const input of inputs) areas.add(input.tdArea);
  }
  if (areas.size === 0) addKeys(bundle.berthBindingIndex);
  return [...areas].sort();
}

/** The map elements bound to one bit: signals, crossings (direct or through an inferred input)
 * and routes, from the published bundle's own indexes. */
export function elementsBoundToBit(
  bundle: CompiledMapBundle,
  tdArea: string,
  address: string,
  bit: number,
): string[] {
  const key = `${tdArea}|${address}|${bit}`;
  const ids = new Set<string>();
  for (const index of [
    bundle.sBitBindingIndex,
    bundle.barrierBindingIndex,
    bundle.routeBindingIndex,
  ]) {
    const id = index?.[key];
    if (id) ids.add(id);
  }
  for (const [crossingId, inputs] of Object.entries(bundle.inferredBarrierBindings ?? {})) {
    if (inputs.some((i) => i.tdArea === tdArea && i.address === address && i.bit === bit)) {
      ids.add(crossingId);
    }
  }
  return [...ids];
}

function londonTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Europe/London" });
}

export function SClassMiniPanel({
  bundle,
  atIso,
  onHighlight,
  onClose,
}: {
  bundle: CompiledMapBundle;
  /** The playback clock, or null for live. */
  atIso: string | null;
  onHighlight: (elementIds: string[]) => void;
  onClose: () => void;
}): JSX.Element {
  const areas = useMemo(() => sClassAreasForBundle(bundle), [bundle]);
  const [area, setArea] = useState<string>(areas[0] ?? "");
  const [windowSeconds, setWindowSeconds] = useState(120);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ address: string; bit: number } | null>(null);
  const [highlightRecent, setHighlightRecent] = useState(true);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const inFlight = useRef(false);
  const lastFetch = useRef(0);

  async function load(at: string | null): Promise<void> {
    if (!area || inFlight.current) return;
    inFlight.current = true;
    lastFetch.current = Date.now();
    try {
      const params = new URLSearchParams({ windowSeconds: String(windowSeconds) });
      if (at) params.set("at", at);
      const response = await fetch(
        `/api/v1/admin/s-class/areas/${encodeURIComponent(area)}/snapshot?${params.toString()}`,
      );
      if (!response.ok) throw new Error(`S-Class snapshot failed (${response.status})`);
      setSnapshot((await response.json()) as Snapshot);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "S-Class snapshot failed");
    } finally {
      inFlight.current = false;
    }
  }

  // A new area or window starts afresh, and must not wait out the playback throttle. Declared
  // before the fetching effects so it runs first when either changes.
  useEffect(() => {
    lastFetch.current = 0;
    setSelected(null);
    setSnapshot(null);
  }, [area, windowSeconds]);

  // Live: poll.
  useEffect(() => {
    if (atIso !== null) return;
    void load(null);
    const id = window.setInterval(() => void load(null), LIVE_POLL_MS);
    return () => window.clearInterval(id);
    // Keyed on live-vs-playback, not the clock itself: in playback the effect below follows it.
  }, [atIso === null, area, windowSeconds]);

  // Playback: follow the clock, at most every 2 s, always finishing on the latest position (a
  // throttled change is fetched when the interval is up, so pausing or jumping never leaves the
  // panel showing an earlier time).
  const latestAt = useRef(atIso);
  latestAt.current = atIso;
  useEffect(() => {
    if (atIso === null) return;
    const wait = PLAYBACK_MIN_INTERVAL_MS - (Date.now() - lastFetch.current);
    if (wait <= 0 && !inFlight.current) {
      void load(atIso);
      return;
    }
    const id = window.setTimeout(
      () => {
        if (latestAt.current !== null) void load(latestAt.current);
      },
      Math.max(wait, 250),
    );
    return () => window.clearTimeout(id);
  }, [atIso, area, windowSeconds]);

  const definitionFor = useMemo(() => {
    const map = new Map<string, SnapshotDefinition>();
    for (const d of snapshot?.definitions ?? []) map.set(`${d.address}:${d.bit}`, d);
    return map;
  }, [snapshot]);

  const atMs = snapshot ? Date.parse(snapshot.at) : 0;
  const lastChange = useMemo(() => {
    const map = new Map<string, SnapshotChange>();
    for (const c of snapshot?.changes ?? []) {
      const key = `${c.address}:${c.bit}`;
      if (!map.has(key)) map.set(key, c); // newest first
    }
    return map;
  }, [snapshot]);

  // What to highlight on the map: the selected bit's elements, plus (if chosen) the elements of
  // every bit that changed in the last 10 s of the displayed time.
  useEffect(() => {
    const ids = new Set<string>();
    if (selected) {
      for (const id of elementsBoundToBit(bundle, area, selected.address, selected.bit))
        ids.add(id);
    }
    if (highlightRecent && snapshot) {
      for (const c of snapshot.changes) {
        if (atMs - Date.parse(c.eventAt) > RECENT_HIGHLIGHT_MS) break;
        for (const id of elementsBoundToBit(bundle, area, c.address, c.bit)) ids.add(id);
      }
    }
    onHighlight([...ids]);
  }, [selected, highlightRecent, snapshot, area, atMs, bundle, onHighlight]);
  useEffect(() => () => onHighlight([]), [onHighlight]);

  const bytes = (snapshot?.bytes ?? []).filter(
    (b) =>
      !onlyChanged ||
      Array.from({ length: 8 }, (_, bit) => lastChange.has(`${b.address}:${bit}`)).some(Boolean),
  );
  const selectedDefinition = selected
    ? definitionFor.get(`${selected.address}:${selected.bit}`)
    : undefined;
  const selectedBound = selected
    ? elementsBoundToBit(bundle, area, selected.address, selected.bit)
    : [];

  return (
    <aside className="s-class-mini" aria-label="S-Class mini explorer">
      <header className="s-class-mini__header">
        <strong>S-Class</strong>
        <span className="s-class-mini__mode">
          {atIso === null ? "live" : `playback ${londonTime(atIso)}`}
        </span>
        <button type="button" className="btn" aria-label="Close S-Class panel" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="s-class-mini__controls">
        <label>
          Area{" "}
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            {areas.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label>
          Changes in last{" "}
          <select value={windowSeconds} onChange={(e) => setWindowSeconds(Number(e.target.value))}>
            {WINDOWS.map((w) => (
              <option key={w.seconds} value={w.seconds}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={onlyChanged}
            onChange={(e) => setOnlyChanged(e.target.checked)}
          />{" "}
          Only changed bytes
        </label>
        <label>
          <input
            type="checkbox"
            checked={highlightRecent}
            onChange={(e) => setHighlightRecent(e.target.checked)}
          />{" "}
          Highlight changes on map
        </label>
      </div>
      {error ? <p className="s-class-mini__error">{error}</p> : null}
      {snapshot?.overlayTruncated ? (
        <p className="s-class-mini__error">
          The recorder is catching up, so the newest changes may be missing for a moment.
        </p>
      ) : null}
      {areas.length === 0 ? <p className="field-hint">This map has no TD areas bound.</p> : null}

      <table className="s-class-mini__grid" aria-label={`${area} bits`}>
        <thead>
          <tr>
            <th>Byte</th>
            {Array.from({ length: 8 }, (_, bit) => (
              <th key={bit}>{bit}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {bytes.map((b) => (
            <tr key={b.address}>
              <th className="mono">{b.address}</th>
              {Array.from({ length: 8 }, (_, bit) => {
                const key = `${b.address}:${bit}`;
                const change = lastChange.get(key);
                const age = change ? atMs - Date.parse(change.eventAt) : null;
                const value = b.value === null ? null : ((b.value >> bit) & 1) === 1;
                const definition = definitionFor.get(key);
                const isSelected = selected?.address === b.address && selected.bit === bit;
                return (
                  <td key={bit}>
                    <button
                      type="button"
                      className={[
                        "s-class-mini__bit",
                        value ? "s-class-mini__bit--set" : "",
                        age !== null && age <= RECENT_HIGHLIGHT_MS
                          ? "s-class-mini__bit--just-changed"
                          : age !== null
                            ? "s-class-mini__bit--changed"
                            : "",
                        isSelected ? "s-class-mini__bit--selected" : "",
                      ].join(" ")}
                      title={`${key} = ${value === null ? "unknown" : value ? 1 : 0}${
                        definition?.label ? ` — ${definition.label}` : ""
                      }${change ? `, changed ${londonTime(change.eventAt)}` : ""}`}
                      onClick={() => setSelected(isSelected ? null : { address: b.address, bit })}
                    >
                      {value === null ? "?" : value ? 1 : 0}
                      {definition?.label ? (
                        <span className="s-class-mini__label">{definition.label}</span>
                      ) : null}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {selected ? (
        <p className="field-hint">
          <span className="mono">
            {area} {selected.address}:{selected.bit}
          </span>
          {selectedDefinition?.label
            ? ` — ${selectedDefinition.kind} ${selectedDefinition.label}`
            : ""}
          {selectedDefinition?.destination ? ` to ${selectedDefinition.destination}` : ""}.{" "}
          {selectedBound.length > 0
            ? `Bound on this map to ${selectedBound.join(", ")} (highlighted).`
            : "Not bound to anything on this map."}
        </p>
      ) : null}

      <h4 className="s-class-mini__heading">Changes{snapshot?.truncated ? " (newest 300)" : ""}</h4>
      <ol className="s-class-mini__changes">
        {(snapshot?.changes ?? []).map((c, index) => {
          const definition = definitionFor.get(`${c.address}:${c.bit}`);
          return (
            <li key={`${c.eventAt}-${c.address}-${c.bit}-${index}`}>
              <button
                type="button"
                className="btn--link"
                onClick={() => setSelected({ address: c.address, bit: c.bit })}
              >
                <span className="mono">{londonTime(c.eventAt)}</span>{" "}
                <span className="mono">
                  {c.address}:{c.bit}
                </span>{" "}
                {c.previousValue ? 1 : 0} → {c.newValue ? 1 : 0}
                {definition?.label ? ` ${definition.label}` : ""}
              </button>
            </li>
          );
        })}
        {snapshot && snapshot.changes.length === 0 ? (
          <li className="field-hint">No changes in this window.</li>
        ) : null}
      </ol>
    </aside>
  );
}
