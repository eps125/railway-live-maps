import type { Pool } from "pg";

/**
 * Milestone 36b (docs/adr/0013) — the *facts* a signal's state is resolved from, read from
 * Postgres. Queries only: the rules (trust, on/off) live in `@railway/domain`'s
 * `resolveSignalStates`, so live state, `/state?at=`, snapshots and playback all apply exactly
 * the same logic (CLAUDE.md rule 13). This package stays a leaf (see
 * `mapStateReconstruction.ts`), so these return plain values.
 */

/** `feed_gap.detection_reason` written by `project-td` for a TD receive silence. Mirrors
 * `@railway/domain`'s `TD_RECEIVE_SILENCE_REASON` (duplicated because this package is a leaf). */
const TD_RECEIVE_SILENCE_REASON = "td_receive_silence";

/** Mirrors `@railway/domain`'s `TD_S_STATE_PROJECTION_VERSION`-era decode: rows written since
 * Milestone 36a carry `decoded_bitset = {"bytes": {"<addr>": <value>}}`. */
export interface SByteFactRow {
  value: number;
  confirmedSequence: string;
}

/** Mirrors `@railway/domain`'s `TD_S_STATE_PROJECTION_VERSION` (duplicated because this package
 * is a leaf). */
const TD_S_STATE_PROJECTION_VERSION = 2;

/**
 * For each `(tdArea, address)`: the byte's value as stated by the most recent decoded
 * `td_s_event` at or before `at`, within `lookbackMs`. Rows before decoding existed (`raw_only`)
 * are never used — history from before Milestone 36a resolves as unknown, not guessed.
 *
 * 2026-09-26: the lookback is now days, not hours (some areas — Carlisle — send only changes,
 * never periodic refreshes, so a quiet byte's last statement can be many hours old). To keep that
 * cheap, the projector's `td_s_current_state` answers first: it holds every byte's latest
 * statement, so when that statement is at or before `at` (always, for live) it *is* the answer.
 * Only a byte whose latest statement is after `at` (playback) falls back to one
 * `(td_area, event_at desc)` index seek per byte (`limit 1` lateral), bounded by the lookback so a
 * byte that is never stated can't scan an area's whole history.
 */
export async function fetchSByteFactsAt(
  pool: Pool,
  bytes: ReadonlyArray<{ tdArea: string; address: string }>,
  at: Date,
  lookbackMs: number,
): Promise<Map<string, SByteFactRow>> {
  const facts = new Map<string, SByteFactRow>();
  if (bytes.length === 0) return facts;
  const unique = [...new Map(bytes.map((b) => [`${b.tdArea}|${b.address}`, b])).values()];
  const since = new Date(at.getTime() - lookbackMs);

  const current = await pool.query<{
    td_area: string;
    address: string;
    byte_value: number | null;
    event_at: Date;
    source_ingestion_sequence: string;
  }>(
    `select s.td_area, s.address, s.byte_value, s.event_at, s.source_ingestion_sequence::text
       from unnest($1::text[], $2::text[]) as wanted(td_area, address)
       join td_s_current_state s
         on s.projection_version = $3 and s.td_area = wanted.td_area and s.address = wanted.address
      where s.decode_status = 'decoded'`,
    [unique.map((b) => b.tdArea), unique.map((b) => b.address), TD_S_STATE_PROJECTION_VERSION],
  );
  const settled = new Set<string>();
  for (const row of current.rows) {
    const key = `${row.td_area}|${row.address}`;
    if (row.event_at > at) continue; // stated again since `at`: look further back below
    settled.add(key);
    if (row.byte_value === null || row.event_at <= since) continue; // unknown at `at`
    facts.set(key, { value: row.byte_value, confirmedSequence: row.source_ingestion_sequence });
  }
  const remaining = unique.filter((b) => !settled.has(`${b.tdArea}|${b.address}`));
  if (remaining.length === 0) return facts;

  const result = await pool.query<{
    td_area: string;
    address: string;
    value: number | null;
    ingestion_sequence: string | null;
  }>(
    `select wanted.td_area, wanted.address, latest.value, latest.ingestion_sequence::text
       from unnest($1::text[], $2::text[]) as wanted(td_area, address)
       cross join lateral (
         select (e.decoded_bitset->'bytes'->>wanted.address)::int as value, e.ingestion_sequence
           from td_s_event e
          where e.td_area = wanted.td_area
            and e.event_at <= $3 and e.event_at > $4
            and e.decode_status = 'decoded'
            and e.decoded_bitset->'bytes' ? wanted.address
          order by e.event_at desc, e.ingestion_sequence desc
          limit 1
       ) latest`,
    [remaining.map((b) => b.tdArea), remaining.map((b) => b.address), at, since],
  );
  for (const row of result.rows) {
    if (row.value === null || row.ingestion_sequence === null) continue;
    facts.set(`${row.td_area}|${row.address}`, {
      value: row.value,
      confirmedSequence: row.ingestion_sequence,
    });
  }
  return facts;
}

