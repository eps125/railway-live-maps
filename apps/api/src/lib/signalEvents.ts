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
  signalBindingsFromIndex,
  signalStateForBit,
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
  /** Ingestion sequence of the source row (the playback cursor). */
  sequence: bigint;
  /** Tie-break within one sequence: 0 = a row's own events, 1 = a silence blank placed after it. */
  order: number;
  messages: LiveDeltaMessage[];
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
type PlaybackBinding = SignalBinding & { kind: "signal" | "barrier" | "input" };

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
  after: string,
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
    event_at: Date;
    td_area: string;
    decoded_bitset: { bytes: Record<string, number> };
  }>(
    `with candidates as materialized (
       select e.ingestion_sequence, e.event_at, e.td_area, e.decoded_bitset
         from td_s_event e
        where e.td_area = any($1::text[])
          and e.event_at >= $2 and e.event_at < $3
          and e.decode_status = 'decoded'
          and e.decoded_bitset->'bytes' ?| $4::text[]
     )
     select c.ingestion_sequence::text as ingestion_sequence, c.event_at, c.td_area,
            c.decoded_bitset
       from candidates c
      where c.ingestion_sequence > $5
      order by c.ingestion_sequence
      limit $6`,
    [tdAreas, range.from, range.to, addresses, after, limit],
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
        and g.affected_sequence_start > $4
      order by g.affected_sequence_start
      limit $6`,
    [TD_RECEIVE_SILENCE_REASON, range.from, range.to, after, toleranceSeconds, limit],
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
  const silenceSequences = silences.rows.map((s) => BigInt(s.affected_sequence_start));
  let nextSilence = 0;

  const events: SequencedEvent[] = [];
  for (const row of rows.rows) {
    const sequence = Number(row.ingestion_sequence);
    const rowSequence = BigInt(row.ingestion_sequence);
    // A silence that began before this row blanked every input before it arrived.
    while (nextSilence < silenceSequences.length && silenceSequences[nextSilence]! < rowSequence) {
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
          binding.kind === "barrier"
            ? {
                type: "crossing.updated",
                sequence,
                eventAt: row.event_at.toISOString(),
                elementId: binding.elementId,
                state: barrierStateFromSignalState(resolved),
                tdArea: row.td_area,
                address,
                bit: binding.bit,
              }
            : {
                type: "signal.updated",
                sequence,
                eventAt: row.event_at.toISOString(),
                elementId: binding.elementId,
                state: resolved,
                tdArea: row.td_area,
                address,
                bit: binding.bit,
              },
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
    events.push({ sequence: rowSequence, order: 0, messages });

    // A silence sequenced at this row blanks after the row's own entries (order 1 below).
    while (nextSilence < silenceSequences.length && silenceSequences[nextSilence] === rowSequence) {
      resetInputs();
      nextSilence += 1;
    }
  }

  const blanks: SequencedEvent[] = [];
  for (const silence of silences.rows) {
    const sequence = Number(silence.affected_sequence_start);
    const eventAt = silence.blank_at.toISOString();
    blanks.push({
      sequence: BigInt(silence.affected_sequence_start),
      order: 1,
      messages: [
        ...bindings
          .filter((binding) => binding.kind !== "input")
          .map((binding): LiveDeltaMessage => ({
            type: binding.kind === "barrier" ? "crossing.updated" : "signal.updated",
            sequence,
            eventAt,
            elementId: binding.elementId,
            state: "blank",
            tdArea: binding.tdArea,
            address: binding.address,
            bit: binding.bit,
          })),
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
