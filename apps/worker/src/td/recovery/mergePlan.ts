/**
 * Merge-mode recovery (2026-10-31): repair planning for a window where RLM holds *some* of the TD
 * messages and the rest are recovered from openrail-eps, interleaved. 31 Oct 06:43–06:54: ingest
 * fell behind and the broker dropped ~40% of frames, so every minute is part held, part lost.
 *
 * `repairPlan.ts` assumes a clean gap (pre-gap state → recovered events → first post-gap event).
 * Here each affected berth's *whole* event list for the window, held and recovered together in
 * arrival order (openrail-eps logged every message, in order), is replayed from the berth's state
 * at the window start up to its first event after the window. Every step into a berth opens an
 * occupancy whatever the berth's state, so the rows RLM already has line up one-to-one with the
 * replay by their entry event: they are updated in place (their closes change), never deleted, so
 * nothing that points at them breaks. Only rows opened by recovered events are new.
 *
 * Each plan also replays RLM's own events alone and compares that with the rows in the database
 * (`check`): an exact match shows the ordering and the event matching are right before anything is
 * written.
 *
 * No I/O. The command loads the inputs and executes the plans.
 */
import { isStaleRefreshByte, sBit, type SByteState } from "@railway/domain";
import {
  anomalyDetails,
  reduce,
  type BerthEventRef,
  type Close,
  type NewOccupancy,
  type PlannedAnomaly,
  type PlannedTransition,
  type SByteEventRef,
} from "./repairPlan.js";

/** A held event whose derived rows (anomalies, bit transitions) are replaced. Its event time is
 * carried so each delete is an exact index probe, not a scan of the whole post window: bounding
 * by the window alone read 13 h of nationwide anomalies (31 Oct, stopped after 5 min). */
export interface ReplacedEvent {
  rawEventId: string;
  eventAt: Date;
}

const replaced = (e: { rawEventId: string; eventAt: Date }): ReplacedEvent => ({
  rawEventId: e.rawEventId,
  eventAt: e.eventAt,
});

export interface MergeBerthEvent extends BerthEventRef {
  /** True for a message recovered from openrail-eps, false for one RLM holds. */
  recovered: boolean;
}

/** An occupancy row as it is in the database (its entry event identifies it). */
export interface ExistingOccupancy {
  occupancyId: string;
  /** null for the row open at the window start (opened before it). */
  entryEventId: string | null;
  description: string;
  enteredAt: Date;
  leftAt: Date | null;
  exitEventId: string | null;
}

export interface BerthMergeInput {
  tdArea: string;
  berth: string;
  /** The row open at the window start, if any. */
  pre: ExistingOccupancy | null;
  /** Every event touching the berth in the window, held and recovered, in arrival order. */
  events: MergeBerthEvent[];
  /** The first held event touching the berth after the window, if any. */
  firstPost: BerthEventRef | null;
  /** Rows opened by held events in the window, as the database has them. */
  existing: ExistingOccupancy[];
}

export interface RowUpdate {
  occupancyId: string;
  /** The corrected close; null = open. */
  close: Close | null;
}

export interface BerthMergePlan {
  tdArea: string;
  berth: string;
  /** Existing rows (the pre row included) whose close changes. */
  updates: RowUpdate[];
  /** Rows opened by recovered events. */
  inserts: NewOccupancy[];
  /** Anomalies for every event replayed, the first post-window event included. */
  anomalies: PlannedAnomaly[];
  /** Held events (and the first post-window event) whose anomalies on this berth are replaced. */
  replaceAnomaliesOf: ReplacedEvent[];
  /** When the berth has had no event since the window: its corrected current state. */
  currentState: {
    description: string | null;
    enteredAt: Date | null;
    source: BerthEventRef;
  } | null;
  /** Replaying RLM's own events alone against the database: rows compared and matched. */
  check: { rows: number; reproduced: number };
  /** Held-event rows the replay expected but the database doesn't have (must be 0). */
  missingRows: number;
}

interface ReplayRow {
  entryEventId: string | null; // null = the pre row
  recovered: boolean;
  description: string;
  enteredAt: Date;
  entryEventNormalizedAt: Date;
  entryReason: string;
  close: Close | null;
}

interface Replay {
  rows: ReplayRow[];
  anomalies: PlannedAnomaly[];
  open: number | null;
}

