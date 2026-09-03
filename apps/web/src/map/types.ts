import type { CompiledMapBundle } from "@railway/map-schema";

// `RunSummary` and run-following were removed with the berth-run resolver (ADR 0002, 2026-09-01);
// run<->schedule correlation is deferred to a later phase.

export interface BerthState {
  description: string | null;
  enteredAt: string | null;
}

export interface SignalState {
  state: "blank" | "on" | "off";
}

export interface MapStateResponse {
  mapSlug: string;
  mapVersion: number;
  asOf: string;
  sourceSequence: number;
  mode: "live" | "historical" | string;
  quality: { status: "ok" | "stale" | "unknown"; gaps: string[] };
  berths: Record<string, BerthState>;
  signals: Record<string, SignalState>;
}

/** One compact playback event from `GET /api/v1/maps/{slug}/events` — the same wire shape as a
 * live WS `berth.updated` / `berth.cleared` delta, so `applyPlaybackDelta` handles both. */
export type PlaybackDelta =
  | {
      type: "berth.updated";
      sequence: number;
      eventAt: string;
      elementId: string;
      tdArea: string;
      berth: string;
      description: string;
      enteredAt: string;
    }
  | {
      type: "berth.cleared";
      sequence: number;
      eventAt: string;
      elementId: string;
      tdArea: string;
      berth: string;
    };

export interface MapEventsResponse {
  mapSlug: string;
  mapVersion: number;
  events: PlaybackDelta[];
  nextCursor: string | null;
}

export interface MapDefinitionResponse {
  mapSlug: string;
  mapVersion: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  definition: CompiledMapBundle;
}

export type { CompiledMapBundle };
