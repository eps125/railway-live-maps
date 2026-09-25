import { createPool } from "@railway/database";
import type { Pool } from "pg";
import type { Config } from "../config.js";

/**
 * `backfill-berth-activity` — one-shot (docs/IMPLEMENTATION_PLAN.md Milestone 72).
 *
 * Migration 0043 added `td_berth_daily_activity`, which `project-td` counts into from the moment
 * it first runs with that code (it records where in `td_berth_activity_cutover`). This fills the
 * days before that from the retained `td_berth_event` rows, so the Berth explorer can look back
 * over the whole history rather than only since the deploy.
 *
 * Counts only events at or before the cutover's `ingestion_sequence`, and writes them as
 * `source = 'backfill'` rows with absolute (not additive) per-day totals. The live projector only
 * ever counts events after the cutover, into `source = 'live'` rows, so the two never count the
 * same event and never touch each other's rows. That also makes this safe to run while
 * `projector-td` is running, and idempotent: a re-run recomputes the same totals.
 *
 * Works a UTC day at a time — whole days only, because a day's `backfill` row is overwritten with
 * that day's total — and within a day one TD area at a time, so every query is a range read on
 * `td_berth_event`'s `(td_area, event_at)` index. Days outer, areas inner, for the same cache
 * reason `backfill-s-class-bits` measured: all areas' rows for a period share heap pages.
 *
 * Dry run by default — pass `--execute` to write.
 *
 * Usage:
 *   backfill-berth-activity [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--area XX] [--sleep-ms 100]
 *                           [--execute]
 *
 * `--from` defaults to the first day any TD event was recorded; `--to` (inclusive) to the day
 * after the cutover was recorded — past the last day that can hold events the live counter didn't
 * see.
 */

const DEFAULT_SLEEP_MS = 100;

export interface BerthActivityBackfillArgs {
  /** Inclusive UTC dates, `YYYY-MM-DD`; null = the default described above. */
  from: string | null;
  to: string | null;
  area: string | null;
  sleepMs: number;
  execute: boolean;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Pure: argv → validated arguments. Exported for its own unit test. */
export function parseBerthActivityBackfillArgs(
  argv: string[],
): { ok: true; args: BerthActivityBackfillArgs } | { ok: false; error: string } {
  const from = flag(argv, "--from") ?? null;
  const to = flag(argv, "--to") ?? null;
  for (const [name, value] of [
    ["--from", from],
    ["--to", to],
  ] as const) {
    if (
      value !== null &&
      (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    ) {
      return { ok: false, error: `${name}: expected a date as YYYY-MM-DD, got "${value}"` };
    }
  }
  if (from !== null && to !== null && from > to) {
    return { ok: false, error: `--from ${from} is after --to ${to}` };
  }
  const area = flag(argv, "--area");
  if (area !== undefined && !/^[A-Za-z0-9]{2}$/.test(area)) {
    return { ok: false, error: `--area: expected a two-character TD area, got "${area}"` };
  }
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
      area: area ? area.toUpperCase() : null,
      sleepMs,
      execute: argv.includes("--execute"),
    },
  };
}

/** Pure: every UTC date from `from` to `to`, both inclusive, ascending. */
export function planDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (
    let t = Date.parse(`${from}T00:00:00Z`);
    t <= Date.parse(`${to}T00:00:00Z`);
    t += 86_400_000
  ) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Recounts one area's berth activity for one UTC day from `td_berth_event`, as of the cutover,
 * and overwrites that day's `backfill` rows with the totals. Returns the number of berths written.
 * Exported so the integration test drives the exact statement the command runs.
 */
