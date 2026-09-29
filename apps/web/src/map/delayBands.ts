import { useEffect, useState } from "react";
import type { BerthDelay } from "@railway/protocol";
import type { BerthState } from "./types.js";

export type { BerthDelay };

/** Milestone 82: a berth's lateness band from its train's latest TRUST report (only berths at
 * least 15 minutes late are ever listed; everything else is drawn in the normal colour). */
export type DelayBand = BerthDelay["band"];

export interface MapDelaysResponse {
  mapSlug: string;
  mapVersion: number;
  asOf: string;
  mode: "live" | "historical";
  delays: BerthDelay[];
}

/**
 * Owner-specified bands (2026-09-29): 15-29 min yellow, 30-59 amber, 60+ red; anything else
 * keeps the normal occupied blue. Chosen so the dark headcode text (`#04101f`) is at least as
 * readable on each as on the existing blue (about 4.6:1): yellow ~12:1, amber ~7.7:1, red ~4.7:1.
 * Each stroke is a lighter tint of its fill, like the blue's.
 */
export const DELAY_BAND_COLORS: Record<DelayBand, { fill: string; stroke: string }> = {
  minor: { fill: "#e8c93a", stroke: "#f5de7a" },
  moderate: { fill: "#ec8a1c", stroke: "#f5ad5c" },
  severe: { fill: "#dc4a3d", stroke: "#ec7b70" },
};

export const DELAY_BAND_LABELS: Record<DelayBand, string> = {
  minor: "15–29 min late",
  moderate: "30–59 min late",
  severe: "60+ min late",
};

/**
 * Which drawn berth gets which band. A band is only re-stated when openrail-eps reports on the
 * train (owner, 2026-09-29: nothing is looked up per berth step), while the train keeps stepping
 * between reports, so:
 *
 *   - a berth still showing the description the band was given for keeps it;
 *   - a band whose berth no longer shows its description follows that description to the berth
 *     now showing it — but only when exactly one berth on the map shows it and exactly one band
 *     was given for it. This is a display carry-forward in the browser only (the train's next
 *     report re-states it where it really is); if a description is on more than one berth,
 *     nothing is carried and those berths stay in the normal colour, rather than guessing which
 *     train is which (CLAUDE.md rule 5).
 */
export function matchDelayBands(
  delays: ReadonlyArray<BerthDelay>,
  berths: Record<string, BerthState>,
): Record<string, DelayBand> {
  const result: Record<string, DelayBand> = {};
  if (delays.length === 0) return result;

  const berthsShowing = new Map<string, string[]>();
  for (const [elementId, state] of Object.entries(berths)) {
    if (!state.description) continue;
    const list = berthsShowing.get(state.description) ?? [];
    list.push(elementId);
    berthsShowing.set(state.description, list);
  }
  const bandsFor = new Map<string, BerthDelay[]>();
  for (const delay of delays) {
    const list = bandsFor.get(delay.description) ?? [];
    list.push(delay);
    bandsFor.set(delay.description, list);
  }

  for (const delay of delays) {
    if (berths[delay.elementId]?.description === delay.description) {
      result[delay.elementId] = delay.band;
      continue;
    }
    const showing = berthsShowing.get(delay.description) ?? [];
    const given = bandsFor.get(delay.description) ?? [];
    if (showing.length === 1 && given.length === 1) result[showing[0]!] = delay.band;
  }
  return result;
}

/**
 * Milestone 82: playback's delay bands for `slug` while `enabled`, asked once per minute of the
 * playback clock (the server answers per whole minute, from recorded band changes — never
 * recomputed from TRUST). The live map doesn't use this: its bands arrive on the WebSocket.
 * Failures are quiet: the map keeps its last answer until the next minute's.
 */
export function useDelayBands(slug: string, enabled: boolean, atIso: string): BerthDelay[] {
  const [delays, setDelays] = useState<BerthDelay[]>([]);
  const atMinute = Math.floor(Date.parse(atIso) / 60_000);

  useEffect(() => {
    if (!enabled) {
      setDelays([]);
      return;
    }
    let cancelled = false;
    const url = `/api/v1/maps/${slug}/delays?at=${new Date(atMinute * 60_000).toISOString()}`;
    async function load(): Promise<void> {
      try {
        const response = await fetch(url);
        if (!response.ok) return;
        const body = (await response.json()) as MapDelaysResponse;
        if (!cancelled) setDelays(body.delays);
      } catch {
        /* quiet: keep the last answer until the next one arrives */
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [slug, enabled, atMinute]);

  return delays;
}