function replay(
  pre: ExistingOccupancy | null,
  events: MergeBerthEvent[],
  firstPost: BerthEventRef | null,
  tdArea: string,
  berth: string,
): Replay {
  const rows: ReplayRow[] = [];
  const anomalies: PlannedAnomaly[] = [];
  let open: number | null = null;
  if (pre) {
    rows.push({
      entryEventId: null,
      recovered: false,
      description: pre.description,
      enteredAt: pre.enteredAt,
      entryEventNormalizedAt: pre.enteredAt,
      entryReason: "",
      close: null,
    });
    open = 0;
  }
  const apply = (event: BerthEventRef, recovered: boolean, isFirstPost: boolean): void => {
    const desc = open === null ? null : rows[open]!.description;
    for (const effect of reduce(event, desc === null ? null : { description: desc })) {
      if (effect.kind === "recordAnomaly") {
        anomalies.push({
          rawEventId: event.rawEventId,
          rawEventNormalizedAt: event.rawEventNormalizedAt,
          eventAt: event.eventAt,
          ingestionSequence: event.ingestionSequence,
          anomalyCode: effect.anomalyCode,
          details: anomalyDetails(effect, tdArea, berth),
        });
      } else if (effect.kind === "closeOccupancy") {
        if (open !== null) {
          rows[open]!.close = {
            leftAt: event.eventAt,
            exitEventId: event.rawEventId,
            exitEventNormalizedAt: event.rawEventNormalizedAt,
            exitReason: effect.exitReason,
          };
        }
        open = null;
      } else if (isFirstPost) {
        open = null; // the first post-window event's own row exists and is right
      } else {
        rows.push({
          entryEventId: event.rawEventId,
          recovered,
          description: effect.description,
          enteredAt: event.eventAt,
          entryEventNormalizedAt: event.rawEventNormalizedAt,
          entryReason: effect.entryReason,
          close: null,
        });
        open = rows.length - 1;
      }
    }
  };
  for (const event of events) apply(event, event.recovered, false);
  const finalOpen = open;
  if (firstPost) apply(firstPost, false, true);
  return { rows, anomalies, open: finalOpen };
}

const sameClose = (close: Close | null, row: ExistingOccupancy): boolean =>
  close === null
    ? row.leftAt === null
    : row.leftAt !== null &&
      row.leftAt.getTime() === close.leftAt.getTime() &&
      row.exitEventId === close.exitEventId;

export function planBerthMerge(input: BerthMergeInput): BerthMergePlan {
  const byEntry = new Map(input.existing.map((r) => [r.entryEventId, r]));
  const dbRow = (row: ReplayRow): ExistingOccupancy | undefined =>
    row.entryEventId === null ? (input.pre ?? undefined) : byEntry.get(row.entryEventId);

  // RLM's own events alone must reproduce what the database holds.
  const own = replay(
    input.pre,
    input.events.filter((e) => !e.recovered),
    input.firstPost,
    input.tdArea,
    input.berth,
  );
  let rows = 0;
  let reproduced = 0;
  for (const row of own.rows) {
    const db = dbRow(row);
    if (!db) continue;
    rows += 1;
    if (sameClose(row.close, db)) reproduced += 1;
  }

  const merged = replay(input.pre, input.events, input.firstPost, input.tdArea, input.berth);
  const updates: RowUpdate[] = [];
  const inserts: NewOccupancy[] = [];
  let missingRows = 0;
  for (const row of merged.rows) {
    if (row.recovered) {
      inserts.push({
        description: row.description,
        enteredAt: row.enteredAt,
        entryEventId: row.entryEventId!,
        entryEventNormalizedAt: row.entryEventNormalizedAt,
        entryReason: row.entryReason,
        close: row.close,
      });
      continue;
    }
    const db = dbRow(row);
    if (!db) {
      missingRows += 1;
      continue;
    }
    if (!sameClose(row.close, db)) updates.push({ occupancyId: db.occupancyId, close: row.close });
  }

  const lastEvent = input.events.at(-1) ?? null;
  let currentState: BerthMergePlan["currentState"] = null;
  if (!input.firstPost && lastEvent) {
    const open = merged.open === null ? null : merged.rows[merged.open]!;
    currentState = {
      description: open?.description ?? null,
      enteredAt: open?.enteredAt ?? null,
      source: lastEvent,
    };
  }

  return {
    tdArea: input.tdArea,
    berth: input.berth,
    updates,
    inserts,
    anomalies: merged.anomalies,
    replaceAnomaliesOf: [
      ...input.events.filter((e) => !e.recovered).map(replaced),
      ...(input.firstPost ? [replaced(input.firstPost)] : []),
    ],
    currentState,
    check: { rows, reproduced },
    missingRows,
  };
}