export async function backfillBerthActivityDay(
  pool: Pool,
  tdArea: string,
  day: string,
  cutoverSequence: string,
): Promise<number> {
  const result = await pool.query(
    `insert into td_berth_daily_activity (
       td_area, activity_date, berth, source, events_in, events_out, first_event_at, last_event_at
     )
     select $1, $2::date, v.berth, 'backfill',
            count(*) filter (where v.direction = 'in')::int,
            count(*) filter (where v.direction = 'out')::int,
            min(e.event_at), max(e.event_at)
       from td_berth_event e
       cross join lateral (values (e.to_berth, 'in'), (e.from_berth, 'out')) as v(berth, direction)
      where e.td_area = $1
        and e.event_at >= $2::date::timestamp at time zone 'UTC'
        and e.event_at < ($2::date + 1)::timestamp at time zone 'UTC'
        and e.ingestion_sequence <= $3::bigint
        and v.berth is not null
      group by v.berth
     on conflict (td_area, activity_date, berth, source) do update set
       events_in = excluded.events_in,
       events_out = excluded.events_out,
       first_event_at = excluded.first_event_at,
       last_event_at = excluded.last_event_at,
       updated_at = now()`,
    [tdArea, day, cutoverSequence],
  );
  return result.rowCount ?? 0;
}

export async function runBackfillBerthActivity(config: Config, argv: string[]): Promise<void> {
  const parsed = parseBerthActivityBackfillArgs(argv);
  if (!parsed.ok) {
    console.error(`backfill-berth-activity: ${parsed.error}`);
    process.exitCode = 1;
    return;
  }
  const args = parsed.args;
  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const cutover = await pool.query<{ live_after_sequence: string; recorded_at: Date }>(
      "select live_after_sequence, recorded_at from td_berth_activity_cutover where id = 1",
    );
    const cut = cutover.rows[0];
    if (!cut) {
      console.error(
        "backfill-berth-activity: no cutover recorded yet — projector-td must process at least " +
          "one batch with the Milestone 72 code first, so it's known which events it counts.",
      );
      process.exitCode = 1;
      return;
    }
    // Every event at or before the cutover had been received by the time it was recorded, so its
    // event_at is no later than that day — plus one day of slack for timestamp skew around
    // midnight. Days past the cutover simply write nothing (the sequence filter excludes them).
    const firstDay = await pool.query<{ first_day: string | null }>(
      "select (min(first_event_at) at time zone 'UTC')::date::text as first_day from td_area_summary",
    );
    const cutoverDay = new Date(cut.recorded_at.getTime() + 86_400_000).toISOString().slice(0, 10);
    const from = args.from ?? firstDay.rows[0]?.first_day ?? null;
    const to = args.to ?? cutoverDay;
    if (from === null) {
      console.log(
        "backfill-berth-activity: no berth events at or before the cutover; nothing to do.",
      );
      return;
    }

    const areaRows = args.area
      ? [{ td_area: args.area }]
      : (
          await pool.query<{ td_area: string }>(
            "select td_area from td_area_summary where c_class_count > 0 order by td_area",
          )
        ).rows;
    const areas = areaRows.map((r) => r.td_area);
    const days = planDays(from, to);

    console.log(
      `backfill-berth-activity: ${args.execute ? "EXECUTE" : "DRY RUN (pass --execute to write)"}`,
    );
    console.log(
      `  cutover  ingestion_sequence ${cut.live_after_sequence} (recorded ${cut.recorded_at.toISOString()})`,
    );
    console.log(`  days     ${from} .. ${to} (${days.length}, UTC)`);
    console.log(`  areas    ${args.area ?? `${areas.length} (all with C-Class events)`}`);
    if (!args.execute) return;

    const started = Date.now();
    let written = 0;
    for (const day of days) {
      const dayStarted = Date.now();
      let dayWritten = 0;
      for (const area of areas) {
        dayWritten += await backfillBerthActivityDay(pool, area, day, cut.live_after_sequence);
      }
      written += dayWritten;
      console.log(
        `  ${day}  ${dayWritten} berth-day rows  ${((Date.now() - dayStarted) / 1000).toFixed(1)} s`,
      );
      if (args.sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, args.sleepMs));
    }
    console.log(
      `backfill-berth-activity: done — ${written} rows in ${((Date.now() - started) / 1000).toFixed(0)} s`,
    );
  } finally {
    await pool.end();
  }
}
