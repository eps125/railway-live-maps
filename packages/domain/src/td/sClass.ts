/**
 * Pure S-Class decoding (docs/IMPLEMENTATION_PLAN.md Milestone 36a, docs/adr/0013).
 *
 * Wire format, verified against production data for M8/M9/R1-R4 and every S-Class area seen
 * nationwide (2026-09-19):
 * - `SF_MSG`: one byte (`data` = 2 hex chars) at the hex `address`.
 * - `SG_MSG`: four bytes (`data` = 8 hex chars) starting at `address`, first byte first — part of
 *   a periodic full-state refresh.
 * - `SH_MSG`: the final four-byte chunk of that refresh. It carries real data (not just a
 *   terminator), so it is decoded exactly like `SG_MSG`.
 * - Bits are numbered SOP-style: bit 0 = least significant bit of the byte, bit 7 = most.
 *
 * This module only states bit facts. What a bit *means* (which signal, and whether set means on
 * or off) comes solely from an explicit map binding — CLAUDE.md rules 9/10.
 */

/** Bump when decode semantics change; stored on `td_s_event.decode_version`. */
export const TD_S_DECODE_VERSION = 1;

/** `td_s_current_state` / `td_s_bit_transition` rows written by the decoder use this
 * `projection_version`. Deliberately distinct from `TD_PROJECTION_VERSION` (1): version-1
 * `td_s_current_state` rows predate decoding and were keyed on the *message* address, so an SG
 * refresh's four-byte word overwrote the one-byte SF value for the same address. Those rows are
 * left untouched (nothing reads them); a new version keeps the per-byte rows from colliding with
 * them without a destructive migration. */
export const TD_S_STATE_PROJECTION_VERSION = 2;

export type SClassMessageType = "SF" | "SG" | "SH";

/** How a decoded byte reached us: `update` = SF (a change), `refresh` = SG/SH (periodic full state). */
export type SClassSourceKind = "update" | "refresh";

export interface DecodedSByte {
  /** Canonical two-digit uppercase hex, e.g. `"0A"`. */
  address: string;
  /** 0-255. */
  value: number;
}

export type SClassDecodeErrorCode =
  | "unknown_message_type"
  | "invalid_address"
  | "invalid_data"
  | "data_length_mismatch"
  | "address_overflow";

export type SClassDecodeResult =
  | { ok: true; sourceKind: SClassSourceKind; bytes: DecodedSByte[] }
  | { ok: false; errorCode: SClassDecodeErrorCode };

const HEX_PATTERN = /^[0-9A-Fa-f]+$/;

/** Accepts the event type as stored (`SF_MSG`) or bare (`SF`). */
export function sClassMessageType(eventType: string): SClassMessageType | null {
  const bare = eventType.endsWith("_MSG") ? eventType.slice(0, -4) : eventType;
  return bare === "SF" || bare === "SG" || bare === "SH" ? bare : null;
}

