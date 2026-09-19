import { useEffect, useState } from "react";
import {
  applyCA,
  applyCB,
  applyCC,
  joinCombinedBerthState,
  type OpenOccupancySnapshot,
} from "@railway/domain";
import type { TdBerthBinding, VirtualBerthBinding } from "@railway/map-schema";
import { useEditorState } from "./EditorState.js";

export type TestMode = "off" | "simulated" | "live" | "historical";

interface PreviewEntry {
  description: string | null;
}

export interface TestModePanelResult {
  mode: TestMode;
  setMode: (mode: TestMode) => void;
  previewState: Record<string, PreviewEntry> | undefined;
  panel: JSX.Element;
}

const LIVE_POLL_INTERVAL_MS = 3000;

/**
 * docs/MAP_EDITOR_SPEC.md §10 test mode: manually set/clear a berth description; simulate
 * CA/CB/CC; load current live state; load historical state at a selected time (deferred to
 * Milestone 10, per docs/IMPLEMENTATION_PLAN.md's own note — see the 501 handling below).
 * "The preview must use the same reducers/style semantics as the public application" — the
 * simulated mode below calls the exact same `applyCA`/`applyCB`/`applyCC` pure functions
 * `packages/domain` already built for the real nationwide TD projector (Milestone 4), just
 * against an in-memory, preview-only occupancy map instead of the database.
 */
