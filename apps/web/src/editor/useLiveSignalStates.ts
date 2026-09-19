import { useEffect, useState } from "react";
import type { MapDocument } from "@railway/map-schema";

export type LiveSignalState = "blank" | "on" | "off";

const POLL_INTERVAL_MS = 3000;

/**
 * Milestone 36c (owner request): bound signals show their live state in the editor — in the
 * normal edit view as well as Test mode — so a wrong address/bit is obvious while authoring.
 *
 * Polls `GET /api/v1/editor/state/{slug}`, which computes live state for the saved draft's own
 * bindings with the same `computeLiveState` the public map uses (CLAUDE.md rule 13): a signal's
 * state is only ever its bound S-Class bit. Only polls while the draft has at least one `tdSBit`
 * binding; returns state for bound signals only (unbound ones keep their static `symbolStyle`).
 */
export function useLiveSignalStates(
  slug: string,
  doc: Pick<MapDocument, "bindings">,
): Record<string, LiveSignalState> {
  const boundIds = doc.bindings
    .filter((binding) => binding.type === "tdSBit")
    .map((binding) => binding.elementId)
    .sort()
    .join(",");
  const [states, setStates] = useState<Record<string, LiveSignalState>>({});

  useEffect(() => {
    if (boundIds === "") {
      setStates({});
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
        };
        const next: Record<string, LiveSignalState> = {};
        for (const [elementId, signal] of Object.entries(body.signals ?? {})) {
          if (bound.has(elementId)) next[elementId] = signal.state;
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
