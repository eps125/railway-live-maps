import type { CompiledMapBundle } from "@railway/map-schema";

export interface RunSummary {
  status: "matched" | "ambiguous" | "unmatched";
  text: string | null;
}

export interface BerthState {
  description: string | null;
  enteredAt: string | null;
  runSummary: RunSummary | null;
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
