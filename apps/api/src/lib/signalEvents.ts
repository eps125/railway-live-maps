import type { Pool } from "pg";
import {
  SIGNAL_GAP_TOLERANCE_MS,
  TD_RECEIVE_SILENCE_REASON,
  barrierBindingsFromIndex,
  barrierStateFromSignalState,
  computeSignalStates,
  inferredBarrierState,
  inferredInputBindings,
  inferredInputElementId,
  routeBindingsFromIndex,
  routeStateFromSignalState,
  signalBindingsFromIndex,
  signalStateForBit,
  trtsBindingsFromIndex,
  trtsStateFromSignalState,
  type BarrierDisplayState,
  type SignalBinding,
  type SignalDisplayState,
} from "@railway/domain";
import { createSignalFactsPort } from "@railway/database";
import type { CompiledMapBundle } from "@railway/map-schema";
import type { LiveDeltaMessage } from "@railway/protocol";

/**
 * Milestone 36b: the signal half of `GET /api/v1/maps/{slug}/events` (playback). Emits the same
 * `signal.updated` wire shape as the live WS, so the playback client applies it with the same code.
 *
 * - Every decoded `td_s_event` row stating a bound byte yields the absolute state of each signal
 *   bound to that byte (a re-confirmation after a silence therefore restores it).
 * - Every recorded TD receive silence yields `blank` for every bound signal at the moment the
 *   silence passed the trust tolerance (`start + 5 min`), sequenced at the silence's start row —
 *   the same instant `/state?at=` starts blanking them (CLAUDE.md rule 13).
 *
 * Rows before decoding existed (`raw_only`) produce nothing: that history is unknown, not guessed.
 */

export interface SequencedEvent {
  /** Event time (ms) of the source row: playback's primary order (2026-10-31). */
  eventAtMs: number;
  /** Arrival position within one event time: `playback_sequence` for a recovered row (the held
   * message just before it in openrail-eps's order), else its own ingestion sequence. */
  sortSequence: bigint;
  /** Ingestion sequence of the source row: the last tie-break. */
  sequence: bigint;
  /** Tie-break within one sequence: 0 = a row's own events, 1 = a silence blank placed after it. */
  order: number;
  messages: LiveDeltaMessage[];
}

/**
 * Where a playback `/events` page resumes: after this (event time, ingestion sequence).
 *
 * 2026-10-31: playback is ordered by event time, then sequence. It was ordered by sequence alone,
 * which is arrival order — but a message can be stored long after it happened: one redelivered
 * after a reconnect, or recovered from openrail-eps (31 Oct 06:43–06:54, sequenced that evening).
 * The player applies events in the order sent and stops at the first one still in the future, so
 * such steps were applied late and left trains shown in berths they had left.
 */
export interface EventsCursor {
  at: Date;
  sortSequence: string;
  sequence: string;
}

/** A page's resume point, as the opaque `nextCursor` string:
 * `<event time ms>:<sort sequence>:<sequence>`. */
export function encodeEventsCursor(
  event: Pick<SequencedEvent, "eventAtMs" | "sortSequence" | "sequence">,
): string {
  return `${event.eventAtMs}:${event.sortSequence}:${event.sequence}`;
}

/**
 * Parses an `after` cursor. `"0"` (or absent) is the start of the window. A plain number is a
 * cursor from before 2026-10-31 (a bare sequence), still held by open tabs: `legacy`, resolved by
 * the caller to that row's event time. Anything else is invalid.
 */
export function parseEventsCursor(
  raw: string | undefined,
):
  | { kind: "start" }
  | { kind: "cursor"; at: Date; sortSequence: string; sequence: string }
  | { kind: "legacy"; sequence: string }
  | null {
  if (raw === undefined || raw === "" || raw === "0") return { kind: "start" };
  // `<ms>:<sort sequence>:<sequence>`, or the two-part form served before playback_sequence
  // (2026-10-31 evening), where the sort sequence is the sequence itself.
  const composite = /^(\d{1,15}):(\d{1,19})(?::(\d{1,19}))?$/.exec(raw);
  if (composite) {
    return {
      kind: "cursor",
      at: new Date(Number(composite[1])),
      sortSequence: composite[2]!,
      sequence: composite[3] ?? composite[2]!,
    };
  }
  if (/^\d{1,19}$/.test(raw)) return { kind: "legacy", sequence: raw };
  return null;
}

