import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  getOrCreateProjectionDefinition,
  ensureCheckpoint,
  getCheckpoint,
  advanceCheckpoint,
  resetCheckpoint,
} from "@railway/database";
import {
  applyCA,
  applyCB,
  applyCC,
  decodeSClassPayload,
  foldSClassEvents,
  sBits,
  sByteKey,
  TD_NORMALIZATION_VERSION,
  TD_PROJECTION_NAME,
  TD_PROJECTION_VERSION,
  TD_S_DECODE_VERSION,
  TD_S_STATE_PROJECTION_VERSION,
  TD_RECEIVE_SILENCE_REASON,
  detectReceiveSilences,
  type OpenOccupancySnapshot,
  type ReceivedRow,
  type BerthEffect,
  type SByteState,
  type SClassDecodeResult,
  type SClassFoldEvent,
  type SClassFoldResult,
} from "@railway/domain";
import { advisoryLockKey } from "../shared/advisoryLock.js";

export { TD_PROJECTION_NAME, TD_PROJECTION_VERSION, advisoryLockKey };

const DEFAULT_BATCH_SIZE = 500;

export interface ProjectTdOptions {
  batchSize?: number;
  /** Clears this projection version's output (including the td_berth_event/td_heartbeat/
   * td_s_event normalized mirrors, which aren't independently versioned) and reprocesses from
   * ingestion_sequence 0. */
  rebuild?: boolean;
  /** Stop after this many batches even if more events are waiting, so a caller that also has
   * other work to do each cycle (project-td-daemon runs `runProjectMapDeltas` right after this)
   * isn't blocked for minutes draining a large backlog in one call. Unset = drain fully. */
  maxBatches?: number;
}

export interface ProjectTdSummary {
  batches: number;
  processedEvents: number;
  projectedBerthEvents: number;
  heartbeats: number;
  sEvents: number;
  /** S-Class events the decoder rejected (recorded on `td_s_event` as 'unsupported'). */
  sDecodeFailures: number;
  sBitTransitions: number;
  /** SG/SH refreshes that disagreed with the known byte value — evidence of a missed SF. */
  sRefreshMismatches: number;
  /** TD receive silences longer than the signal-trust tolerance, recorded as `feed_gap` rows. */
  feedSilences: number;
  anomalies: number;
  /** True when this invocation did nothing because another runProjectTd was already in
   * progress (see the advisory lock note on runProjectTd below) — not an error, just "try
   * again next tick." */
  skippedLockContention: boolean;
}

const EMPTY_SUMMARY: ProjectTdSummary = {
  batches: 0,
  processedEvents: 0,
  projectedBerthEvents: 0,
  heartbeats: 0,
  sEvents: 0,
  sDecodeFailures: 0,
  sBitTransitions: 0,
  sRefreshMismatches: 0,
  feedSilences: 0,
  anomalies: 0,
  skippedLockContention: false,
};

interface RawTdRow {
  id: string;
  normalized_event_at_utc: Date;
  ingestion_sequence: string;
  event_type: string;
  message_class: "C" | "S" | null;
  td_area: string;
  raw_event_json: Record<string, unknown>;
  parse_status: string;
  received_at_utc: Date;
}

/** A CA/CB/CC row with its `*_MSG` payload already unwrapped — built once per row while
 * categorizing a batch (see `runProjectTd`), reused by both the bulk `td_berth_event` insert and
 * the in-memory occupancy fold in `processCClassBatch`. */
interface ParsedCClassRow {
  row: RawTdRow;
  description: string;
  fromBerth?: string;
  toBerth?: string;
}

/** An S-Class row with its payload unwrapped and decoded (Milestone 36a). `address`/`rawValue`
 * are the source values `td_s_event` stores untouched; `decoded` is the per-byte decode (or the
 * reason it was rejected). */
interface ParsedSClassRow {
  row: RawTdRow;
  address: string | null;
  rawValue: string | null;
  decoded: SClassDecodeResult;
}

function computeConfigHash(): string {
  return createHash("sha256")
    .update(`td-projection-v${TD_PROJECTION_VERSION}-norm-v${TD_NORMALIZATION_VERSION}`)
    .digest("hex");
}