export function formatSAddress(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

/**
 * Decodes one S-Class payload into the bytes it states. Never repairs input: anything not
 * matching the verified format is reported as an error code for the caller to record
 * (CLAUDE.md: retain unsupported/malformed data with its outcome, never silently discard).
 */
export function decodeSClassPayload(
  eventType: string,
  address: unknown,
  data: unknown,
): SClassDecodeResult {
  const messageType = sClassMessageType(eventType);
  if (messageType === null) return { ok: false, errorCode: "unknown_message_type" };
  if (typeof address !== "string" || address.length !== 2 || !HEX_PATTERN.test(address)) {
    return { ok: false, errorCode: "invalid_address" };
  }
  if (typeof data !== "string" || !HEX_PATTERN.test(data)) {
    return { ok: false, errorCode: "invalid_data" };
  }
  const byteCount = messageType === "SF" ? 1 : 4;
  if (data.length !== byteCount * 2) return { ok: false, errorCode: "data_length_mismatch" };

  const start = Number.parseInt(address, 16);
  if (start + byteCount - 1 > 0xff) return { ok: false, errorCode: "address_overflow" };

  const bytes: DecodedSByte[] = [];
  for (let i = 0; i < byteCount; i += 1) {
    bytes.push({
      address: formatSAddress(start + i),
      value: Number.parseInt(data.slice(i * 2, i * 2 + 2), 16),
    });
  }
  return { ok: true, sourceKind: messageType === "SF" ? "update" : "refresh", bytes };
}

/** Bit `bitIndex` (0 = LSB) of a byte value. */
export function sBit(value: number, bitIndex: number): boolean {
  return ((value >> bitIndex) & 1) === 1;
}

/** Bits 0..7 of a byte value, index = bit number. */
export function sBits(value: number): boolean[] {
  return Array.from({ length: 8 }, (_, bit) => sBit(value, bit));
}

/** Current known value of one byte, as the fold sees it. */
export interface SByteState {
  value: number;
  sourceIngestionSequence: string;
}

/** One decoded S-Class event, in `ingestion_sequence` order, ready to fold. */
export interface SClassFoldEvent {
  tdArea: string;
  sourceKind: SClassSourceKind;
  bytes: DecodedSByte[];
  eventId: string;
  eventNormalizedAt: Date;
  ingestionSequence: string;
}

export interface SBitTransition {
  tdArea: string;
  address: string;
  bitIndex: number;
  /** null = the byte had no known value before (first observation). */
  previousValue: boolean | null;
  newValue: boolean;
  sourceKind: SClassSourceKind;
  eventId: string;
  eventNormalizedAt: Date;
  ingestionSequence: string;
}

export interface SByteWrite {
  tdArea: string;
  address: string;
  value: number;
  sourceKind: SClassSourceKind;
  eventId: string;
  eventNormalizedAt: Date;
  ingestionSequence: string;
  /** Set when this byte was last stated by a refresh within the folded events. */
  lastRefreshAt: Date | null;
}

export interface SClassFoldResult {
  /** Final state per byte touched, one entry per (tdArea, address). */
  byteWrites: SByteWrite[];
  /** Every bit change, in event order. */
  transitions: SBitTransition[];
  /** Refreshes that disagreed with the byte's known value — evidence of a missed SF. */
  refreshMismatches: number;
}

export function sByteKey(tdArea: string, address: string): string {
  return `${tdArea}|${address}`;
}

/**
 * Pure: folds decoded events (already in `ingestion_sequence` order) over the prior known byte
 * values. A byte seen for the first time yields a transition for all 8 bits with
 * `previousValue: null` — so point-in-time bit state is always "the latest transition at or before
 * T". After that only bits that actually change yield a transition; a refresh that changes
 * anything is also counted as a mismatch. Events with an `ingestionSequence` not newer than the
 * byte's known state are ignored for that byte (replay safety).
 */
export function foldSClassEvents(
  prior: ReadonlyMap<string, SByteState>,
  events: readonly SClassFoldEvent[],
): SClassFoldResult {
  const state = new Map<string, SByteState>(prior);
  const writes = new Map<string, SByteWrite>();
  const transitions: SBitTransition[] = [];
  let refreshMismatches = 0;

  for (const event of events) {
    let mismatched = false;
    for (const byte of event.bytes) {
      const key = sByteKey(event.tdArea, byte.address);
      const known = state.get(key);
      if (known && BigInt(known.sourceIngestionSequence) >= BigInt(event.ingestionSequence)) {
        continue;
      }

      for (let bit = 0; bit < 8; bit += 1) {
        const newValue = sBit(byte.value, bit);
        const previousValue = known ? sBit(known.value, bit) : null;
        if (previousValue === newValue) continue;
        if (known) mismatched = true;
        transitions.push({
          tdArea: event.tdArea,
          address: byte.address,
          bitIndex: bit,
          previousValue,
          newValue,
          sourceKind: event.sourceKind,
          eventId: event.eventId,
          eventNormalizedAt: event.eventNormalizedAt,
          ingestionSequence: event.ingestionSequence,
        });
      }

      state.set(key, { value: byte.value, sourceIngestionSequence: event.ingestionSequence });
      const previousWrite = writes.get(key);
      writes.set(key, {
        tdArea: event.tdArea,
        address: byte.address,
        value: byte.value,
        sourceKind: event.sourceKind,
        eventId: event.eventId,
        eventNormalizedAt: event.eventNormalizedAt,
        ingestionSequence: event.ingestionSequence,
        lastRefreshAt:
          event.sourceKind === "refresh"
            ? event.eventNormalizedAt
            : (previousWrite?.lastRefreshAt ?? null),
      });
    }
    if (mismatched && event.sourceKind === "refresh") refreshMismatches += 1;
  }

  return { byteWrites: [...writes.values()], transitions, refreshMismatches };
}