/** Total order of playback entries: event time, then sequence, then `order`. */
export function compareSequencedEvents(a: SequencedEvent, b: SequencedEvent): number {
  if (a.eventAtMs !== b.eventAtMs) return a.eventAtMs < b.eventAtMs ? -1 : 1;
  if (a.sortSequence !== b.sortSequence) return a.sortSequence < b.sortSequence ? -1 : 1;
  if (a.sequence !== b.sequence) return a.sequence < b.sequence ? -1 : 1;
  return a.order - b.order;
}

/** One independently-paged source: its events in sequence order, and whether it hit `limit`
 * (more may follow its last sequence). */
export interface EventSource {
  events: SequencedEvent[];
  full: boolean;
}

/** Milestone 55 / ADR 0014: playback covers level crossings as well as signals. Both resolve
 * from the same bytes by the same rules, so they are paged together as one stream and only the
 * emitted message type differs — keeping barrier playback in exact step with signal playback
 * (including the blank-on-silence rule below) rather than as a second, drifting implementation. */
type PlaybackBinding = SignalBinding & {
  kind: "signal" | "barrier" | "route" | "trts" | "input";
};

/** The absolute-state message for one signal, crossing or route (Milestone 64 added routes, in
 * the same stream so a route set/unset stays in exact step with its signal in playback). */
function stateMessage(
  kind: "signal" | "barrier" | "route" | "trts",
  resolved: SignalDisplayState,
  fields: {
    sequence: number;
    eventAt: string;
    elementId: string;
    tdArea: string;
    address: string;
    bit: number;
  },
): LiveDeltaMessage {
  if (kind === "barrier") {
    return { type: "crossing.updated", ...fields, state: barrierStateFromSignalState(resolved) };
  }
  if (kind === "route") {
    return { type: "route.updated", ...fields, state: routeStateFromSignalState(resolved) };
  }
  if (kind === "trts") {
    return { type: "trts.updated", ...fields, state: trtsStateFromSignalState(resolved) };
  }
  return { type: "signal.updated", ...fields, state: resolved };
}

function bindingsByByte(bindings: PlaybackBinding[]): Map<string, PlaybackBinding[]> {
  const byByte = new Map<string, PlaybackBinding[]>();
  for (const binding of bindings) {
    const key = `${binding.tdArea}|${binding.address}`;
    byByte.set(key, [...(byByte.get(key) ?? []), binding]);
  }
  return byByte;
}