export function useTestModePanel(slug: string): TestModePanelResult {
  const { document: doc } = useEditorState();
  const [mode, setMode] = useState<TestMode>("off");
  const [openByKey, setOpenByKey] = useState<Record<string, OpenOccupancySnapshot>>({});
  const [liveState, setLiveState] = useState<Record<string, PreviewEntry> | null>(null);
  const [historicalNotice, setHistoricalNotice] = useState<string | null>(null);
  const [simFromArea, setSimFromArea] = useState("");
  const [simFromBerth, setSimFromBerth] = useState("");
  const [simToArea, setSimToArea] = useState("");
  const [simToBerth, setSimToBerth] = useState("");
  const [simDescription, setSimDescription] = useState("");
  const [clearingKey, setClearingKey] = useState<string | null>(null);
  const [clearReason, setClearReason] = useState("");
  const [clearError, setClearError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const tdBerthBindings = doc.bindings.filter((b): b is TdBerthBinding => b.type === "tdBerth");
  // docs/adr/0012 gap closure (owner request, 2026-09-19): virtual (GPS-fed) berths get the same
  // "stuck occupied" manual-clear escape hatch as TD berths, in the same Test mode "live" list —
  // one binding, one STANOX, never combined (validate.ts blocks two virtual bindings sharing one).
  const virtualBerthBindings = doc.bindings.filter(
    (b): b is VirtualBerthBinding => b.type === "virtualBerth",
  );

  async function pollLiveState(): Promise<void> {
    try {
      const response = await fetch(`/api/v1/editor/state/${encodeURIComponent(slug)}`);
      if (!response.ok) return;
      const body = (await response.json()) as { berths: Record<string, PreviewEntry> };
      setLiveState(body.berths);
    } catch {
      // Best-effort preview — a transient failure just leaves the last-known state showing.
    }
  }

  useEffect(() => {
    if (mode !== "live") return;
    let cancelled = false;
    async function poll(): Promise<void> {
      if (!cancelled) await pollLiveState();
    }
    void poll();
    const interval = setInterval(() => void poll(), LIVE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [mode, slug]);

  /** Live-only override for a berth stuck showing a stale description (most likely after a feed
   * connection gap silently dropped its real step/clear event) — docs/API_CONTRACT.md §4's
   * `POST /api/v1/editor/berths/{tdArea}/{berth}/clear`. Requires a reason (recorded server-side
   * in `operator_berth_action` for audit) and re-polls immediately so the list reflects the
   * clear without waiting for the next tick. */
  async function submitClear(tdArea: string, berth: string): Promise<void> {
    if (!clearReason.trim()) {
      setClearError("A reason is required");
      return;
    }
    setClearing(true);
    setClearError(null);
    try {
      const response = await fetch(
        `/api/v1/editor/berths/${encodeURIComponent(tdArea)}/${encodeURIComponent(berth)}/clear`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: clearReason.trim() }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Failed to clear berth (${response.status})`);
      }
      setClearingKey(null);
      setClearReason("");
      await pollLiveState();
    } catch (error) {
      setClearError(error instanceof Error ? error.message : "Failed to clear berth");
    } finally {
      setClearing(false);
    }
  }

  /** Same live-only override as `submitClear`, for a virtual berth stuck showing occupied
   * (docs/adr/0012 gap closure) — `POST /api/v1/editor/virtual-berths/{stanox}/clear`. Uses its
   * own `stanoxes[0]` as the target: a virtual binding never combines, so there is exactly one. */
  async function submitVirtualClear(stanox: string): Promise<void> {
    if (!clearReason.trim()) {
      setClearError("A reason is required");
      return;
    }
    setClearing(true);
    setClearError(null);
    try {
      const response = await fetch(
        `/api/v1/editor/virtual-berths/${encodeURIComponent(stanox)}/clear`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: clearReason.trim() }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(
          body?.error?.message ?? `Failed to clear virtual berth (${response.status})`,
        );
      }
      setClearingKey(null);
      setClearReason("");
      await pollLiveState();
    } catch (error) {
      setClearError(error instanceof Error ? error.message : "Failed to clear virtual berth");
    } finally {
      setClearing(false);
    }
  }

  function simulate(kind: "CA" | "CB" | "CC"): void {
    const fromKey = simFromArea && simFromBerth ? `${simFromArea}|${simFromBerth}` : null;
    const toKey = simToArea && simToBerth ? `${simToArea}|${simToBerth}` : null;

    let effects;
    if (kind === "CA" && fromKey && toKey) {
      effects = applyCA({
        fromBerth: simFromBerth,
        toBerth: simToBerth,
        description: simDescription,
        fromOpen: openByKey[fromKey] ?? null,
        toOpen: openByKey[toKey] ?? null,
      }).effects;
    } else if (kind === "CB" && fromKey) {
      effects = applyCB({
        fromBerth: simFromBerth,
        description: simDescription,
        fromOpen: openByKey[fromKey] ?? null,
      }).effects;
    } else if (kind === "CC" && toKey) {
      effects = applyCC({
        toBerth: simToBerth,
        description: simDescription,
        toOpen: openByKey[toKey] ?? null,
      }).effects;
    } else {
      return;
    }

    setOpenByKey((prev) => {
      const next = { ...prev };
      for (const effect of effects) {
        if (effect.kind === "closeOccupancy") {
          const key = effect.berth === "from" ? fromKey : toKey;
          if (key) delete next[key];
        } else if (effect.kind === "openOccupancy" && toKey) {
          next[toKey] = {
            occupancyId: `sim-${Date.now()}`,
            description: effect.description,
            enteredAt: new Date().toISOString(),
          };
        }
        // recordAnomaly: preview-only, no anomaly log to write to.
      }
      return next;
    });
  }

  function keyToPreview(
    openByKeyMap: Record<string, OpenOccupancySnapshot>,
  ): Record<string, PreviewEntry> {
    // Grouped by elementId (not assigned 1:1 per binding) because a combined berth (owner
    // request 2026-09-17) has more than one binding sharing one elementId — assigning per
    // binding here previously let the last one processed silently clobber every earlier
    // member's simulated state for that element.
    const membersByElement = new Map<string, TdBerthBinding[]>();
    for (const binding of tdBerthBindings) {
      const list = membersByElement.get(binding.elementId) ?? [];
      list.push(binding);
      membersByElement.set(binding.elementId, list);
    }
    const result: Record<string, PreviewEntry> = {};
    for (const [elementId, members] of membersByElement) {
      const joined = joinCombinedBerthState(
        members.map((binding) => {
          const occupancy = openByKeyMap[`${binding.tdArea}|${binding.berth}`];
          return {
            tdArea: binding.tdArea,
            berth: binding.berth,
            order: binding.combinedOrder ?? 1,
            description: occupancy?.description ?? null,
            enteredAt: occupancy?.enteredAt ?? null,
          };
        }),
      );
      // Elements bound but not open show explicitly cleared, not "no overlay at all" — otherwise
      // a cleared berth would fall back to showing its static displayName, which isn't what a
      // "clear this berth" simulation should look like. `joinCombinedBerthState` already returns
      // `{ description: null, ... }` for an all-vacant group, so this falls out for free.
      result[elementId] = { description: joined.description };
    }
    return result;
  }

  const previewState: Record<string, PreviewEntry> | undefined =
    mode === "simulated"
      ? keyToPreview(openByKey)
      : mode === "live"
        ? (liveState ?? undefined)
        : undefined;

  const panel = (
    <section aria-label="Test mode" className="panel-card">
      <h3>Test mode</h3>
      <label className="field">
        Mode
        <select
          value={mode}
          onChange={(e) => {
            const next = e.target.value as TestMode;
            setMode(next);
            setHistoricalNotice(
              next === "historical"
                ? "Historical playback arrives in Milestone 10 — showing current live state instead."
                : null,
            );
          }}
        >
          <option value="off">Off (design view)</option>
          <option value="simulated">Simulated</option>
          <option value="live">Live</option>
          <option value="historical">Historical</option>
        </select>
      </label>

      {historicalNotice ? <p>{historicalNotice}</p> : null}

      {mode === "live" ? (
        <fieldset>
          <legend>Occupied berths</legend>
          {tdBerthBindings.length === 0 ? (
            <p>No TD berth bindings on this map.</p>
          ) : (
            <ul className="berth-clear-list">
              {tdBerthBindings.map((binding) => {
                const key = `${binding.tdArea}|${binding.berth}`;
                const entry = liveState?.[binding.elementId];
                if (!entry?.description) return null;
                const isClearing = clearingKey === key;
                return (
                  <li key={key}>
                    <span>
                      {binding.tdArea} {binding.berth}: <strong>{entry.description}</strong>
                    </span>
                    {isClearing ? (
                      <span className="btn-group">
                        <input
                          value={clearReason}
                          placeholder="Reason (required)"
                          onChange={(e) => setClearReason(e.target.value)}
                          disabled={clearing}
                        />
                        <button
                          type="button"
                          className="btn"
                          disabled={clearing}
                          onClick={() => void submitClear(binding.tdArea, binding.berth)}
                        >
                          Confirm clear
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={clearing}
                          onClick={() => {
                            setClearingKey(null);
                            setClearReason("");
                            setClearError(null);
                          }}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setClearingKey(key);
                          setClearReason("");
                          setClearError(null);
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {clearError ? (
            <p role="alert" className="app-error">
              {clearError}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {mode === "live" ? (
        <fieldset>
          <legend>Occupied virtual (GPS-fed) berths</legend>
          {virtualBerthBindings.length === 0 ? (
            <p>No virtual berth bindings on this map.</p>
          ) : (
            <ul className="berth-clear-list">
              {virtualBerthBindings.map((binding) => {
                const stanox = binding.stanoxes[0]!;
                const key = `virtual:${stanox}`;
                const entry = liveState?.[binding.elementId];
                if (!entry?.description) return null;
                const isClearing = clearingKey === key;
                return (
                  <li key={key}>
                    <span>
                      {stanox}: <strong>{entry.description}</strong>
                    </span>
                    {isClearing ? (
                      <span className="btn-group">
                        <input
                          value={clearReason}
                          placeholder="Reason (required)"
                          onChange={(e) => setClearReason(e.target.value)}
                          disabled={clearing}
                        />
                        <button
                          type="button"
                          className="btn"
                          disabled={clearing}
                          onClick={() => void submitVirtualClear(stanox)}
                        >
                          Confirm clear
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={clearing}
                          onClick={() => {
                            setClearingKey(null);
                            setClearReason("");
                            setClearError(null);
                          }}
                        >
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          setClearingKey(key);
                          setClearReason("");
                          setClearError(null);
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      ) : null}

      {mode === "simulated" ? (
        <fieldset>
          <legend>Simulate a berth step</legend>
          <label className="field">
            From area
            <input value={simFromArea} onChange={(e) => setSimFromArea(e.target.value)} />
          </label>
          <label className="field">
            From berth
            <input value={simFromBerth} onChange={(e) => setSimFromBerth(e.target.value)} />
          </label>
          <label className="field">
            To area
            <input value={simToArea} onChange={(e) => setSimToArea(e.target.value)} />
          </label>
          <label className="field">
            To berth
            <input value={simToBerth} onChange={(e) => setSimToBerth(e.target.value)} />
          </label>
          <label className="field">
            Description
            <input value={simDescription} onChange={(e) => setSimDescription(e.target.value)} />
          </label>
          <div className="btn-group">
            <button type="button" className="btn" onClick={() => simulate("CA")}>
              Simulate CA (step)
            </button>
            <button type="button" className="btn" onClick={() => simulate("CB")}>
              Simulate CB (cancel)
            </button>
            <button type="button" className="btn" onClick={() => simulate("CC")}>
              Simulate CC (interpose)
            </button>
          </div>
        </fieldset>
      ) : null}
    </section>
  );

  return { mode, setMode, previewState, panel };
}
