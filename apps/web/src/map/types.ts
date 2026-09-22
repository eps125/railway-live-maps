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

/** Milestone 55 / ADR 0014: a level crossing's barrier position. Not a signal aspect — rule 9's
 * blank/on/off vocabulary is untouched by it. `blank` means unbound, unknown or a feed gap, and
 * is never to be read as "up". */
export interface CrossingState {
  state: "blank" | "up" | "down";
}

/** Milestone 64 / ADR 0016: whether a route is set, from its bound route bit only. The map draws
 * a route only when `set`; `blank` (unbound, unknown or a feed gap) and `unset` draw nothing. */
export interface RouteState {
  state: "blank" | "set" | "unset";
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
  /** Absent from a response produced before crossings existed; read as "no crossings". */
  crossings?: Record<string, CrossingState>;
  /** Absent from a response produced before routes existed; read as "no routes set". */
  routes?: Record<string, RouteState>;
}

/** One compact playback event from `GET /api/v1/maps/{slug}/events` — the same wire shape as a
 * live WS `berth.updated` / `berth.cleared` / `signal.updated` delta, so playback applies them
 * with the same semantics as the live socket. */
export type PlaybackDelta =
  BerthPlaybackDelta | SignalPlaybackDelta | CrossingPlaybackDelta | RoutePlaybackDelta;

/** Milestone 64: a bound route's absolute state, same contract as `signal.updated`. */
export interface RoutePlaybackDelta {
  type: "route.updated";
  sequence: number;
  eventAt: string;
  elementId: string;
  state: RouteState["state"];
  tdArea: string;
  address: string;
  bit: number;
}

/** Milestone 55: a bound level crossing's absolute barrier position (only ever from its bound
 * S-Class bit). Same absolute-state contract as `signal.updated`, so a replayed or duplicated
 * delta is harmless. */
export interface CrossingPlaybackDelta {
  type: "crossing.updated";
  sequence: number;
  eventAt: string;
  elementId: string;
  state: CrossingState["state"];
  tdArea: string;
  address: string;
  bit: number;
}

/** Milestone 36b: a bound signal's absolute state (only ever from its bound S-Class bit). */
export interface SignalPlaybackDelta {
  type: "signal.updated";
  sequence: number;
  eventAt: string;
  elementId: string;
  state: SignalState["state"];
  tdArea: string;
  address: string;
  bit: number;
}

export type BerthPlaybackDelta =
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