async function clearProjectionRows(pool: Pool, projectionVersion: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Child-before-parent for the FKs into berth_occupancy: berth_current_state is pure derived
    // state, safe to delete outright; operator_berth_action (the manual berth-clear audit trail)
    // is a permanent record that must survive a rebuild, so its now-dangling occupancy reference
    // is nulled out instead of the row being deleted — without handling this first, the delete
    // below fails with a foreign key violation the instant any occupancy has ever been manually
    // cleared. (The berth-run resolver's `berth_run_resolution` FK was removed with the resolver
    // itself — ADR 0002, migrations 0022/0025.)
    await client.query("delete from td_projection_anomaly where projection_version = $1", [
      projectionVersion,
    ]);
    await client.query("delete from berth_current_state where projection_version = $1", [
      projectionVersion,
    ]);
    await client.query(
      `update operator_berth_action set closed_occupancy_id = null, closed_occupancy_entered_at = null
       where closed_occupancy_id in (select id from berth_occupancy where projection_version = $1)`,
      [projectionVersion],
    );
    await client.query("delete from berth_occupancy where projection_version = $1", [
      projectionVersion,
    ]);
    await client.query("delete from td_s_current_state where projection_version = $1", [
      projectionVersion,
    ]);
    await client.query("delete from td_s_bit_transition where projection_version = $1", [
      projectionVersion,
    ]);
    // Decoded S-Class state/transitions (Milestone 36a) carry their own projection_version but
    // are derived from the same td_s_event stream this rebuild replays from zero — they must be
    // cleared with it, or the fold's "previous value" would be read from end-of-history state
    // while replaying the start, producing spurious transitions.
    await client.query("delete from td_s_current_state where projection_version = $1", [
      TD_S_STATE_PROJECTION_VERSION,
    ]);
    await client.query("delete from td_s_bit_transition where projection_version = $1", [
      TD_S_STATE_PROJECTION_VERSION,
    ]);
    // These three are plain 1:1 normalized mirrors of raw_feed_event with no projection_version
    // column of their own — they're cheap to regenerate and must be cleared too, otherwise their
    // (raw_event_id, event_at) idempotency guard would make every row look "already projected"
    // and rebuild would silently do nothing.
    await client.query("delete from td_berth_event");
    await client.query("delete from td_heartbeat");
    await client.query("delete from td_s_event");
    // Reset the fast `project-td-live` projector's checkpoint (ADR 0003) so it re-seeds
    // `berth_current_state` from the rebuilt `berth_occupancy` and re-tails, rather than sitting
    // on a checkpoint pointing past rows this rebuild just deleted.
    await client.query(
      `delete from projection_checkpoint
       where projection_definition_id in (
         select id from projection_definition where name = 'td-live-berth-state'
       )`,
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function unwrapPayload(row: RawTdRow, wrapperKey: string): Record<string, unknown> | undefined {
  const value = row.raw_event_json[wrapperKey];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** One multi-row `insert ... on conflict do nothing` instead of one round-trip per row — heartbeats
 * have no downstream effects, so there's nothing to fold, just idempotency to preserve. */
async function insertHeartbeatsBulk(client: PoolClient, rows: RawTdRow[]): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `insert into td_heartbeat (raw_event_id, raw_event_normalized_at_utc, td_area, report_time, event_at, received_at)
     select t.raw_event_id, t.normalized_at, t.td_area, t.normalized_at, t.normalized_at, now()
     from unnest($1::bigint[], $2::timestamptz[], $3::text[]) as t(raw_event_id, normalized_at, td_area)
     on conflict (raw_event_id) do nothing`,
    [rows.map((r) => r.id), rows.map((r) => r.normalized_event_at_utc), rows.map((r) => r.td_area)],
  );
}

/** Bulk `insert ... on conflict (raw_event_id, event_at) do nothing returning raw_event_id`. The
 * returned set is exactly the rows newly projected this call — the same idempotency guard the old
 * per-row insert used ("no returned row = already projected, skip effects"), just resolved for a
 * whole batch in one round trip instead of one insert per row. */
async function insertBerthEventsBulk(
  client: PoolClient,
  rows: ParsedCClassRow[],
): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const result = await client.query<{ raw_event_id: string }>(
    `insert into td_berth_event (
       raw_event_id, raw_event_normalized_at_utc, td_area, message_type, from_berth, to_berth,
       description, event_at, ingestion_sequence, normalization_version
     )
     select t.raw_event_id, t.normalized_at, t.td_area, t.message_type, t.from_berth, t.to_berth,
            t.description, t.normalized_at, t.ingestion_sequence, $9
     from unnest(
       $1::bigint[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[],
       $7::text[], $8::bigint[]
     ) as t(raw_event_id, normalized_at, td_area, message_type, from_berth, to_berth, description, ingestion_sequence)
     on conflict (raw_event_id, event_at) do nothing
     returning raw_event_id`,
    [
      rows.map((r) => r.row.id),
      rows.map((r) => r.row.normalized_event_at_utc),
      rows.map((r) => r.row.td_area),
      rows.map((r) => r.row.event_type),
      rows.map((r) => r.fromBerth ?? null),
      rows.map((r) => r.toBerth ?? null),
      rows.map((r) => r.description),
      rows.map((r) => r.row.ingestion_sequence),
      TD_NORMALIZATION_VERSION,
    ],
  );
  return new Set(result.rows.map((r) => r.raw_event_id));
}