export async function fetchSignalPlaybackEvents(
  pool: Pool,
  bundle: CompiledMapBundle,
  range: { from: Date; to: Date },
  after: EventsCursor,
  limit: number,
): Promise<EventSource[]> {
  // Milestone 59 / ADR 0015: an inferred crossing's inputs ride along as bindings of their own
  // kind, so rows touching their bytes are fetched by the same query — but they never emit a
  // message themselves; they feed the crossing's combined state below.
  const inferredIndex = bundle.inferredBarrierBindings ?? {};
  const inputBindings = inferredInputBindings(inferredIndex);
  const inputOwner = new Map<string, string>();
  for (const [crossingId, inputs] of Object.entries(inferredIndex)) {
    inputs.forEach((_, i) => inputOwner.set(inferredInputElementId(crossingId, i), crossingId));
  }

  const bindings: PlaybackBinding[] = [
    ...signalBindingsFromIndex(bundle.sBitBindingIndex ?? {}, bundle.sBitBindingActiveMeans).map(
      (binding) => ({ ...binding, kind: "signal" as const }),
    ),
    ...barrierBindingsFromIndex(bundle.barrierBindingIndex, bundle.barrierBindingActiveMeans).map(
      (binding) => ({ ...binding, kind: "barrier" as const }),
    ),
    ...routeBindingsFromIndex(bundle.routeBindingIndex, bundle.routeBindingActiveMeans).map(
      (binding) => ({ ...binding, kind: "route" as const }),
    ),
    // Milestone 92: each resolves on its own here, so the message can carry the signal's own id
    // (the `#trts` key only matters where states share one map).
    ...trtsBindingsFromIndex(bundle.trtsBindingIndex, bundle.trtsBindingActiveMeans).map(
      (binding) => ({
        ...binding,
        elementId: binding.elementId.replace(/#trts$/, ""),
        kind: "trts" as const,
      }),
    ),
    ...inputBindings.map((binding) => ({ ...binding, kind: "input" as const })),
  ];
  if (bindings.length === 0) return [];
  const byByte = bindingsByByte(bindings);
  const tdAreas = [...new Set(bindings.map((b) => b.tdArea))];
  const addresses = [...new Set(bindings.map((b) => b.address))];

  // Same `materialized` fence as the berth half (and for the same reason — see maps.ts): filter by
  // the selective `(td_area, event_at)` index first, then apply the cursor/order/limit.
  const rows = await pool.query<{
    ingestion_sequence: string;
    sort_sequence: string;
    event_at: Date;
    td_area: string;
    decoded_bitset: { bytes: Record<string, number> };
  }>(
    `with candidates as materialized (
       select e.ingestion_sequence, coalesce(e.playback_sequence, e.ingestion_sequence) as sort_sequence,
              e.event_at, e.td_area, e.decoded_bitset
         from td_s_event e
        where e.td_area = any($1::text[])
          and e.event_at >= $2 and e.event_at < $3
          and e.decode_status = 'decoded'
          and e.decoded_bitset->'bytes' ?| $4::text[]
     )
     select c.ingestion_sequence::text as ingestion_sequence, c.sort_sequence::text as sort_sequence,
            c.event_at, c.td_area, c.decoded_bitset
       from candidates c
      where (c.event_at, c.sort_sequence, c.ingestion_sequence) > ($5::timestamptz, $8::bigint, $6::bigint)
      order by c.event_at, c.sort_sequence, c.ingestion_sequence
      limit $7`,
    [tdAreas, range.from, range.to, addresses, after.at, after.sequence, limit, after.sortSequence],
  );

  // Silences whose tolerance ran out inside the window. Fetched before the rows are folded so an
  // inferred crossing's inputs can be reset to unknown at the same point the stream blanks.
  const toleranceSeconds = SIGNAL_GAP_TOLERANCE_MS / 1000;
  const silences = await pool.query<{ affected_sequence_start: string; blank_at: Date }>(
    `select g.affected_sequence_start::text as affected_sequence_start,
            g.detected_start + make_interval(secs => $5) as blank_at
       from feed_gap g
      where g.feed_name = 'TD' and g.detection_reason = $1
        and g.affected_sequence_start is not null
        and g.detected_start + make_interval(secs => $5) >= $2
        and g.detected_start + make_interval(secs => $5) < $3
        and (g.detected_start + make_interval(secs => $5), g.affected_sequence_start, g.affected_sequence_start)
            > ($4::timestamptz, $8::bigint, $7::bigint)
      order by blank_at, g.affected_sequence_start
      limit $6`,
    [
      TD_RECEIVE_SILENCE_REASON,
      range.from,
      range.to,
      after.at,
      toleranceSeconds,
      limit,
      after.sequence,
      after.sortSequence,
    ],
  );

  // A row carries only the bytes it restated, but an inferred crossing combines bits that can
  // live in different bytes. So seed every input's state as of this page's first row, with the
  // exact resolver the snapshot uses (trust, lookback), then fold forward row by row.
  const inputState = new Map<string, SignalDisplayState>();
  const firstRow = rows.rows[0];
  if (inputBindings.length > 0 && firstRow) {
    const seeded = await computeSignalStates(createSignalFactsPort(pool), {
      signalElementIds: inputBindings.map((b) => b.elementId),
      bindings: inputBindings,
      at: firstRow.event_at,
      live: false,
    });
    for (const binding of inputBindings) {
      inputState.set(binding.elementId, seeded[binding.elementId]?.state ?? "blank");
    }
  }
  const combined = (crossingId: string): BarrierDisplayState =>
    inferredBarrierState(
      (inferredIndex[crossingId] ?? []).map(
        (_, i) => inputState.get(inferredInputElementId(crossingId, i)) ?? "blank",
      ),
    );
  const resetInputs = (): void => {
    for (const binding of inputBindings) inputState.set(binding.elementId, "blank");
  };
  // Silences in playback order (blank time, then sequence), compared with each row's own key:
  // one before a row blanks the inputs before it; one at the row's own key, after it.
  const silenceKeys = silences.rows.map((s) => ({
    eventAtMs: s.blank_at.getTime(),
    sortSequence: BigInt(s.affected_sequence_start),
    sequence: BigInt(s.affected_sequence_start),
    order: 1,
    messages: [],
  }));
  let nextSilence = 0;

  const events: SequencedEvent[] = [];
  for (const row of rows.rows) {
    const sequence = Number(row.ingestion_sequence);
    const rowSequence = BigInt(row.ingestion_sequence);
    const rowKey = {
      eventAtMs: row.event_at.getTime(),
      sortSequence: BigInt(row.sort_sequence),
      sequence: rowSequence,
      order: 0,
      messages: [],
    };
    // A silence that blanked before this row blanked every input before it arrived.
    while (
      nextSilence < silenceKeys.length &&
      compareSequencedEvents(silenceKeys[nextSilence]!, rowKey) < 0 &&
      !(
        silenceKeys[nextSilence]!.eventAtMs === rowKey.eventAtMs &&
        silenceKeys[nextSilence]!.sequence === rowSequence
      )
    ) {
      resetInputs();
      nextSilence += 1;
    }

    const messages: LiveDeltaMessage[] = [];
    // Inferred crossings this row touched, with the input bit that triggered each.
    const touched = new Map<string, { address: string; bit: number }>();
    for (const [address, value] of Object.entries(row.decoded_bitset.bytes)) {
      for (const binding of byByte.get(`${row.td_area}|${address}`) ?? []) {
        const resolved = signalStateForBit(value, binding.bit, binding.activeMeans);
        if (binding.kind === "input") {
          inputState.set(binding.elementId, resolved);
          const crossingId = inputOwner.get(binding.elementId);
          if (crossingId) touched.set(crossingId, { address, bit: binding.bit });
          continue;
        }
        messages.push(
          stateMessage(binding.kind, resolved, {
            sequence,
            eventAt: row.event_at.toISOString(),
            elementId: binding.elementId,
            tdArea: row.td_area,
            address,
            bit: binding.bit,
          }),
        );
      }
    }
    // Absolute state, emitted whenever an input is restated — like every other entry here, a
    // repeat is harmless, and it never depends on whether the seed already included this row.
    for (const [crossingId, trigger] of touched) {
      messages.push({
        type: "crossing.updated",
        sequence,
        eventAt: row.event_at.toISOString(),
        elementId: crossingId,
        state: combined(crossingId),
        tdArea: row.td_area,
        address: trigger.address,
        bit: trigger.bit,
      });
    }
    // Kept even when empty: it is a fetched row the paging bound must account for.
    events.push({
      eventAtMs: rowKey.eventAtMs,
      sortSequence: rowKey.sortSequence,
      sequence: rowSequence,
      order: 0,
      messages,
    });

    // A silence at this row's own key blanks after the row's own entries (order 1 below).
    while (
      nextSilence < silenceKeys.length &&
      silenceKeys[nextSilence]!.eventAtMs === rowKey.eventAtMs &&
      silenceKeys[nextSilence]!.sequence === rowSequence
    ) {
      resetInputs();
      nextSilence += 1;
    }
  }

  const blanks: SequencedEvent[] = [];
  for (const silence of silences.rows) {
    const sequence = Number(silence.affected_sequence_start);
    const eventAt = silence.blank_at.toISOString();
    blanks.push({
      eventAtMs: silence.blank_at.getTime(),
      sortSequence: BigInt(silence.affected_sequence_start),
      sequence: BigInt(silence.affected_sequence_start),
      order: 1,
      messages: [
        ...bindings.flatMap((binding): LiveDeltaMessage[] =>
          binding.kind === "input"
            ? []
            : [
                stateMessage(binding.kind, "blank", {
                  sequence,
                  eventAt,
                  elementId: binding.elementId,
                  tdArea: binding.tdArea,
                  address: binding.address,
                  bit: binding.bit,
                }),
              ],
        ),
        // Every input unknown, so every inferred crossing is too.
        ...Object.entries(inferredIndex).flatMap(([crossingId, inputs]): LiveDeltaMessage[] => {
          const first = inputs[0];
          return first
            ? [
                {
                  type: "crossing.updated",
                  sequence,
                  eventAt,
                  elementId: crossingId,
                  state: "blank",
                  tdArea: first.tdArea,
                  address: first.address,
                  bit: first.bit,
                },
              ]
            : [];
        }),
      ],
    });
  }

  return [
    { events, full: rows.rows.length === limit },
    { events: blanks, full: silences.rows.length === limit },
  ];
}
