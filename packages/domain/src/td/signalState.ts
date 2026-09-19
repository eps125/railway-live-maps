import { decodeSClassPayload, sBit, sByteKey } from "./sClass.js";

/**
 * Pure signal-state rules (docs/IMPLEMENTATION_PLAN.md Milestone 36b, docs/adr/0013). Shared by
 * the live publishers, the API's live/historical state, snapshots and playback, so every consumer
 * derives the same state from the same facts (CLAUDE.md rule 13).
 *
 * A signal's state is only ever its bound bit (rule 10). Public states are `blank` | `on` |
 * `off` (rule 9, PROJECT_SPEC §6): `unmapped` and `unknown` both render blank.
 */

export type SignalDisplayState = "blank" | "on" | "off";

/** ADR 0013 decision 2: last-known byte state is trusted across a TD feed silence of up to this
 * long; beyond it, a byte is unknown until re-confirmed by an SF covering it or a refresh. */
export const SIGNAL_GAP_TOLERANCE_MS = 5 * 60_000;

/** `feed_gap.detection_reason` for a silence found in TD receive times. */
export const TD_RECEIVE_SILENCE_REASON = "td_receive_silence";

/** Bound bit → public state. `activeMeans` is the binding's statement of what a set bit means;
 * a missing one (e.g. a bundle compiled before it was recorded) is `blank`, never guessed. */
export function signalStateForBit(
  byteValue: number,
  bit: number,
  activeMeans: "on" | "off" | undefined,
): SignalDisplayState {
  if (activeMeans === undefined) return "blank";
  const set = sBit(byteValue, bit);
  if (activeMeans === "on") return set ? "on" : "off";
  return set ? "off" : "on";
}

export interface ReceiveSilence {
  /** Receive time of the last TD event before the silence. */
  startAt: Date;
  /** Receive time of the first TD event after it. */
  endAt: Date;
  startSequence: string;
  endSequence: string;
}

export interface ReceivedRow {
  receivedAt: Date;
  ingestionSequence: string;
}

/**
 * Pure: silences longer than `toleranceMs` between consecutive TD rows (in ingestion order), by
 * the time they were *received* — a recorder/broker outage shows up here whatever caused it,
 * which the session table cannot be relied on for (`last_frame_at` is never written and a killed
 * process never records `disconnected_at`). `previous` is the last row before `rows`, if known.
 */
export function detectReceiveSilences(
  previous: ReceivedRow | null,
  rows: readonly ReceivedRow[],
  toleranceMs = SIGNAL_GAP_TOLERANCE_MS,
): ReceiveSilence[] {
  const silences: ReceiveSilence[] = [];
  let last = previous;
  for (const row of rows) {
    if (last && row.receivedAt.getTime() - last.receivedAt.getTime() > toleranceMs) {
      silences.push({
        startAt: last.receivedAt,
        endAt: row.receivedAt,
        startSequence: last.ingestionSequence,
        endSequence: row.ingestionSequence,
      });
    }
    last = row;
  }
  return silences;
}

/** Where a silence began: the receive time and ingestion sequence of the last TD row before it. */
export interface SilenceStart {
  at: Date;
  sequence: string;
}

/**
 * Pure: is a byte last confirmed by the event at `confirmedSequence` still trustworthy at `at`?
 * Not once any silence that began at or after that confirmation (compared by ingestion sequence —
 * exact, unlike comparing a source timestamp with a receive time) has lasted longer than the
 * tolerance by `at`, i.e. `silence.at + tolerance < at`. A silence that ended before the
 * confirmation doesn't matter: the byte was re-confirmed after it. `silences` should include an
 * ongoing one (live: the last received row) as well as recorded `feed_gap` rows.
 */
export function sByteTrustedAt(
  confirmedSequence: string,
  silences: readonly SilenceStart[],
  at: Date,
  toleranceMs = SIGNAL_GAP_TOLERANCE_MS,
): boolean {
  const confirmed = BigInt(confirmedSequence);
  for (const silence of silences) {
    if (
      BigInt(silence.sequence) >= confirmed &&
      silence.at.getTime() + toleranceMs < at.getTime()
    ) {
      return false;
    }
  }
  return true;
}

/** How far back a point-in-time lookup searches for a byte's last confirming event. Every
 * S-Class area observed refreshes roughly every 2 hours, so a live byte is always re-stated well
 * within this; a byte with nothing in the window is unknown. */
export const SIGNAL_STATE_LOOKBACK_MS = 6 * 60 * 60_000;

/** One `tdSBit` binding, with its address already canonical (`canonicalSAddress`). */
export interface SignalBinding {
  elementId: string;
  tdArea: string;
  address: string;
  bit: number;
  /** Absent for a binding compiled before it was recorded — renders blank. */
  activeMeans?: "on" | "off";
}

/** A compiled bundle's `sBitBindingIndex` (+ `sBitBindingActiveMeans`) as a binding list. */
export function signalBindingsFromIndex(
  index: Record<string, string>,
  activeMeans: Record<string, "on" | "off"> | undefined,
): SignalBinding[] {
  const bindings: SignalBinding[] = [];
  for (const [key, elementId] of Object.entries(index)) {
    const [tdArea, address, bit] = key.split("|");
    if (!tdArea || !address || bit === undefined) continue;
    const means = activeMeans?.[key];
    bindings.push({
      elementId,
      tdArea,
      address,
      bit: Number(bit),
      ...(means ? { activeMeans: means } : {}),
    });
  }
  return bindings;
}