/** Same idempotency pattern as `insertBerthEventsBulk`, for S-Class. */
async function insertSEventsBulk(
  client: PoolClient,
  rows: ParsedSClassRow[],
): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const result = await client.query<{ raw_event_id: string }>(
    `insert into td_s_event (
       raw_event_id, raw_event_normalized_at_utc, td_area, message_type, address, raw_value,
       decoded_bitset, event_at, ingestion_sequence, normalization_version, decode_status,
       decode_version, decode_error_code
     )
     select t.raw_event_id, t.normalized_at, t.td_area, t.message_type, t.address, t.raw_value,
            t.decoded_bitset, t.normalized_at, t.ingestion_sequence, $11, t.decode_status,
            $12, t.decode_error_code
     from unnest(
       $1::bigint[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $7::bigint[],
       $8::jsonb[], $9::text[], $10::text[]
     ) as t(raw_event_id, normalized_at, td_area, message_type, address, raw_value, ingestion_sequence,
            decoded_bitset, decode_status, decode_error_code)
     on conflict (raw_event_id, event_at) do nothing
     returning raw_event_id`,
    [
      rows.map((r) => r.row.id),
      rows.map((r) => r.row.normalized_event_at_utc),
      rows.map((r) => r.row.td_area),
      rows.map((r) => r.row.event_type),
      rows.map((r) => r.address),
      rows.map((r) => r.rawValue),
      rows.map((r) => r.row.ingestion_sequence),
      rows.map((r) =>
        r.decoded.ok
          ? JSON.stringify({
              bytes: Object.fromEntries(r.decoded.bytes.map((b) => [b.address, b.value])),
            })
          : null,
      ),
      rows.map((r) => (r.decoded.ok ? "decoded" : "unsupported")),
      rows.map((r) => (r.decoded.ok ? null : r.decoded.errorCode)),
      TD_NORMALIZATION_VERSION,
      TD_S_DECODE_VERSION,
    ],
  );
  return new Set(result.rows.map((r) => r.raw_event_id));
}

/** The decoder's current known value (`TD_S_STATE_PROJECTION_VERSION`) for every byte a batch's
 * decoded events touch — one PK-indexed round trip, the "previous value" side of the fold. */
async function loadSByteState(
  client: PoolClient,
  events: SClassFoldEvent[],
): Promise<Map<string, SByteState>> {
  const keys = new Map<string, { tdArea: string; address: string }>();
  for (const event of events) {
    for (const byte of event.bytes) {
      keys.set(sByteKey(event.tdArea, byte.address), {
        tdArea: event.tdArea,
        address: byte.address,
      });
    }
  }
  const state = new Map<string, SByteState>();
  if (keys.size === 0) return state;
  const wanted = [...keys.values()];
  const result = await client.query<{
    td_area: string;
    address: string;
    byte_value: number;
    source_ingestion_sequence: string;
  }>(
    `select s.td_area, s.address, s.byte_value, s.source_ingestion_sequence
     from td_s_current_state s
     join unnest($2::text[], $3::text[]) as k(td_area, address)
       on s.td_area = k.td_area and s.address = k.address
     where s.projection_version = $1 and s.byte_value is not null`,
    [TD_S_STATE_PROJECTION_VERSION, wanted.map((k) => k.tdArea), wanted.map((k) => k.address)],
  );
  for (const row of result.rows) {
    state.set(sByteKey(row.td_area, row.address), {
      value: row.byte_value,
      sourceIngestionSequence: row.source_ingestion_sequence,
    });
  }
  return state;
}

/** Bulk insert of one batch's bit transitions; `on conflict do nothing` against
 * `td_s_bit_transition_source_uk` makes a replayed event a no-op. */
export async function insertSBitTransitionsBulk(
  client: PoolClient,
  fold: SClassFoldResult,
): Promise<number> {
  const rows = fold.transitions;
  if (rows.length === 0) return 0;
  const result = await client.query(
    `insert into td_s_bit_transition (
       projection_version, td_area, address, bit_index, previous_value, new_value, event_at,
       source_event_id, source_event_normalized_at_utc, source_kind, source_ingestion_sequence
     )
     select $1, t.td_area, t.address, t.bit_index, t.previous_value, t.new_value, t.normalized_at,
            t.source_event_id, t.normalized_at, t.source_kind, t.ingestion_sequence
     from unnest(
       $2::text[], $3::text[], $4::int[], $5::boolean[], $6::boolean[], $7::timestamptz[],
       $8::bigint[], $9::text[], $10::bigint[]
     ) as t(td_area, address, bit_index, previous_value, new_value, normalized_at, source_event_id,
            source_kind, ingestion_sequence)
     on conflict (projection_version, source_event_id, address, bit_index, event_at) do nothing`,
    [
      TD_S_STATE_PROJECTION_VERSION,
      rows.map((r) => r.tdArea),
      rows.map((r) => r.address),
      rows.map((r) => r.bitIndex),
      rows.map((r) => r.previousValue),
      rows.map((r) => r.newValue),
      rows.map((r) => r.eventNormalizedAt),
      rows.map((r) => r.eventId),
      rows.map((r) => r.sourceKind),
      rows.map((r) => r.ingestionSequence),
    ],
  );
  return result.rowCount ?? 0;
}

/** Per-byte current state upsert — one row per (td_area, address) already guaranteed by the fold,
 * so a single statement never targets the same conflict key twice. The monotonic
 * `source_ingestion_sequence` guard (same pattern as `berth_current_state`, ADR 0003) keeps an
 * older event from ever overwriting a newer one, should a second writer be added (36b). */
