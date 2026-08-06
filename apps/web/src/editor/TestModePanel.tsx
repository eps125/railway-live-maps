import { useEffect, useState } from "react";
import { applyCA, applyCB, applyCC, type OpenOccupancySnapshot } from "@railway/domain";
import type { TdBerthBinding } from "@railway/map-schema";
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

  const tdBerthBindings = doc.bindings.filter((b): b is TdBerthBinding => b.type === "tdBerth");
  const bindingByKey = new Map(tdBerthBindings.map((b) => [`${b.tdArea}|${b.berth}`, b]));

  useEffect(() => {
    if (mode !== "live") return;
    let cancelled = false;
    async function poll(): Promise<void> {
      try {
        const response = await fetch(`/api/v1/editor/state/${encodeURIComponent(slug)}`);
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as { berths: Record<string, PreviewEntry> };
        if (!cancelled) setLiveState(body.berths);
      } catch {
        // Best-effort preview — a transient failure just leaves the last-known state showing.
      }
    }
    void poll();
    const interval = setInterval(() => void poll(), LIVE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [mode, slug]);

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
    const result: Record<string, PreviewEntry> = {};
    for (const [key, occupancy] of Object.entries(openByKeyMap)) {
      const binding = bindingByKey.get(key);
      if (binding) result[binding.elementId] = { description: occupancy.description };
    }
    // Elements bound but not open show explicitly cleared, not "no overlay at all" — otherwise
    // a cleared berth would fall back to showing its static displayName, which isn't what a
    // "clear this berth" simulation should look like.
    for (const binding of tdBerthBindings) {
      if (!(binding.elementId in result)) result[binding.elementId] = { description: null };
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
    <section aria-label="Test mode">
      <h3>Test mode</h3>
      <label>
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

      {mode === "simulated" ? (
        <fieldset>
          <legend>Simulate a berth step</legend>
          <label>
            From area
            <input value={simFromArea} onChange={(e) => setSimFromArea(e.target.value)} />
          </label>
          <label>
            From berth
            <input value={simFromBerth} onChange={(e) => setSimFromBerth(e.target.value)} />
          </label>
          <label>
            To area
            <input value={simToArea} onChange={(e) => setSimToArea(e.target.value)} />
          </label>
          <label>
            To berth
            <input value={simToBerth} onChange={(e) => setSimToBerth(e.target.value)} />
          </label>
          <label>
            Description
            <input value={simDescription} onChange={(e) => setSimDescription(e.target.value)} />
          </label>
          <button type="button" onClick={() => simulate("CA")}>
            Simulate CA (step)
          </button>
          <button type="button" onClick={() => simulate("CB")}>
            Simulate CB (cancel)
          </button>
          <button type="button" onClick={() => simulate("CC")}>
            Simulate CC (interpose)
          </button>
        </fieldset>
      ) : null}
    </section>
  );

  return { mode, setMode, previewState, panel };
}
