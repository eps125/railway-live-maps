import { createPool } from "@railway/database";
import {
  TD_S_DECODE_VERSION,
  decodeSClassPayload,
  foldSClassEvents,
  sByteKey,
  type SByteState,
  type SClassFoldEvent,
} from "@railway/domain";
import type { Pool, PoolClient } from "pg";
import type { Config } from "../config.js";
import { insertSBitTransitionsBulk } from "../td/projector.js";

/**
 * `backfill-s-class-bits` — one-shot (docs/IMPLEMENTATION_PLAN.md Milestone 56, docs/adr/0013).
 *
 * Milestone 36a started decoding S-Class bytes into `td_s_bit_transition`, but only from the
 * moment it was deployed: the S-Class explorer could therefore only ever look back as far as that
 * deploy. Every byte needed to reconstruct the earlier history is already retained — `td_s_event`
 * keeps `message_type`, `address` and `raw_value` untouched for rows written long before the
 * decoder existed (`decode_status = 'raw_only'`) — so this replays them through the *same*
 * `foldSClassEvents` + `insertSBitTransitionsBulk` the live projector uses and fills the gap.
 *
 * Deliberately narrow, because the live signal path reads the other S-Class table:
 *
 * - It writes **only** `td_s_bit_transition`. It never touches `td_s_current_state`, which is
 *   "the value of this byte *now*" and is what live/playback signal state resolves from
 *   (CLAUDE.md rules 9/10). Historic events replayed into it would move signals backwards. The
 *   fold's prior state is therefore held in memory here, never loaded from or written to the DB.
 * - It *does* fill `td_s_event`'s decode columns (`decoded_bitset`, `decode_status`,
 *   `decode_version`, `decode_error_code`), because that is what replay and `/state?at=` actually
 *   read — `fetchSByteFactsAt` requires `decode_status = 'decoded'`, so history left as
 *   `raw_only` renders every signal blank however many transitions exist. This revises an earlier,
 *   over-cautious reading of that column as "a historical fact about ingest": the raw truth
 *   (`message_type`, `address`, `raw_value`) is never touched, and `decoded_bitset` is a derived
 *   projection of it, which CLAUDE.md rule 3 requires to be rebuildable. `decode_version` records
 *   which decoder produced it. Only `raw_only` rows are updated, so a row the live projector
 *   already decoded is never overwritten. Pass `--skip-decode` to fill transitions alone.
 *
 * Idempotent: `td_s_bit_transition_source_uk` makes every insert `on conflict do nothing`, so a
 * re-run (or an overlapping window, or resuming an interrupted run) adds nothing twice. Dry-run
 * by default — pass `--execute` to write, the same guard `prune-partitions` uses.
 *
 * Usage:
 *   backfill-s-class-bits [--days 14 | --from <ISO>] [--to <ISO>] [--area XX]
 *                         [--slice-hours 6] [--sleep-ms 250] [--skip-decode] [--execute]
 *
 * `--to` defaults to the oldest transition already recorded, i.e. exactly where the live decoder
 * took over, so the default run fills the gap and re-reads nothing.
 */

/** Per-area time slice size. Bounds memory and keeps each transaction short against a live DB. */
const DEFAULT_SLICE_HOURS = 6;
/** Pause after each slice (all areas), so a long backfill yields to the live projector. */
const DEFAULT_SLEEP_MS = 250;
const DEFAULT_DAYS = 14;
const MAX_DAYS = 60;