async function upsertSByteStateBulk(client: PoolClient, fold: SClassFoldResult): Promise<void> {
  const rows = fold.byteWrites;
  if (rows.length === 0) return;
  await client.query(
    `insert into td_s_current_state as s (
       projection_version, td_area, address, raw_value, byte_value, decoded_bitset, event_at,
       source_event_id, source_event_normalized_at_utc, source_ingestion_sequence, decode_status,
       data_quality_state, source_kind, last_refresh_at
     )
     select $1, t.td_area, t.address, t.raw_value, t.byte_value, t.decoded_bitset, t.normalized_at,
            t.source_event_id, t.normalized_at, t.ingestion_sequence, 'decoded', 'ok', t.source_kind,
            t.last_refresh_at
     from unnest(
       $2::text[], $3::text[], $4::text[], $5::smallint[], $6::jsonb[], $7::timestamptz[],
       $8::bigint[], $9::bigint[], $10::text[], $11::timestamptz[]
     ) as t(td_area, address, raw_value, byte_value, decoded_bitset, normalized_at, source_event_id,
            ingestion_sequence, source_kind, last_refresh_at)
     on conflict (projection_version, td_area, address) do update
     set raw_value = excluded.raw_value, byte_value = excluded.byte_value,
         decoded_bitset = excluded.decoded_bitset, event_at = excluded.event_at,
         source_event_id = excluded.source_event_id,
         source_event_normalized_at_utc = excluded.source_event_normalized_at_utc,
         source_ingestion_sequence = excluded.source_ingestion_sequence,
         decode_status = excluded.decode_status, data_quality_state = excluded.data_quality_state,
         source_kind = excluded.source_kind,
         last_refresh_at = coalesce(excluded.last_refresh_at, s.last_refresh_at),
         updated_at = now()
     where excluded.source_ingestion_sequence >= s.source_ingestion_sequence`,
    [
      TD_S_STATE_PROJECTION_VERSION,
      rows.map((r) => r.tdArea),
      rows.map((r) => r.address),
      rows.map((r) => r.value.toString(16).toUpperCase().padStart(2, "0")),
      rows.map((r) => r.value),
      rows.map((r) => JSON.stringify(sBits(r.value))),
      rows.map((r) => r.eventNormalizedAt),
      rows.map((r) => r.eventId),
      rows.map((r) => r.ingestionSequence),
      rows.map((r) => r.sourceKind),
      rows.map((r) => r.lastRefreshAt),
    ],
  );
}

/**
 * Milestone 36b (docs/adr/0013): records every TD receive silence longer than the signal-trust
 * tolerance within this batch as a `feed_gap` row (`td_receive_silence`) — the recorded gaps the
 * signal trust rule, `/state?at=` and playback read, and which the existing feed-gap banner
 * surfaces. Compared against the previous batch's last row too (looked up by checkpoint sequence
 * when this run hasn't seen one yet), so a silence spanning a batch boundary is still caught.
 * Idempotent: `feed_gap_td_receive_silence_uk` makes a re-projected silence a no-op.
 */
async function recordReceiveSilences(
  client: PoolClient,
  lastSequence: string,
  rows: RawTdRow[],
  previousInRun: ReceivedRow | null,
): Promise<number> {
  let previous = previousInRun;
  if (!previous && lastSequence !== "0") {
    const result = await client.query<{ received_at_utc: Date }>(
      `select received_at_utc from raw_feed_event
       where feed_name = 'TD' and ingestion_sequence = $1
       limit 1`,
      [lastSequence],
    );
    const row = result.rows[0];
    previous = row ? { receivedAt: row.received_at_utc, ingestionSequence: lastSequence } : null;
  }
  const silences = detectReceiveSilences(
    previous,
    rows.map((r) => ({ receivedAt: r.received_at_utc, ingestionSequence: r.ingestion_sequence })),
  );
  let recorded = 0;
  for (const silence of silences) {
    const result = await client.query(
      `insert into feed_gap (
         feed_name, td_area, detected_start, detected_end, detection_reason, recoverability,
         affected_sequence_start, affected_sequence_end, affected_time_start, affected_time_end
       ) values ('TD', null, $1, $2, $3, 'unknown', $4, $5, $1, $2)
       on conflict (feed_name, affected_sequence_start)
         where detection_reason = 'td_receive_silence' do nothing`,
      [
        silence.startAt,
        silence.endAt,
        TD_RECEIVE_SILENCE_REASON,
        silence.startSequence,
        silence.endSequence,
      ],
    );
    recorded += result.rowCount ?? 0;
  }
  return recorded;
}

/** Bulk-reads the currently-open `berth_occupancy` row (if any) for every distinct (td_area,
 * berth) pair a batch's newly-projected C-Class rows touch — one round trip instead of up to two
 * `select`s per row. Reads `berth_occupancy` directly, NOT `berth_current_state.occupancy_id`:
 * since ADR 0003 (Tier 3) `berth_current_state` is written by `ingest-td` inline / `projector-td-live`
 * with `occupancy_id = NULL`, so this projector must resolve "what's open" from `berth_occupancy`
 * itself (2026-09-03 regression, see `repairOpenOccupancies.ts`). */
async function bulkGetOpenOccupancy(
  client: PoolClient,
  projectionVersion: number,
  pairs: { tdArea: string; berth: string }[],
): Promise<Map<string, OpenOccupancySnapshot>> {
  const map = new Map<string, OpenOccupancySnapshot>();
  if (pairs.length === 0) return map;
  const { rows } = await client.query<{
    id: string;
    td_area: string;
    berth_code: string;
    entered_at: Date;
    description: string;
  }>(
    `select distinct on (bo.td_area, bo.berth_code) bo.id, bo.td_area, bo.berth_code, bo.entered_at, bo.description
     from berth_occupancy bo
     join unnest($2::text[], $3::text[]) as w(td_area, berth_code)
       on bo.td_area = w.td_area and bo.berth_code = w.berth_code
     where bo.projection_version = $1 and bo.left_at is null
     order by bo.td_area, bo.berth_code, bo.entered_at desc`,
    [projectionVersion, pairs.map((p) => p.tdArea), pairs.map((p) => p.berth)],
  );
  for (const row of rows) {
    map.set(`${row.td_area}|${row.berth_code}`, {
      occupancyId: row.id,
      description: row.description,
      enteredAt: row.entered_at.toISOString(),
    });
  }
  return map;
}