// ---- S-Class (per byte) ----

export interface MergeByteEvent extends SByteEventRef {
  recovered: boolean;
  /** For a refresh chunk: when its area's refresh sweep began (the stale-refresh guard reads it). */
  sweepStartedAt?: Date | null;
}

/** How the byte was last stated before the window, for the stale-refresh guard. */
export interface BytePreState {
  value: number;
  sourceKind: "update" | "refresh";
  statedAt: Date;
}

export interface ByteMergeInput {
  tdArea: string;
  address: string;
  /** Known bit values at the window start (index = bit), null = unknown. */
  preBits: (boolean | null)[];
  pre: BytePreState | null;
  /** Every statement of the byte in the window, held and recovered, in arrival order. */
  events: MergeByteEvent[];
  firstPost: (SByteEventRef & { sweepStartedAt?: Date | null }) | null;
  /** Bit transitions the database has from the held events and the first post-window event. */
  existingTransitions: number;
}

export interface ByteMergePlan {
  tdArea: string;
  address: string;
  transitions: PlannedTransition[];
  /** Held events (and the first post-window event) whose transitions for this byte are replaced. */
  replaceTransitionsOf: ReplacedEvent[];
  currentState: { value: number; source: SByteEventRef } | null;
  check: { existing: number; reproduced: number };
  /** No value known for the byte before the window (its replay starts from unknown bits). */
  unknownPre: boolean;
}

/**
 * Folds the byte's statements as the projector does, including its stale-refresh guard
 * (`isStaleRefreshByte`): a refresh chunk is skipped when an SF stated the byte after its sweep
 * began, since the chunk is a slightly older snapshot. Without the guard the replay made 77
 * transitions the projector never did (31 Oct plan, 162,836 against 162,759).
 */
function stepBits(
  preBits: (boolean | null)[],
  pre: BytePreState | null,
  events: (SByteEventRef & { sweepStartedAt?: Date | null })[],
): { transitions: PlannedTransition[]; lastApplied: SByteEventRef | null } {
  let bits = [...preBits];
  let known: SByteState | undefined = pre
    ? {
        value: pre.value,
        sourceIngestionSequence: "0",
        sourceKind: pre.sourceKind,
        statedAt: pre.statedAt,
      }
    : undefined;
  let lastApplied: SByteEventRef | null = null;
  const transitions: PlannedTransition[] = [];
  for (const event of events) {
    if (
      event.sourceKind === "refresh" &&
      event.sweepStartedAt &&
      isStaleRefreshByte(known, event.value, event.sweepStartedAt)
    ) {
      continue;
    }
    for (let bit = 0; bit < 8; bit += 1) {
      const newValue = sBit(event.value, bit);
      const previousValue = bits[bit] ?? null;
      if (previousValue === newValue) continue;
      transitions.push({ bitIndex: bit, previousValue, newValue, event });
    }
    bits = Array.from({ length: 8 }, (_, bit) => sBit(event.value, bit));
    known = {
      value: event.value,
      sourceIngestionSequence: event.ingestionSequence,
      sourceKind: event.sourceKind,
      statedAt: event.eventAt,
    };
    lastApplied = event;
  }
  return { transitions, lastApplied };
}

export function planByteMerge(input: ByteMergeInput): ByteMergePlan {
  const post = input.firstPost ? [input.firstPost] : [];
  const own = stepBits(input.preBits, input.pre, [
    ...input.events.filter((e) => !e.recovered),
    ...post,
  ]).transitions;
  // Current state is only set when nothing follows the window, so `lastApplied` is then the
  // window's own last applied statement.
  const merged = stepBits(input.preBits, input.pre, [...input.events, ...post]);
  const transitions = merged.transitions;
  const last = merged.lastApplied;
  return {
    tdArea: input.tdArea,
    address: input.address,
    transitions,
    replaceTransitionsOf: [...input.events.filter((e) => !e.recovered), ...post].map(replaced),
    currentState: !input.firstPost && last ? { value: last.value, source: last } : null,
    check: { existing: input.existingTransitions, reproduced: own.length },
    unknownPre: input.preBits.every((b) => b === null),
  };
}