export interface SilenceStartRow {
  at: Date;
  sequence: string;
}

/** Recorded TD receive silences (`project-td`, Milestone 36b) that began within
 * `[at - lookbackMs, at]` — the only ones that can affect a byte confirmed inside the lookback. */
export async function fetchReceiveSilences(
  pool: Pool,
  at: Date,
  lookbackMs: number,
): Promise<SilenceStartRow[]> {
  const result = await pool.query<{ detected_start: Date; affected_sequence_start: string }>(
    `select detected_start, affected_sequence_start::text
       from feed_gap
      where feed_name = 'TD' and detection_reason = $1
        and detected_start <= $2 and detected_start > $3
        and affected_sequence_start is not null`,
    [TD_RECEIVE_SILENCE_REASON, at, new Date(at.getTime() - lookbackMs)],
  );
  return result.rows.map((row) => ({
    at: row.detected_start,
    sequence: row.affected_sequence_start,
  }));
}

export interface RawSOverlayRow {
  tdArea: string;
  eventType: string;
  address: unknown;
  data: unknown;
  ingestionSequence: string;
  /** The message's own (normalized) time — Milestone 65's mini explorer shows it per change. */
  eventAt: Date;
}

export interface LiveSOverlay {
  /** Parsed S-Class rows for `tdAreas` newer than the history projector's checkpoint, in
   * ingestion order — what `td_s_event` doesn't hold yet. */
  rows: RawSOverlayRow[];
  /** More rows than `maxRows` were waiting: the history projector is far behind, so the stored
   * facts can't be brought up to date here. Callers treat every signal as unknown. */
  truncated: boolean;
}

/** The newest TD row received at all (any area/class) — the start of an ongoing silence if the
 * feed has gone quiet. Null only on an empty database. A backward `(feed_name,
 * ingestion_sequence)` index scan per partition, `limit 1`. */
export async function fetchLastTdReceived(pool: Pool): Promise<SilenceStartRow | null> {
  const last = await pool.query<{ received_at_utc: Date; ingestion_sequence: string }>(
    // `r.`-qualified on purpose: an unqualified `order by ingestion_sequence` binds to the
    // `::text` output column of the same name, sorting every TD row as text instead of walking
    // the `(feed_name, ingestion_sequence)` index (the same trap as the 9f882f9 fix).
    `select r.received_at_utc, r.ingestion_sequence::text as ingestion_sequence
       from raw_feed_event r
      where r.feed_name = 'TD'
      order by r.ingestion_sequence desc
      limit 1`,
  );
  const row = last.rows[0];
  return row ? { at: row.received_at_utc, sequence: row.ingestion_sequence } : null;
}

/**
 * Live only: brings the stored facts up to "now". The history projector (`td-berth-and-s-class`)
 * runs a fraction of a second behind ingestion; the rows in that window are read raw here so a
 * live snapshot can never miss a signal change that the live publishers already sent before the
 * socket subscribed. Uses the `(feed_name, ingestion_sequence)` index.
 */