/**
 * Folds a batch's newly-projected CA/CB/CC rows (already in ingestion order) against the pure
 * `applyCA`/`applyCB`/`applyCC` reducers, then applies the resulting effects with (at most) three
 * bulk statements instead of up to a few per-row round trips each — this is the part of
 * `runProjectTd` that used to dominate a catch-up batch's wall-clock time (per-row `select`s to
 * find the open occupancy, then per-effect `insert`/`update`, all serialized on one connection).
 *
 * Correctness hinges on two things, both preserved exactly:
 *  1. Rows are folded strictly in ingestion order against an in-memory map of "currently open
 *     occupancy per berth", seeded from one bulk read (`bulkGetOpenOccupancy`) and mutated as each
 *     row's effects are computed — so a later row in the same batch sees an earlier row's
 *     open/close exactly as if it had re-read the database, without an actual round trip.
 *  2. Opens are written to `berth_occupancy` before closes: a berth opened and then closed again
 *     within the same batch needs its close's `update ... where id = $1` to find a row that only
 *     exists because the open's `insert` ran first, in the same transaction (ordinary read-your-
 *     writes visibility — no merging of the two required).
 * `berth_occupancy_id_seq` values for the batch's opens are reserved up front (one `nextval` call
 * via `generate_series`, at most one id per row — CB never opens) so a same-batch close can
 * reference an id before that row is actually inserted.
 */