/** A byte's last known value and the ingestion sequence of the event that stated it. */
export interface SByteFact {
  value: number;
  confirmedSequence: string;
}

/** An undecoded S-Class row newer than the stored facts (live: rows past the history projector's
 * checkpoint), in ingestion order. */
export interface RawSClassOverlayRow {
  tdArea: string;
  eventType: string;
  address: unknown;
  data: unknown;
  ingestionSequence: string;
}

export interface ResolveSignalStatesInput {
  /** Every signal element on the map — unbound ones resolve to blank (`unmapped`). */
  signalElementIds: readonly string[];
  bindings: readonly SignalBinding[];
  /** `sByteKey(tdArea, address)` → last stored fact at or before `at`. */
  byteFacts: ReadonlyMap<string, SByteFact>;
  overlayRows?: readonly RawSClassOverlayRow[];
  /** Recorded silences plus (live) an ongoing one. */
  silences: readonly SilenceStart[];
  at: Date;
}

/**
 * Pure: every signal element's public state at `at`. `unmapped` (no binding), `unknown` (no
 * fact, or one not trusted per `sByteTrustedAt`) and a binding without `activeMeans` all render
 * `blank`; otherwise the bound bit decides on/off. Nothing but the bound bit ever decides it.
 */
export function resolveSignalStates(
  input: ResolveSignalStatesInput,
): Record<string, { state: SignalDisplayState }> {
  const facts = new Map(input.byteFacts);
  for (const row of input.overlayRows ?? []) {
    const decoded = decodeSClassPayload(row.eventType, row.address, row.data);
    if (!decoded.ok) continue;
    for (const byte of decoded.bytes) {
      facts.set(sByteKey(row.tdArea, byte.address), {
        value: byte.value,
        confirmedSequence: row.ingestionSequence,
      });
    }
  }

  const signals: Record<string, { state: SignalDisplayState }> = {};
  for (const elementId of input.signalElementIds) signals[elementId] = { state: "blank" };
  for (const binding of input.bindings) {
    const fact = facts.get(sByteKey(binding.tdArea, binding.address));
    signals[binding.elementId] = {
      state:
        fact !== undefined && sByteTrustedAt(fact.confirmedSequence, input.silences, input.at)
          ? signalStateForBit(fact.value, binding.bit, binding.activeMeans)
          : "blank",
    };
  }
  return signals;
}

/** The facts `computeSignalStates` needs, supplied by `@railway/database`'s queries (kept behind
 * this port so the steps below are written once and shared by the API and the worker). */
export interface SignalFactsPort {
  byteFactsAt(
    bytes: ReadonlyArray<{ tdArea: string; address: string }>,
    at: Date,
    lookbackMs: number,
  ): Promise<ReadonlyMap<string, SByteFact>>;
  recordedSilences(at: Date, lookbackMs: number): Promise<SilenceStart[]>;
  lastReceived(): Promise<SilenceStart | null>;
  /** Live only: rows newer than the stored facts. */
  liveOverlay(tdAreas: readonly string[]): Promise<{
    rows: RawSClassOverlayRow[];
    truncated: boolean;
  }>;
}

/**
 * Every signal element's state at `at` — the one sequence of steps used by live state (`live`),
 * `/state?at=` and `snapshot-maps`, so they can never disagree (CLAUDE.md rule 13). The newest
 * received TD row is always treated as a potential silence start: it only matters once `at` is
 * more than the tolerance past it (a feed that has gone quiet right now).
 */
export async function computeSignalStates(
  port: SignalFactsPort,
  input: {
    signalElementIds: readonly string[];
    bindings: readonly SignalBinding[];
    at: Date;
    live: boolean;
  },
): Promise<Record<string, { state: SignalDisplayState }>> {
  const blank = (): Record<string, { state: SignalDisplayState }> =>
    Object.fromEntries(input.signalElementIds.map((id) => [id, { state: "blank" as const }]));
  if (input.bindings.length === 0) return blank();

  const tdAreas = [...new Set(input.bindings.map((b) => b.tdArea))];
  const [byteFacts, recorded, last, overlay] = await Promise.all([
    port.byteFactsAt(input.bindings, input.at, SIGNAL_STATE_LOOKBACK_MS),
    port.recordedSilences(input.at, SIGNAL_STATE_LOOKBACK_MS),
    port.lastReceived(),
    input.live ? port.liveOverlay(tdAreas) : Promise.resolve({ rows: [], truncated: false }),
  ]);
  // Live, with the history projector too far behind to overlay: nothing can be trusted.
  if (overlay.truncated) return blank();

  return resolveSignalStates({
    signalElementIds: input.signalElementIds,
    bindings: input.bindings,
    byteFacts,
    overlayRows: overlay.rows,
    silences: last ? [...recorded, last] : recorded,
    at: input.at,
  });
}
