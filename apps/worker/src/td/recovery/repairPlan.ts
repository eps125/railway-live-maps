/**
 * ADR 0020 option B: pure, per-berth and per-byte repair planning for TD recovered after a gap.
 *
 * Why per berth is exact: the C-Class reducers (`applyCA/CB/CC`) compute each berth's effects from
 * that berth's own open-occupancy snapshot only, and every event touching a berth resets its state
 * (a CA/CC into it opens a fresh occupancy with the message's description; a CA/CB out of it
 * empties it). So once a berth's *first post-gap* event has been applied, the original and
 * corrected histories are identical, including the open row (both opened by that same event). The
 * repair is therefore bounded to [pre-gap state → recovered events → first post-gap event] per
 * berth and never cascades. The same holds per S-Class byte: each SF states the full byte.
 *
 * No I/O. Callers load the inputs and execute the plan.
 */
import { applyCA, applyCB, applyCC, sBit, type BerthEffect } from "@railway/domain";

export type BerthRole = "from" | "to";

export interface BerthEventRef {
  /** raw_feed_event id (recovered rows: the id allocated for the recovered row). */
  rawEventId: string;
  rawEventNormalizedAt: Date;
  eventAt: Date;
  ingestionSequence: string;
  type: "CA" | "CB" | "CC";
  description: string;
  /** This berth's part in the event. */
  role: BerthRole;
}

export interface PreOpenRow {
  occupancyId: string;
  description: string;
  enteredAt: Date;
}

export interface BerthRepairInput {
  tdArea: string;
  berth: string;
  /** The occupancy open on this berth after the last pre-gap event (null = empty). */
  pre: PreOpenRow | null;
  /** Recovered events touching this berth, in event order. */
  recovered: BerthEventRef[];
  /** The first original event touching this berth after the gap (ingestion order), if any. */
  firstPost: BerthEventRef | null;
}

export interface Close {
  leftAt: Date;
  exitEventId: string;
  exitEventNormalizedAt: Date;
  exitReason: string;
}

export interface NewOccupancy {
  /** Index into the plan's own list; the executor allocates real ids. */
  description: string;
  enteredAt: Date;
  entryEventId: string;
  entryEventNormalizedAt: Date;
  entryReason: string;
  close: Close | null;
}

export interface PlannedAnomaly {
  rawEventId: string;
  rawEventNormalizedAt: Date;
  eventAt: Date;
  ingestionSequence: string;
  anomalyCode: string;
  details: Record<string, unknown>;
}

export interface BerthRepairPlan {
  tdArea: string;
  berth: string;
  /** New close for the pre-gap row (it now ends inside the recovered window); null = unchanged. */
  preClose: Close | null;
  /** The pre-gap row `preClose` applies to. */
  preOccupancyId: string | null;
  inserts: NewOccupancy[];
  /** Anomalies to record for recovered events and the corrected first post-gap event. */
  anomalies: PlannedAnomaly[];
  /** The original first post-gap event whose anomalies on this berth are replaced. */
  replaceAnomaliesOfEventId: string | null;
  /** Event time of that event (anomaly rows are bounded by it, so the delete never scans). */
  replaceAnomaliesEventAt: Date | null;
  /** Set when the berth has had no event since the gap: the corrected current state. */
  currentState: {
    description: string | null;
    enteredAt: Date | null;
    source: BerthEventRef;
  } | null;
}

type Snapshot = { ref: "pre" } | { ref: "new"; index: number };

function reduce(event: BerthEventRef, open: { description: string } | null): BerthEffect[] {
  const snap = open ? { occupancyId: "x", description: open.description, enteredAt: "" } : null;
  // The other berth of a CA is irrelevant to this berth's effects (each side reads only its own
  // snapshot), so it is passed as empty and its effects are filtered out below.
  const effects =
    event.type === "CA"
      ? applyCA({
          fromBerth: "f",
          toBerth: "t",
          description: event.description,
          fromOpen: event.role === "from" ? snap : null,
          toOpen: event.role === "to" ? snap : null,
        }).effects
      : event.type === "CB"
        ? applyCB({ fromBerth: "f", description: event.description, fromOpen: snap }).effects
        : applyCC({ toBerth: "t", description: event.description, toOpen: snap }).effects;
  return effects.filter((e) =>
    e.kind === "openOccupancy" ? event.role === "to" : e.berth === event.role,
  );
}

function anomalyDetails(
  effect: Extract<BerthEffect, { kind: "recordAnomaly" }>,
  tdArea: string,
  berth: string,
): Record<string, unknown> {
  // Exactly the detail shape the projector records, with the real berth restored in place of the
  // placeholder passed to the reducer.
  void tdArea;
  const details = { ...effect.details };
  if ("fromBerth" in details) details.fromBerth = berth;
  return details;
}