async function processCClassBatch(
  client: PoolClient,
  projectionVersion: number,
  rows: ParsedCClassRow[],
): Promise<{ anomalies: number }> {
  if (rows.length === 0) return { anomalies: 0 };

  const pairKeys = new Set<string>();
  const pairs: { tdArea: string; berth: string }[] = [];
  for (const r of rows) {
    for (const berth of [r.fromBerth, r.toBerth]) {
      if (!berth) continue;
      const key = `${r.row.td_area}|${berth}`;
      if (!pairKeys.has(key)) {
        pairKeys.add(key);
        pairs.push({ tdArea: r.row.td_area, berth });
      }
    }
  }

  const openMap = await bulkGetOpenOccupancy(client, projectionVersion, pairs);

  const { rows: idRows } = await client.query<{ id: string }>(
    `select nextval('berth_occupancy_id_seq')::text as id from generate_series(1, $1)`,
    [rows.length],
  );
  let nextIdIndex = 0;

  interface OpenWrite {
    id: string;
    tdArea: string;
    berthCode: string;
    description: string;
    enteredAt: Date;
    entryEventId: string;
    entryEventNormalizedAt: Date;
    entryReason: string;
  }
  interface CloseWrite {
    id: string;
    leftAt: Date;
    exitEventId: string;
    exitEventNormalizedAt: Date;
    exitReason: string;
  }
  interface AnomalyWrite {
    tdArea: string;
    berthCode: string | null;
    rawEventId: string;
    rawEventNormalizedAt: Date;
    anomalyCode: string;
    details: Record<string, unknown>;
    eventAt: Date;
    ingestionSequence: string;
  }

  const opens: OpenWrite[] = [];
  const closes: CloseWrite[] = [];
  const anomalies: AnomalyWrite[] = [];

  for (const { row, description, fromBerth, toBerth } of rows) {
    const fromKey = fromBerth ? `${row.td_area}|${fromBerth}` : null;
    const toKey = toBerth ? `${row.td_area}|${toBerth}` : null;
    const fromOpen = fromKey ? (openMap.get(fromKey) ?? null) : null;
    const toOpen = toKey ? (openMap.get(toKey) ?? null) : null;

    let effects: BerthEffect[];
    if (row.event_type === "CA") {
      effects = applyCA({
        fromBerth: fromBerth!,
        toBerth: toBerth!,
        description,
        fromOpen,
        toOpen,
      }).effects;
    } else if (row.event_type === "CB") {
      effects = applyCB({ fromBerth: fromBerth!, description, fromOpen }).effects;
    } else {
      effects = applyCC({ toBerth: toBerth!, description, toOpen }).effects;
    }

    for (const effect of effects) {
      if (effect.kind === "closeOccupancy") {
        const berthKey = effect.berth === "from" ? fromKey : toKey;
        closes.push({
          id: effect.occupancyId,
          leftAt: row.normalized_event_at_utc,
          exitEventId: row.id,
          exitEventNormalizedAt: row.normalized_event_at_utc,
          exitReason: effect.exitReason,
        });
        if (berthKey) openMap.delete(berthKey);
      } else if (effect.kind === "openOccupancy") {
        const berthKey = toKey!;
        const id = idRows[nextIdIndex++]!.id;
        opens.push({
          id,
          tdArea: row.td_area,
          berthCode: toBerth!,
          description: effect.description,
          enteredAt: row.normalized_event_at_utc,
          entryEventId: row.id,
          entryEventNormalizedAt: row.normalized_event_at_utc,
          entryReason: effect.entryReason,
        });
        openMap.set(berthKey, {
          occupancyId: id,
          description: effect.description,
          enteredAt: row.normalized_event_at_utc.toISOString(),
        });
      } else {
        const berthCode =
          effect.berth === "from"
            ? (fromBerth ?? null)
            : effect.berth === "to"
              ? (toBerth ?? null)
              : null;
        anomalies.push({
          tdArea: row.td_area,
          berthCode,
          rawEventId: row.id,
          rawEventNormalizedAt: row.normalized_event_at_utc,
          anomalyCode: effect.anomalyCode,
          details: effect.details,
          eventAt: row.normalized_event_at_utc,
          ingestionSequence: row.ingestion_sequence,
        });
      }
    }
  }

  // Opens before closes — see the doc comment above: a same-batch close may target a row this
  // same call is about to insert.
  if (opens.length > 0) {
    await client.query(
      `insert into berth_occupancy (
         id, projection_version, td_area, berth_code, description, entered_at,
         entry_event_id, entry_event_normalized_at_utc, entry_reason
       )
       select t.id, $1, t.td_area, t.berth_code, t.description, t.entered_at, t.entry_event_id,
              t.entry_event_normalized_at, t.entry_reason
       from unnest(
         $2::bigint[], $3::text[], $4::text[], $5::text[], $6::timestamptz[], $7::bigint[],
         $8::timestamptz[], $9::text[]
       ) as t(id, td_area, berth_code, description, entered_at, entry_event_id,
              entry_event_normalized_at, entry_reason)`,
      [
        projectionVersion,
        opens.map((o) => o.id),
        opens.map((o) => o.tdArea),
        opens.map((o) => o.berthCode),
        opens.map((o) => o.description),
        opens.map((o) => o.enteredAt),
        opens.map((o) => o.entryEventId),
        opens.map((o) => o.entryEventNormalizedAt),
        opens.map((o) => o.entryReason),
      ],
    );
  }
  if (closes.length > 0) {
    // `where id = $1` only, matching the original per-row update — berth_occupancy's real PK is
    // (id, entered_at), required only because the table is partitioned by entered_at, but `id`
    // itself is already globally unique (one sequence for every partition), so this always
    // matches at most one row.
    await client.query(
      `update berth_occupancy set
         left_at = t.left_at, exit_event_id = t.exit_event_id,
         exit_event_normalized_at_utc = t.exit_event_normalized_at, exit_reason = t.exit_reason
       from unnest(
         $1::bigint[], $2::timestamptz[], $3::bigint[], $4::timestamptz[], $5::text[]
       ) as t(id, left_at, exit_event_id, exit_event_normalized_at, exit_reason)
       where berth_occupancy.id = t.id`,
      [
        closes.map((c) => c.id),
        closes.map((c) => c.leftAt),
        closes.map((c) => c.exitEventId),
        closes.map((c) => c.exitEventNormalizedAt),
        closes.map((c) => c.exitReason),
      ],
    );
  }
  if (anomalies.length > 0) {
    await client.query(
      `insert into td_projection_anomaly (
         projection_version, td_area, berth_code, raw_event_id, raw_event_normalized_at_utc,
         anomaly_code, details, event_at, ingestion_sequence
       )
       select $1, t.td_area, t.berth_code, t.raw_event_id, t.raw_event_normalized_at, t.anomaly_code,
              t.details::jsonb, t.event_at, t.ingestion_sequence
       from unnest(
         $2::text[], $3::text[], $4::bigint[], $5::timestamptz[], $6::text[], $7::text[],
         $8::timestamptz[], $9::bigint[]
       ) as t(td_area, berth_code, raw_event_id, raw_event_normalized_at, anomaly_code, details,
              event_at, ingestion_sequence)`,
      [
        projectionVersion,
        anomalies.map((a) => a.tdArea),
        anomalies.map((a) => a.berthCode),
        anomalies.map((a) => a.rawEventId),
        anomalies.map((a) => a.rawEventNormalizedAt),
        anomalies.map((a) => a.anomalyCode),
        anomalies.map((a) => JSON.stringify(a.details)),
        anomalies.map((a) => a.eventAt),
        anomalies.map((a) => a.ingestionSequence),
      ],
    );
  }

  return { anomalies: anomalies.length };
}

/** One upsert for the whole batch (via `unnest`, same pattern as
 * apps/worker/src/resolver/projector.ts's batch-candidate queries) — `GET /api/v1/td/areas`
 * (migration 0023) reads this instead of scanning `raw_feed_event`. `least`/`greatest` extend the
 * area's known first/last-seen bounds; counts accumulate additively, safe because each row is
 * counted here exactly once (this function only ever runs on rows this same transaction is about
 * to commit as newly processed — never on a replay, since replayed rows are skipped upstream by
 * `td_berth_event`/`td_s_event`'s own `on conflict do nothing`). */
