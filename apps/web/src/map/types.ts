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
  mode: string;
  quality: { status: "ok" | "stale" | "unknown"; gaps: string[] };
  berths: Record<string, BerthState>;
  signals: Record<string, SignalState>;
}

export interface MapDefinitionResponse {
  mapSlug: string;
  mapVersion: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  definition: CompiledMapBundle;
}

export type { CompiledMapBundle };
