import { useEffect, useState } from "react";
import type { MapDocument } from "@railway/map-schema";

export type LiveSignalState = "blank" | "on" | "off";
export type LiveRouteState = "blank" | "set" | "unset";

export interface LiveSClassStates {
  signals: Record<string, LiveSignalState>;
  /** Milestone 64: each bound route's live state, so a wrong route bit is obvious while
   * authoring, as a wrong signal bit already is. */
  routes: Record<string, LiveRouteState>;
}

const POLL_INTERVAL_MS = 3000;
const EMPTY: LiveSClassStates = { signals: {}, routes: {} };

/**
 * Milestone 36c (owner request): bound signals — and since Milestone 64 bound routes — show their
 * live state in the editor, in the normal edit view as well as Test mode.
 *
 * Polls `GET /api/v1/editor/state/{slug}`, which computes live state for the saved draft's own
 * bindings with the same `computeLiveState` the public map uses (CLAUDE.md rule 13): a signal's or
 * route's state is only ever its bound S-Class bit. Polls only while the draft has at least one
 * signal or route binding, and returns state for bound elements only.
 */
export function useLiveSClassStates(
  slug: string,
  doc: Pick<MapDocument, "bindings">,
): LiveSClassStates {
  const boundIds = doc.bindings
    .filter((binding) => binding.type === "tdSBit" || binding.type === "tdSBitRoute")
    .map((binding) => binding.elementId)
    .sort()
    .join(",");
  const [states, setStates] = useState<LiveSClassStates>(EMPTY);

  useEffect(() => {
    if (boundIds === "") {
      setStates(EMPTY);
      return;
    }
    const bound = new Set(boundIds.split(","));
    let cancelled = false;
    async function poll(): Promise<void> {
      try {
        const response = await fetch(`/api/v1/editor/state/${encodeURIComponent(slug)}`);
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as {
          signals?: Record<string, { state: LiveSignalState }>;
          routes?: Record<string, { state: LiveRouteState }>;
        };
        const next: LiveSClassStates = { signals: {}, routes: {} };
        for (const [elementId, signal] of Object.entries(body.signals ?? {})) {
          if (bound.has(elementId)) next.signals[elementId] = signal.state;
        }
        for (const [elementId, route] of Object.entries(body.routes ?? {})) {
          if (bound.has(elementId)) next.routes[elementId] = route.state;
        }
        if (!cancelled) setStates(next);
      } catch {
        // Best-effort preview — a transient failure keeps the last-known state showing.
      }
    }
    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [slug, boundIds]);

  return states;
}

/** The signal half of `useLiveSClassStates`. */
export function useLiveSignalStates(
  slug: string,
  doc: Pick<MapDocument, "bindings">,
): Record<string, LiveSignalState> {
  return useLiveSClassStates(slug, doc).signals;
}