async function upsertAreaSummary(
  client: PoolClient,
  areaSummary: Map<string, { firstAt: Date; lastAt: Date; cCount: number; sCount: number }>,
): Promise<void> {
  if (areaSummary.size === 0) return;
  const areas = [...areaSummary.keys()];
  const firstAts = areas.map((area) => areaSummary.get(area)!.firstAt);
  const lastAts = areas.map((area) => areaSummary.get(area)!.lastAt);
  const cCounts = areas.map((area) => areaSummary.get(area)!.cCount);
  const sCounts = areas.map((area) => areaSummary.get(area)!.sCount);

  await client.query(
    `insert into td_area_summary (td_area, first_event_at, last_event_at, c_class_count, s_class_count, updated_at)
     select t.td_area, t.first_at, t.last_at, t.c_count, t.s_count, now()
     from unnest($1::text[], $2::timestamptz[], $3::timestamptz[], $4::bigint[], $5::bigint[])
       as t(td_area, first_at, last_at, c_count, s_count)
     on conflict (td_area) do update set
       first_event_at = least(td_area_summary.first_event_at, excluded.first_event_at),
       last_event_at = greatest(td_area_summary.last_event_at, excluded.last_event_at),
       c_class_count = td_area_summary.c_class_count + excluded.c_class_count,
       s_class_count = td_area_summary.s_class_count + excluded.s_class_count,
       updated_at = now()`,
    [areas, firstAts, lastAts, cCounts, sCounts],
  );
}

/**
 * Turns nationwide raw TD events into current-state/history projections
 * (docs/IMPLEMENTATION_PLAN.md Milestone 4). Processes strictly in `ingestion_sequence` order —
 * not `event_at` — which is what makes equal-timestamp events deterministic. Each batch commits
 * in one transaction together with its checkpoint advance, so a crash mid-run only ever loses an
 * uncommitted batch, never produces partial/duplicate projection state.
 *
 * Within a batch, rows are categorized (CT / CA-CB-CC / S-Class / other) and then handled with a
 * small, fixed number of bulk statements (2026-09 catch-up throughput fix) rather than one
 * `select`/`insert`/`update` per row — see `processCClassBatch`'s doc comment for why this is safe
 * for the stateful open/close logic specifically. Every event is still individually idempotent
 * (`on conflict (raw_event_id, event_at) do nothing`), so no event is ever double-applied.
 *
 * Holds a Postgres advisory lock for its entire run (released even on error/crash — it's tied to
 * the session, not explicitly tracked state). `getCheckpoint`/`advanceCheckpoint` have no locking
 * of their own: two concurrent runs (the continuous `projector` service's loop racing a manual
 * `project-td` console command, for example) would both read the same checkpoint and both fetch
 * the same batch before either commits. Each event is individually idempotent
 * (`on conflict (raw_event_id, event_at) do nothing`), so no event is ever double-applied — but a
 * `closeOccupancy` effect is only emitted when the reducer sees a non-null `fromOpen` snapshot,
 * and two interleaved transactions can each read the *other's* not-yet-committed prior effect,
 * so one of them computes against stale state and silently emits no closing effect at all. That
 * leaves a berth showing occupied forever, with no error anywhere to indicate it happened. The
 * lock makes that interleaving impossible: a second concurrent invocation fails to acquire it and
 * returns immediately rather than racing.
 *
 * Each per-batch transaction previously also took a shared `BERTH_OCCUPANCY_WRITE_LOCK_KEY`
 * before touching any `berth_occupancy` row, to prevent a real production deadlock (40P01,
 * 2026-08-14) against `project-resolver`'s own `berth_occupancy` writes. The berth-run resolver
 * was removed entirely (ADR 0002, migrations 0022/0025), so this projector is `berth_occupancy`'s
 * only writer again and the lock has nothing left to protect. See
 * `apps/worker/src/shared/advisoryLock.ts`'s doc comment for the removal note.
 */
