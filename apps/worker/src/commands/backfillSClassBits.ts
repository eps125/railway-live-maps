import { createPool } from "@railway/database";
import {
  decodeSClassPayload,
  foldSClassEvents,
  sByteKey,
  type SByteState,
  type SClassFoldEvent,
} from "@railway/domain";
import type { Pool } from "pg";
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
 * - It never writes `td_s_event` either: those rows already exist and their `decode_status`
 *   describes how they were normalized at ingest, which is a historical fact, not a cache.
 *
 * Idempotent: `td_s_bit_transition_source_uk` makes every insert `on conflict do nothing`, so a
 * re-run (or an overlapping window, or resuming an interrupted run) adds nothing twice. Dry-run
 * by default — pass `--execute` to write, the same guard `prune-partitions` uses.
 *
 * Usage:
 *   backfill-s-class-bits [--days 14 | --from <ISO>] [--to <ISO>] [--area XX]
 *                         [--slice-hours 6] [--sleep-ms 250] [--execute]
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

/** Where the live decoder took over — the default `--to`. */
async function oldestRecordedTransition(pool: Pool): Promise<Date | null> {
  const result = await pool.query<{ oldest: Date | null }>(
    `select min(event_at) as oldest from td_s_bit_transition`,
  );
  return result.rows[0]?.oldest ?? null;
}

interface AreaTotals {
  events: number;
  decodeFailures: number;
  transitions: number;
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
       select raw_event_id, raw_event_normalized_at_utc, td_area, message_type, address,
              raw_value, ingestion_sequence
         from td_s_event
        where td_area = $1 and event_at >= $2 and event_at < $3
     )
     select * from e order by ingestion_sequence`,
    [area, start, end],
  );
  if (result.rows.length === 0) return;
  totals.events += result.rows.length;

  const events: SClassFoldEvent[] = [];
  for (const row of result.rows) {
    const mapped = toFoldEvent(row);
    if (mapped.ok) events.push(mapped.event);
    else totals.decodeFailures += 1;
  }
  if (events.length === 0) return;

  const fold = foldSClassEvents(state, events);
  if (args.execute && fold.transitions.length > 0) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      totals.transitions += await insertSBitTransitionsBulk(client, fold);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } else {
    totals.transitions += fold.transitions.length;
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
    const oldest = await oldestRecordedTransition(pool);
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
      `  boundary ${oldest ? `oldest recorded transition ${oldest.toISOString()}` : "no transitions recorded yet"}`,
    );
    console.log(
      `  slices   ${args.sliceHours} h, ${args.sleepMs} ms between them` +
        `${args.area ? `, area ${args.area} only` : ", all areas"}`,
    );

    const areas = await areasInWindow(pool, args);
    console.log(`  areas    ${areas.length}\n`);

    const started = Date.now();
    const grand: AreaTotals = { events: 0, decodeFailures: 0, transitions: 0 };
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
          `${grand.transitions - before.transitions} transitions`,
      );
      if (args.sleepMs > 0) await sleep(args.sleepMs);
    }

    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(
      `\nbackfill-s-class-bits: ${grand.events} events read, ` +
        `${grand.transitions} transitions ${args.execute ? "written" : "would be written"}, ` +
        `${grand.decodeFailures} undecodable, ${seconds}s`,
    );
    if (!args.execute) console.log("Dry run — nothing was written. Re-run with --execute.");
  } finally {
    await pool.end();
  }
}