export async function fetchLiveSOverlay(
  pool: Pool,
  tdAreas: readonly string[],
  maxRows: number,
  maxBacklogRows: number,
): Promise<LiveSOverlay> {
  if (tdAreas.length === 0) return { rows: [], truncated: false };
  const lastReceived = await fetchLastTdReceived(pool);
  if (!lastReceived) return { rows: [], truncated: false };

  const checkpoint = await pool.query<{ seq: string }>(
    `select pc.last_ingestion_sequence::text as seq
       from projection_checkpoint pc
       join projection_definition pd on pd.id = pc.projection_definition_id
      where pd.name = 'td-berth-and-s-class'
      order by pd.code_version desc
      limit 1`,
  );
  const checkpointSeq = checkpoint.rows[0]?.seq ?? "0";
  // Far behind (normally a few hundred rows): don't scan a huge backlog on a request path —
  // the signals are unknown until the projector catches up.
  if (BigInt(lastReceived.sequence) - BigInt(checkpointSeq) > BigInt(maxBacklogRows)) {
    return { rows: [], truncated: true };
  }

  // Deliberately the same shape as `project-td`'s own batch query (`feed_name` + an
  // `ingestion_sequence` range — normally a few hundred rows past the checkpoint): adding a
  // `td_area` predicate let the planner fold in the `(td_area, event_type)` index and read every
  // row of the area for the whole month (measured on production 2026-09-19: >20s). Area and
  // class are filtered here instead.
  const result = await pool.query<{
    td_area: string | null;
    event_type: string;
    message_class: string | null;
    parse_status: string;
    raw_event_json: Record<string, unknown>;
    ingestion_sequence: string;
    normalized_event_at_utc: Date;
  }>(
    `select r.td_area, r.event_type, r.message_class, r.parse_status, r.raw_event_json,
            r.ingestion_sequence::text as ingestion_sequence, r.normalized_event_at_utc
       from raw_feed_event r
      where r.feed_name = 'TD' and r.ingestion_sequence > $1
      order by r.ingestion_sequence
      limit $2`,
    [checkpointSeq, maxBacklogRows + 1],
  );
  const areas = new Set(tdAreas);
  const matching = result.rows.filter(
    (row) =>
      row.message_class === "S" &&
      row.parse_status === "parsed" &&
      row.td_area !== null &&
      areas.has(row.td_area),
  );
  const truncated = result.rows.length > maxBacklogRows || matching.length > maxRows;
  const rows = matching.slice(0, maxRows).map((row) => {
    const payload = row.raw_event_json[row.event_type];
    const p =
      typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    return {
      tdArea: row.td_area ?? "",
      eventType: row.event_type,
      address: p.address,
      data: p.data,
      ingestionSequence: row.ingestion_sequence,
      eventAt: row.normalized_event_at_utc,
    };
  });
  return { rows, truncated };
}

/** Maximum raw rows / backlog the live overlay will read on a request path. ~60 TD rows/s
 * nationwide: 20k rows is roughly 5-6 minutes of backlog — the history projector is normally
 * well under a second behind, so reaching this already means it is badly stuck. */
const LIVE_OVERLAY_MAX_ROWS = 5_000;
const LIVE_OVERLAY_MAX_BACKLOG_ROWS = 20_000;

/** The `@railway/domain` `SignalFactsPort` backed by these queries (structurally typed — this
 * package doesn't import the domain). */
export function createSignalFactsPort(pool: Pool): {
  byteFactsAt: (
    bytes: ReadonlyArray<{ tdArea: string; address: string }>,
    at: Date,
    lookbackMs: number,
  ) => Promise<Map<string, SByteFactRow>>;
  recordedSilences: (at: Date, lookbackMs: number) => Promise<SilenceStartRow[]>;
  lastReceived: () => Promise<SilenceStartRow | null>;
  liveOverlay: (tdAreas: readonly string[]) => Promise<LiveSOverlay>;
} {
  return {
    byteFactsAt: (bytes, at, lookbackMs) => fetchSByteFactsAt(pool, bytes, at, lookbackMs),
    recordedSilences: (at, lookbackMs) => fetchReceiveSilences(pool, at, lookbackMs),
    lastReceived: () => fetchLastTdReceived(pool),
    liveOverlay: (tdAreas) =>
      fetchLiveSOverlay(pool, tdAreas, LIVE_OVERLAY_MAX_ROWS, LIVE_OVERLAY_MAX_BACKLOG_ROWS),
  };
}
