import { useCallback, useSyncExternalStore } from "react";
import type { BerthElement } from "@railway/map-schema";
import type { BerthState, CrossingState, RouteState, SignalState, TrtsState } from "./types.js";
import type { DelayBand } from "./delayBands.js";
import { changesSince, recordVersion } from "./recordChanges.js";

/**
 * Milestone 94: the live display state of each drawn element, one cell per element, so a live
 * update re-renders only the elements whose display changed. Before, every update re-rendered
 * the renderer's whole element list — tens of milliseconds a frame on a large map even when the
 * changed berth was not on screen.
 *
 * Cells are display values only (what is drawn), derived from the same records the renderer is
 * given; nothing here is a source of truth.
 */
export class LiveCells {
  private readonly values = new Map<string, unknown>();
  private readonly listeners = new Map<string, Set<() => void>>();

  get(key: string): unknown {
    return this.values.get(key);
  }

  set(key: string, value: unknown): void {
    if (this.values.get(key) === value) return;
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    const listeners = this.listeners.get(key);
    if (listeners) for (const listener of [...listeners]) listener();
  }

  subscribe(key: string, listener: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(key);
    };
  }
}

/** One cell's value, re-rendering the caller only when that cell changes. */
export function useCell<T>(cells: LiveCells, key: string): T | undefined {
  const subscribe = useCallback(
    (listener: () => void) => cells.subscribe(key, listener),
    [cells, key],
  );
  const read = useCallback(() => cells.get(key) as T | undefined, [cells, key]);
  return useSyncExternalStore(subscribe, read, read);
}

export const berthCell = (id: string): string => `b:${id}`;
export const bandCell = (id: string): string => `d:${id}`;
export const signalCell = (id: string): string => `s:${id}`;
export const trtsCell = (id: string): string => `t:${id}`;
export const crossingCell = (id: string): string => `x:${id}`;
export const routeCell = (id: string): string => `r:${id}`;

export interface LiveRecords {
  berths: Record<string, BerthState>;
  signals: Record<string, SignalState>;
  crossings: Record<string, CrossingState>;
  routes: Record<string, RouteState>;
  trts: Record<string, TrtsState>;
  delayBands: Record<string, DelayBand>;
}

/** The map's berths, and for each berth the berths it inhibits (`inhibitedBy` pointing at it),
 * so a change to one berth also refreshes the berths whose display depends on it. */
export interface BerthInfo {
  berths: ReadonlyMap<string, BerthElement>;
  inhibits: ReadonlyMap<string, string[]>;
}

export function berthInfo(elements: Iterable<{ id: string; type: string }>): BerthInfo {
  const berths = new Map<string, BerthElement>();
  const inhibits = new Map<string, string[]>();
  for (const element of elements) {
    if (element.type !== "berth") continue;
    const berth = element as BerthElement;
    berths.set(berth.id, berth);
    if (berth.inhibitedBy) {
      const list = inhibits.get(berth.inhibitedBy) ?? [];
      list.push(berth.id);
      inhibits.set(berth.inhibitedBy, list);
    }
  }
  return { berths, inhibits };
}

/** What a berth shows: its description, or nothing when vacant — or when the berth it is
 * inhibited by shows the identical description (opt-in TD-area fringe pairs, 2026-09-11 owner
 * request, `BerthElementSchema.inhibitedBy`). Purely cosmetic: live state, history and playback
 * keep the berth's real data untouched; only what gets drawn changes. */
export function shownDescription(
  berth: BerthElement,
  berths: Record<string, BerthState>,
): string | undefined {
  const raw = berths[berth.id]?.description;
  const inhibiting = berth.inhibitedBy ? berths[berth.inhibitedBy] : undefined;
  return raw && raw === inhibiting?.description ? undefined : raw || undefined;
}

/** What the cells were last brought up to date with: each record, and the version it was at
 * (the live socket patches its records in place; see recordChanges.ts). */
export interface SyncedRecords {
  records: LiveRecords;
  versions: Record<keyof LiveRecords, number>;
}

const KINDS = ["berths", "signals", "crossings", "routes", "trts", "delayBands"] as const;

function changedKeys(
  prev: Record<string, unknown>,
  prevVersion: number,
  next: Record<string, unknown>,
): readonly string[] {
  // The same record, patched in place: its change log says what changed.
  if (prev === next) return changesSince(next, prevVersion) ?? Object.keys(next);
  // A new record (a snapshot, or playback's records): compare every entry.
  const changed: string[] = [];
  for (const key in next) if (next[key] !== prev[key]) changed.push(key);
  for (const key in prev) if (!(key in next)) changed.push(key);
  return changed;
}

/**
 * Brings the cells up to date with `next`, touching only what changed since `prev` (everything
 * when `prev` is null), and returns what they are now synced with. A record patched in place
 * costs only its patched entries; a new record one pass over its keys.
 */
export function syncCells(
  cells: LiveCells,
  info: BerthInfo,
  prev: SyncedRecords | null,
  next: LiveRecords,
): SyncedRecords {
  const changed = (kind: keyof LiveRecords): readonly string[] =>
    prev
      ? changedKeys(
          prev.records[kind] as Record<string, unknown>,
          prev.versions[kind],
          next[kind] as Record<string, unknown>,
        )
      : Object.keys(next[kind]);
  const berthIds = prev
    ? changed("berths").flatMap((id) => [id, ...(info.inhibits.get(id) ?? [])])
    : [...info.berths.keys()];
  for (const id of berthIds) {
    const berth = info.berths.get(id);
    if (berth) cells.set(berthCell(id), shownDescription(berth, next.berths));
  }
  const records: Array<[keyof LiveRecords, (id: string) => string, (value: unknown) => unknown]> = [
    ["delayBands", bandCell, (v) => v],
    ["signals", signalCell, (v) => (v as SignalState | undefined)?.state],
    ["trts", trtsCell, (v) => (v as TrtsState | undefined)?.state === "lit" || undefined],
    ["crossings", crossingCell, (v) => (v as CrossingState | undefined)?.state],
    ["routes", routeCell, (v) => (v as RouteState | undefined)?.state === "set" || undefined],
  ];
  for (const [kind, cell, value] of records) {
    const record = next[kind] as Record<string, unknown>;
    for (const id of changed(kind)) cells.set(cell(id), value(record[id]));
  }
  const versions = {} as Record<keyof LiveRecords, number>;
  for (const kind of KINDS) versions[kind] = recordVersion(next[kind]);
  return { records: next, versions };
}