export interface BackfillArgs {
  from: Date;
  to: Date;
  area: string | null;
  sliceHours: number;
  sleepMs: number;
  /** Fill `td_s_event`'s decode columns as well as the transitions (default true). */
  decode: boolean;
  execute: boolean;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function parseNumber(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pure: argv → a validated window. `to` is only defaulted by the caller (it needs a query), so
 * `defaultTo` is passed in. Exported for its own unit test.
 */
export function parseBackfillArgs(
  argv: string[],
  defaultTo: Date,
): { ok: true; args: BackfillArgs } | { ok: false; error: string } {
  const toRaw = flag(argv, "--to");
  const to = toRaw ? new Date(toRaw) : defaultTo;
  if (Number.isNaN(to.getTime())) return { ok: false, error: `--to: not a valid date: ${toRaw}` };

  const fromRaw = flag(argv, "--from");
  const days = parseNumber(flag(argv, "--days"), DEFAULT_DAYS);
  if (days === null) return { ok: false, error: "--days must be a positive number" };
  const from = fromRaw ? new Date(fromRaw) : new Date(to.getTime() - days * 86_400_000);
  if (Number.isNaN(from.getTime())) {
    return { ok: false, error: `--from: not a valid date: ${fromRaw}` };
  }
  if (from >= to) {
    return {
      ok: false,
      error: `window is empty: from ${from.toISOString()} is not before to ${to.toISOString()}`,
    };
  }
  if (to.getTime() - from.getTime() > MAX_DAYS * 86_400_000) {
    return { ok: false, error: `window may be at most ${MAX_DAYS} days` };
  }

  const areaRaw = flag(argv, "--area");
  if (areaRaw !== undefined && !/^[A-Za-z0-9]{2}$/.test(areaRaw)) {
    return { ok: false, error: `--area: expected a two-character TD area, got "${areaRaw}"` };
  }
  const sliceHours = parseNumber(flag(argv, "--slice-hours"), DEFAULT_SLICE_HOURS);
  if (sliceHours === null) return { ok: false, error: "--slice-hours must be a positive number" };
  const sleepRaw = flag(argv, "--sleep-ms");
  const sleepMs = sleepRaw === undefined ? DEFAULT_SLEEP_MS : Number(sleepRaw);
  if (!Number.isFinite(sleepMs) || sleepMs < 0) {
    return { ok: false, error: "--sleep-ms must be zero or more" };
  }

  return {
    ok: true,
    args: {
      from,
      to,
      area: areaRaw ? areaRaw.toUpperCase() : null,
      sliceHours,
      sleepMs,
      decode: !argv.includes("--skip-decode"),
      execute: argv.includes("--execute"),
    },
  };
}

/** Pure: the ascending [start, end) slices covering a window. Exported for its own unit test. */
export function planSlices(from: Date, to: Date, sliceHours: number): Array<[Date, Date]> {
  const step = sliceHours * 3_600_000;
  const slices: Array<[Date, Date]> = [];
  for (let t = from.getTime(); t < to.getTime(); t += step) {
    slices.push([new Date(t), new Date(Math.min(t + step, to.getTime()))]);
  }
  return slices;
}

/** One `td_s_event` row, as the backfill reads it. */
export interface SEventRow {
  id: string;
  event_at: Date;
  raw_event_id: string;
  raw_event_normalized_at_utc: Date;
  td_area: string;
  message_type: string;
  address: string | null;
  raw_value: string | null;
  ingestion_sequence: string;
}

/**
 * Pure: a stored row → a fold event, or the decode error code that rejected it. The decode uses
 * the values `td_s_event` preserved verbatim at ingest, so a row written before the decoder
 * existed replays exactly as it would have then (CLAUDE.md: never silently repair source data —
 * a row that will not decode is counted and reported, not patched).
 */
export function toFoldEvent(
  row: SEventRow,
): { ok: true; event: SClassFoldEvent } | { ok: false; errorCode: string } {
  const decoded = decodeSClassPayload(row.message_type, row.address, row.raw_value);
  if (!decoded.ok) return { ok: false, errorCode: decoded.errorCode };
  return {
    ok: true,
    event: {
      tdArea: row.td_area,
      sourceKind: decoded.sourceKind,
      bytes: decoded.bytes,
      eventId: row.raw_event_id,
      eventNormalizedAt: row.raw_event_normalized_at_utc,
      ingestionSequence: row.ingestion_sequence,
    },
  };
}

/** One row's decode outcome, ready to stamp onto `td_s_event`. */
interface DecodeWrite {
  id: string;
  eventAt: Date;
  /** `{"bytes":{"07":203}}` — the same shape `insertSEventsBulk` writes, or null when undecodable. */
  bitset: string | null;
  status: "decoded" | "unsupported";
  errorCode: string | null;
}

/**
 * Fills `td_s_event`'s decode columns for rows still marked `raw_only`. Keyed on the primary key
 * `(id, event_at)` — `event_at` is the partition key, so each row is located in its own partition
 * rather than probed across all of them. The `raw_only` guard is what makes this idempotent and
 * keeps it from ever overwriting a row the live projector decoded.
 *
 * An undecodable row is recorded as `unsupported` with its `decode_error_code`, never left silent
 * and never repaired (CLAUDE.md rule 18).
 */
async function updateSEventDecodeBulk(
  client: PoolClient,
  writes: readonly DecodeWrite[],
): Promise<number> {
  if (writes.length === 0) return 0;
  const result = await client.query(
    `update td_s_event e
        set decoded_bitset = t.decoded_bitset,
            decode_status = t.decode_status,
            decode_error_code = t.decode_error_code,
            decode_version = $6
       from unnest($1::bigint[], $2::timestamptz[], $3::jsonb[], $4::text[], $5::text[])
            as t(id, event_at, decoded_bitset, decode_status, decode_error_code)
      where e.id = t.id and e.event_at = t.event_at and e.decode_status = 'raw_only'`,
    [
      writes.map((w) => w.id),
      writes.map((w) => w.eventAt),
      writes.map((w) => w.bitset),
      writes.map((w) => w.status),
      writes.map((w) => w.errorCode),
      TD_S_DECODE_VERSION,
    ],
  );
  return result.rowCount ?? 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The areas to walk: every area with S-Class events in the window (or just `--area`). */
async function areasInWindow(pool: Pool, args: BackfillArgs): Promise<string[]> {
  if (args.area) return [args.area];
  // Off `td_s_current_state` (one row per byte, ~10k rows) rather than a distinct scan of the
  // 20 GB event table: an area with S-Class history always has current state for those bytes.
  const result = await pool.query<{ td_area: string }>(
    `select distinct td_area from td_s_current_state where byte_value is not null order by td_area`,
  );
  return result.rows.map((r) => r.td_area);
}

/**
 * Where this area's existing coverage starts — the default `--to`, so a default run fills the
 * gap before it and re-reads nothing.
 *
 * **Scoped to `area` when one is given**, which it must be: the boundary is per area, not global.
 * Taking `min(event_at)` across the whole table was wrong as soon as a second area was backfilled
 * — once M9 had been filled back to 2026-09-05, a bare `--area XX` on any other area computed its
 * window from *M9's* boundary and silently targeted the wrong fortnight (found 2026-09-20, after
 * the M9 run). A fresh area has transitions only from when the live projector started, so this
 * returns that; an already-backfilled area returns its earlier boundary, and re-running simply
 * extends coverage further back.
 */
async function coverageStart(pool: Pool, area: string | null): Promise<Date | null> {
  const result = area
    ? await pool.query<{ oldest: Date | null }>(
        `select min(event_at) as oldest from td_s_bit_transition where td_area = $1`,
        [area],
      )
    : await pool.query<{ oldest: Date | null }>(
        `select min(event_at) as oldest from td_s_bit_transition`,
      );
  return result.rows[0]?.oldest ?? null;
}

/**
 * Pure: the `--area` value as the boundary query needs it, before the full parse (which cannot
 * run until the boundary is known). Malformed input yields null here and is reported properly by
 * `parseBackfillArgs`, so a bad `--area` never silently becomes a nationwide boundary lookup.
 */
export function areaFlag(argv: string[]): string | null {
  const raw = flag(argv, "--area");
  return raw !== undefined && /^[A-Za-z0-9]{2}$/.test(raw) ? raw.toUpperCase() : null;
}

interface AreaTotals {
  events: number;
  decodeFailures: number;
  transitions: number;
  /** `td_s_event` rows whose decode columns were filled (were still `raw_only`). */
  decoded: number;
}

/**
 * One (area, slice) read + fold, accumulating into `totals`. The fold's prior state for this area
 * is carried in `state` across slices, so a bit that does not change across a slice boundary does
 * not produce a spurious "first sight" row.
 */
async function backfillSlice(
  pool: Pool,
  area: string,
  start: Date,
  end: Date,
  state: Map<string, SByteState>,
  args: BackfillArgs,
  totals: AreaTotals,
): Promise<void> {
  // `materialized` pins the (td_area, event_at desc) index: ordering by the global
  // `ingestion_sequence` otherwise tempts the planner into a nationwide scan of a 20 GB table
  // (the Milestone 33 pitfall). Verified against production — an index scan of the one month
  // partition, never a seq scan.
  const result = await pool.query<SEventRow>(
    `with e as materialized (
       select id, event_at, raw_event_id, raw_event_normalized_at_utc, td_area, message_type,
              address, raw_value, ingestion_sequence
         from td_s_event
        where td_area = $1 and event_at >= $2 and event_at < $3
     )
     select * from e order by ingestion_sequence`,
    [area, start, end],
  );
  if (result.rows.length === 0) return;
  totals.events += result.rows.length;

  const events: SClassFoldEvent[] = [];
  const decodeWrites: DecodeWrite[] = [];
  for (const row of result.rows) {
    const mapped = toFoldEvent(row);
    if (mapped.ok) {
      events.push(mapped.event);
      decodeWrites.push({
        id: row.id,
        eventAt: row.event_at,
        bitset: JSON.stringify({
          bytes: Object.fromEntries(mapped.event.bytes.map((b) => [b.address, b.value])),
        }),
        status: "decoded",
        errorCode: null,
      });
    } else {
      totals.decodeFailures += 1;
      decodeWrites.push({
        id: row.id,
        eventAt: row.event_at,
        bitset: null,
        status: "unsupported",
        errorCode: mapped.errorCode,
      });
    }
  }
  if (events.length === 0 && decodeWrites.length === 0) return;

  const fold = foldSClassEvents(state, events);
  const wantsWrite = fold.transitions.length > 0 || (args.decode && decodeWrites.length > 0);
  if (args.execute && wantsWrite) {
    // One transaction per slice: the transitions and the decode columns they were derived from
    // land together, so an interrupted run never leaves a slice half-applied.
    const client = await pool.connect();
    try {
      await client.query("begin");
      totals.transitions += await insertSBitTransitionsBulk(client, fold);
      if (args.decode) totals.decoded += await updateSEventDecodeBulk(client, decodeWrites);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } else {
    totals.transitions += fold.transitions.length;
    if (args.decode) totals.decoded += decodeWrites.length;
  }

  for (const write of fold.byteWrites) {
    state.set(sByteKey(write.tdArea, write.address), {
      value: write.value,
      sourceIngestionSequence: write.ingestionSequence,
    });
  }
}

export async function runBackfillSClassBits(config: Config, argv: string[]): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const oldest = await coverageStart(pool, areaFlag(argv));
    const parsed = parseBackfillArgs(argv, oldest ?? new Date());
    if (!parsed.ok) {
      console.error(`backfill-s-class-bits: ${parsed.error}`);
      process.exitCode = 1;
      return;
    }
    const args = parsed.args;

    console.log(
      `backfill-s-class-bits: ${args.execute ? "EXECUTE" : "DRY RUN (pass --execute to write)"}`,
    );
    console.log(`  window   ${args.from.toISOString()} .. ${args.to.toISOString()}`);
    console.log(
      `  boundary ${
        oldest
          ? `existing coverage starts ${oldest.toISOString()}${areaFlag(argv) ? ` (for ${areaFlag(argv)})` : " (all areas)"}`
          : "no transitions recorded yet"
      }`,
    );
    console.log(
      `  slices   ${args.sliceHours} h, ${args.sleepMs} ms between them` +
        `${args.area ? `, area ${args.area} only` : ", all areas"}`,
    );
    console.log(
      `  decode   ${args.decode ? "filling td_s_event decode columns (replay/state readable)" : "skipped (--skip-decode)"}`,
    );

    const areas = await areasInWindow(pool, args);
    console.log(`  areas    ${areas.length}\n`);

    const started = Date.now();
    const grand: AreaTotals = { events: 0, decodeFailures: 0, transitions: 0, decoded: 0 };
    // Slices outer, areas inner — deliberately, and measured on production (2026-09-20). Every
    // area's rows for a given period are interleaved on the same heap pages, so walking all areas
    // through one slice before moving on keeps the working set to that slice and lets the areas
    // share cache: re-reading an already-cached slice took 14 ms against 3 287 ms cold. Area-outer
    // would instead sweep the whole 14 days (~34 GB, far past RAM) once per area, evicting
    // everything before the next area re-read the very same pages.
    const stateByArea = new Map<string, Map<string, SByteState>>();
    for (const area of areas) stateByArea.set(area, new Map());

    const slices = planSlices(args.from, args.to, args.sliceHours);
    for (const [index, [start, end]] of slices.entries()) {
      const before = { ...grand };
      for (const area of areas) {
        const state = stateByArea.get(area);
        if (!state) continue;
        await backfillSlice(pool, area, start, end, state, args, grand);
      }
      console.log(
        `[${String(index + 1).padStart(3)}/${slices.length}] ${start.toISOString()}: ` +
          `${grand.events - before.events} events, ` +
          `${grand.transitions - before.transitions} transitions` +
          (args.decode ? `, ${grand.decoded - before.decoded} decoded` : ""),
      );
      if (args.sleepMs > 0) await sleep(args.sleepMs);
    }

    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(
      `\nbackfill-s-class-bits: ${grand.events} events read, ` +
        `${grand.transitions} transitions ${args.execute ? "written" : "would be written"}, ` +
        (args.decode
          ? `${grand.decoded} td_s_event rows ${args.execute ? "decoded" : "would be decoded"}, `
          : "decode columns skipped, ") +
        `${grand.decodeFailures} undecodable, ${seconds}s`,
    );
    if (!args.execute) console.log("Dry run — nothing was written. Re-run with --execute.");
  } finally {
    await pool.end();
  }
}