export function planBerthRepair(input: BerthRepairInput): BerthRepairPlan {
  const inserts: NewOccupancy[] = [];
  const anomalies: PlannedAnomaly[] = [];
  let preClose: Close | null = null;
  let open: Snapshot | null = input.pre ? { ref: "pre" } : null;
  const openDescription = (): string | null =>
    open === null
      ? null
      : open.ref === "pre"
        ? input.pre!.description
        : inserts[open.index]!.description;

  const apply = (event: BerthEventRef, isFirstPost: boolean): void => {
    const desc = openDescription();
    for (const effect of reduce(event, desc === null ? null : { description: desc })) {
      if (effect.kind === "recordAnomaly") {
        anomalies.push({
          rawEventId: event.rawEventId,
          rawEventNormalizedAt: event.rawEventNormalizedAt,
          eventAt: event.eventAt,
          ingestionSequence: event.ingestionSequence,
          anomalyCode: effect.anomalyCode,
          details: anomalyDetails(effect, input.tdArea, input.berth),
        });
      } else if (effect.kind === "closeOccupancy") {
        const close: Close = {
          leftAt: event.eventAt,
          exitEventId: event.rawEventId,
          exitEventNormalizedAt: event.rawEventNormalizedAt,
          exitReason: effect.exitReason,
        };
        if (open?.ref === "pre") {
          // A close of the pre row by the first post-gap event is what the original fold already
          // wrote — only a close by a recovered event is a change.
          if (!isFirstPost) preClose = close;
        } else if (open?.ref === "new") {
          inserts[open.index]!.close = close;
        }
        open = null;
      } else if (!isFirstPost) {
        // openOccupancy by a recovered event. (The first post-gap event's open already exists in
        // the database, written by the original fold.)
        inserts.push({
          description: effect.description,
          enteredAt: event.eventAt,
          entryEventId: event.rawEventId,
          entryEventNormalizedAt: event.rawEventNormalizedAt,
          entryReason: effect.entryReason,
          close: null,
        });
        open = { ref: "new", index: inserts.length - 1 };
      } else {
        open = null; // first post-gap open: the original row takes over from here
      }
    }
  };

  for (const event of input.recovered) apply(event, false);
  const afterRecovered = openDescription();
  const lastRecovered = input.recovered.at(-1) ?? null;
  if (input.firstPost) apply(input.firstPost, true);

  let currentState: BerthRepairPlan["currentState"] = null;
  if (!input.firstPost && lastRecovered) {
    const latestInsert = inserts.at(-1);
    currentState = {
      description: afterRecovered,
      enteredAt:
        afterRecovered === null
          ? null
          : latestInsert && latestInsert.close === null
            ? latestInsert.enteredAt
            : (input.pre?.enteredAt ?? null),
      source: lastRecovered,
    };
  }

  return {
    tdArea: input.tdArea,
    berth: input.berth,
    preClose,
    preOccupancyId: input.pre?.occupancyId ?? null,
    inserts,
    anomalies,
    replaceAnomaliesOfEventId: input.firstPost?.rawEventId ?? null,
    replaceAnomaliesEventAt: input.firstPost?.eventAt ?? null,
    currentState,
  };
}

// ---- S-Class (per byte) ----

export interface SByteEventRef {
  rawEventId: string;
  rawEventNormalizedAt: Date;
  eventAt: Date;
  ingestionSequence: string;
  value: number;
  sourceKind: "update" | "refresh";
}

export interface SByteRepairInput {
  tdArea: string;
  address: string;
  /** Known bit values just before the gap (index = bit), null = unknown. */
  preBits: (boolean | null)[];
  recovered: SByteEventRef[];
  firstPost: SByteEventRef | null;
}

export interface PlannedTransition {
  bitIndex: number;
  previousValue: boolean | null;
  newValue: boolean;
  event: SByteEventRef;
}

export interface SByteRepairPlan {
  tdArea: string;
  address: string;
  transitions: PlannedTransition[];
  /** Original first post-gap event whose transitions for this byte are replaced. */
  replaceTransitionsOfEventId: string | null;
  replaceTransitionsEventAt: Date | null;
  /** Set when the byte has had no event since the gap. */
  currentState: { value: number; source: SByteEventRef } | null;
}

export function planSByteRepair(input: SByteRepairInput): SByteRepairPlan {
  let bits = [...input.preBits];
  const transitions: PlannedTransition[] = [];
  const step = (event: SByteEventRef): void => {
    for (let bit = 0; bit < 8; bit += 1) {
      const newValue = sBit(event.value, bit);
      const previousValue = bits[bit] ?? null;
      if (previousValue === newValue) continue;
      transitions.push({ bitIndex: bit, previousValue, newValue, event });
    }
    bits = Array.from({ length: 8 }, (_, bit) => sBit(event.value, bit));
  };
  for (const event of input.recovered) step(event);
  const lastRecovered = input.recovered.at(-1) ?? null;
  if (input.firstPost) step(input.firstPost);
  return {
    tdArea: input.tdArea,
    address: input.address,
    transitions,
    replaceTransitionsOfEventId: input.firstPost?.rawEventId ?? null,
    replaceTransitionsEventAt: input.firstPost?.eventAt ?? null,
    currentState:
      !input.firstPost && lastRecovered
        ? { value: lastRecovered.value, source: lastRecovered }
        : null,
  };
}