export async function runProjectTd(
  pool: Pool,
  options: ProjectTdOptions = {},
): Promise<ProjectTdSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const lockKey = advisoryLockKey(TD_PROJECTION_NAME);
  const lockClient = await pool.connect();
  try {
    const lockResult = await lockClient.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [lockKey],
    );
    if (!lockResult.rows[0]?.locked) {
      return { ...EMPTY_SUMMARY, skippedLockContention: true };
    }

    const definitionId = await getOrCreateProjectionDefinition(
      pool,
      TD_PROJECTION_NAME,
      TD_PROJECTION_VERSION,
      computeConfigHash(),
    );
    await ensureCheckpoint(pool, definitionId);

    if (options.rebuild) {
      await clearProjectionRows(pool, TD_PROJECTION_VERSION);
      await resetCheckpoint(pool, definitionId);
    }

    const summary: ProjectTdSummary = { ...EMPTY_SUMMARY };
    // Last row of the previous batch in this run (receive time) — saves a lookup per batch; the
    // first batch of a run looks it up by checkpoint sequence instead.
    let previousReceived: ReceivedRow | null = null;

    for (;;) {
      const checkpoint = await getCheckpoint(pool, definitionId);
      const lastSequence = checkpoint?.lastIngestionSequence ?? "0";

      const batch = await pool.query<RawTdRow>(
        `select id, normalized_event_at_utc, ingestion_sequence, event_type, message_class, td_area,
                raw_event_json, parse_status, received_at_utc
         from raw_feed_event
         where feed_name = 'TD' and ingestion_sequence > $1
         order by ingestion_sequence
         limit $2`,
        [lastSequence, batchSize],
      );
      if (batch.rows.length === 0) {
        break;
      }
      summary.batches += 1;
      // (maxBatches check happens after this batch commits — see end of loop)

      const client = await pool.connect();
      try {
        await client.query("begin");
        let maxSequence = BigInt(lastSequence);
        const areaSummary = new Map<
          string,
          { firstAt: Date; lastAt: Date; cCount: number; sCount: number }
        >();

        const ctRows: RawTdRow[] = [];
        const cClassRows: ParsedCClassRow[] = [];
        const sClassRows: ParsedSClassRow[] = [];

        for (const row of batch.rows) {
          summary.processedEvents += 1;
          const rowSequence = BigInt(row.ingestion_sequence);
          if (rowSequence > maxSequence) {
            maxSequence = rowSequence;
          }

          if (row.parse_status !== "parsed") {
            continue;
          }

          if (row.message_class === "C") {
            if (row.event_type === "CT") {
              ctRows.push(row);
            } else if (
              row.event_type === "CA" ||
              row.event_type === "CB" ||
              row.event_type === "CC"
            ) {
              const payload = unwrapPayload(row, `${row.event_type}_MSG`);
              cClassRows.push({
                row,
                description: String(payload?.descr),
                ...(row.event_type !== "CC" ? { fromBerth: String(payload?.from) } : {}),
                ...(row.event_type !== "CB" ? { toBerth: String(payload?.to) } : {}),
              });
            } else {
              // message_class 'C' rows are only ever CA/CB/CC/CT per packages/feed-parsers' classifier.
              continue;
            }
          } else if (row.message_class === "S") {
            const payload = unwrapPayload(row, row.event_type);
            const address = typeof payload?.address === "string" ? payload.address : null;
            const rawValue =
              typeof payload?.data === "string"
                ? payload.data
                : payload
                  ? JSON.stringify(payload)
                  : null;
            const decoded = decodeSClassPayload(row.event_type, payload?.address, payload?.data);
            sClassRows.push({ row, address, rawValue, decoded });
          } else {
            continue;
          }

          const existing = areaSummary.get(row.td_area);
          const at = row.normalized_event_at_utc;
          if (existing) {
            if (at < existing.firstAt) existing.firstAt = at;
            if (at > existing.lastAt) existing.lastAt = at;
            if (row.message_class === "C") existing.cCount += 1;
            else existing.sCount += 1;
          } else {
            areaSummary.set(row.td_area, {
              firstAt: at,
              lastAt: at,
              cCount: row.message_class === "C" ? 1 : 0,
              sCount: row.message_class === "S" ? 1 : 0,
            });
          }
        }

        await insertHeartbeatsBulk(client, ctRows);
        summary.heartbeats += ctRows.length;

        const newBerthEventIds = await insertBerthEventsBulk(client, cClassRows);
        summary.projectedBerthEvents += newBerthEventIds.size;
        const newCClassRows = cClassRows.filter((r) => newBerthEventIds.has(r.row.id));
        const { anomalies } = await processCClassBatch(
          client,
          TD_PROJECTION_VERSION,
          newCClassRows,
        );
        summary.anomalies += anomalies;

        const newSEventIds = await insertSEventsBulk(client, sClassRows);
        summary.sEvents += newSEventIds.size;
        const newSClassRows = sClassRows.filter((r) => newSEventIds.has(r.row.id));
        const sFoldEvents: SClassFoldEvent[] = [];
        for (const r of newSClassRows) {
          if (!r.decoded.ok) {
            summary.sDecodeFailures += 1;
            continue;
          }
          sFoldEvents.push({
            tdArea: r.row.td_area,
            sourceKind: r.decoded.sourceKind,
            bytes: r.decoded.bytes,
            eventId: r.row.id,
            eventNormalizedAt: r.row.normalized_event_at_utc,
            ingestionSequence: r.row.ingestion_sequence,
          });
        }
        const sFold = foldSClassEvents(await loadSByteState(client, sFoldEvents), sFoldEvents);
        summary.sBitTransitions += await insertSBitTransitionsBulk(client, sFold);
        summary.sRefreshMismatches += sFold.refreshMismatches;
        await upsertSByteStateBulk(client, sFold);

        summary.feedSilences += await recordReceiveSilences(
          client,
          lastSequence,
          batch.rows,
          previousReceived,
        );

        await upsertAreaSummary(client, areaSummary);
        await advanceCheckpoint(client, definitionId, maxSequence.toString());
        await client.query("commit");
        const lastRow = batch.rows.at(-1);
        previousReceived = lastRow
          ? { receivedAt: lastRow.received_at_utc, ingestionSequence: lastRow.ingestion_sequence }
          : previousReceived;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }

      // Yield after `maxBatches` so the daemon can publish deltas / check its other work rather
      // than stay blocked here for minutes on a large catch-up. The checkpoint is committed per
      // batch, so the next call resumes exactly where this left off.
      if (options.maxBatches !== undefined && summary.batches >= options.maxBatches) {
        break;
      }
    }

    return summary;
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [lockKey]).catch(() => {});
    lockClient.release();
  }
}
