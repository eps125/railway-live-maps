import type { Pool } from "pg";

/**
 * The S-Class explorer's per-bit activity (last change and change count over `?windowHours=`),
 * computed so a long window can't take the site down (incident 2026-10-22: the page refreshes
 * every 5 s, a 14-day R1 window read ~1.6 M scattered rows and took ~10 minutes, and the
 * overlapping requests piled up until the database's disk was saturated and maps stopped loading).
 *
 * - Activity on a whole UTC day that has finished never changes, so each settled day is counted
 *   once per area and kept. A window is the kept days plus at most two partial days at its ends,
 *   each no more than 24 h - the same cost as the default 24 h window.
 * - Requests for the same area and window share one computation; a finished one is reused for
 *   `ttlMs`.
 * - Only one activity query runs at a time across the whole API, each under a statement timeout.
 * - A request waits at most `waitMs` for the computation; anything still missing comes back as
 *   `complete: false` and is filled in by the computation carrying on in the background.
 */

export interface BitActivity {
  lastChangedAt: Date;
  changes: number;
}
/** Keyed `address:bit`. */
export type ActivityMap = Map<string, BitActivity>;

export interface ActivityRow {
  address: string;
  bit_index: number;
  last_changed_at: Date;
  changes: number;
}

const DAY_MS = 24 * 3_600_000;
/** A day is treated as final this long after it ends (late projector writes and backfills). */
const SETTLE_MS = 15 * 60_000;

/** Split `[from, to)` into whole UTC days that are settled at `now`, and the partial ranges left
 * at either end (each under a day). Pure. */
export function planActivityRanges(
  from: Date,
  to: Date,
  now: Date,
): { days: Date[]; ranges: Array<[Date, Date]> } {
  const days: Date[] = [];
  const ranges: Array<[Date, Date]> = [];
  if (to.getTime() <= from.getTime()) return { days, ranges };
  const firstDay = Math.ceil(from.getTime() / DAY_MS) * DAY_MS;
  let cursor = firstDay;
  while (cursor + DAY_MS <= to.getTime() && cursor + DAY_MS + SETTLE_MS <= now.getTime()) {
    days.push(new Date(cursor));
    cursor += DAY_MS;
  }
  if (days.length === 0) return { days, ranges: [[from, to]] };
  if (firstDay > from.getTime()) ranges.push([from, new Date(firstDay)]);
  if (cursor < to.getTime()) ranges.push([new Date(cursor), to]);
  return { days, ranges };
}

/** Combine activity from separate time ranges: latest change wins, counts add. Pure. */
export function mergeActivity(parts: ReadonlyArray<ActivityMap>): ActivityMap {
  const out: ActivityMap = new Map();
  for (const part of parts) {
    for (const [key, value] of part) {
      const seen = out.get(key);
      if (!seen) out.set(key, { ...value });
      else {
        seen.changes += value.changes;
        if (value.lastChangedAt > seen.lastChangedAt) seen.lastChangedAt = value.lastChangedAt;
      }
    }
  }
  return out;
}

export function activityFromRows(rows: ReadonlyArray<ActivityRow>): ActivityMap {
  return new Map(
    rows.map((row) => [
      `${row.address}:${row.bit_index}`,
      { lastChangedAt: row.last_changed_at, changes: row.changes },
    ]),
  );
}

export type ActivityQuery = (tdArea: string, from: Date, to: Date) => Promise<ActivityMap>;

export interface ActivityResult {
  activity: ActivityMap;
  /** False while some of the window is still being counted (the rest arrives on a later call). */
  complete: boolean;
}

export interface SClassActivityCacheOptions {
  now?: () => Date;
  /** How long a computed window is reused before it is recomputed. */
  ttlMs?: number;
  /** How long a request waits for the computation before answering with what is known. */
  waitMs?: number;
  /** Settled days kept per area (older ones are dropped). */
  keepDays?: number;
}

export class SClassActivityCache {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly waitMs: number;
  private readonly keepDays: number;
  /** area -> day start (ms) -> activity on that day. */
  private readonly days = new Map<string, Map<number, ActivityMap>>();
  /** area:hours -> the latest finished result. */
  private readonly results = new Map<string, { at: number; result: ActivityResult }>();
  /** area:hours -> the computation in progress. */
  private readonly inFlight = new Map<string, Promise<ActivityResult>>();
  /** Every activity query runs behind this one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly query: ActivityQuery,
    options: SClassActivityCacheOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 60_000;
    this.waitMs = options.waitMs ?? 5_000;
    this.keepDays = options.keepDays ?? 15;
  }

  async get(tdArea: string, windowHours: number): Promise<ActivityResult> {
    const key = `${tdArea}:${windowHours}`;
    const done = this.results.get(key);
    if (done && this.now().getTime() - done.at < this.ttlMs) return done.result;
    let running = this.inFlight.get(key);
    if (!running) {
      running = this.compute(tdArea, windowHours).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, running);
      running.then(
        (result) => this.results.set(key, { at: this.now().getTime(), result }),
        () => undefined,
      );
    }
    const timedOut = Symbol("timedOut");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const raced = await Promise.race([
      running,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), this.waitMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (raced !== timedOut) return raced;
    // Still counting: answer with the settled days already known, marked incomplete.
    const to = this.now();
    const plan = planActivityRanges(new Date(to.getTime() - windowHours * 3_600_000), to, to);
    const known = this.days.get(tdArea);
    const parts = plan.days.flatMap((day) => {
      const part = known?.get(day.getTime());
      return part ? [part] : [];
    });
    return { activity: done?.result.activity ?? mergeActivity(parts), complete: false };
  }

  private async compute(tdArea: string, windowHours: number): Promise<ActivityResult> {
    const to = this.now();
    const from = new Date(to.getTime() - windowHours * 3_600_000);
    const plan = planActivityRanges(from, to, to);
    const known = this.days.get(tdArea) ?? new Map<number, ActivityMap>();
    this.days.set(tdArea, known);
    const parts: ActivityMap[] = [];
    let complete = true;
    for (const day of plan.days) {
      let part = known.get(day.getTime());
      if (!part) {
        try {
          part = await this.serial(() => this.query(tdArea, day, new Date(day.getTime() + DAY_MS)));
          known.set(day.getTime(), part);
        } catch {
          complete = false;
          continue;
        }
      }
      parts.push(part);
    }
    for (const [rangeFrom, rangeTo] of plan.ranges) {
      try {
        parts.push(await this.serial(() => this.query(tdArea, rangeFrom, rangeTo)));
      } catch {
        complete = false;
      }
    }
    const oldest = to.getTime() - this.keepDays * DAY_MS;
    for (const day of known.keys()) if (day < oldest) known.delete(day);
    return { activity: mergeActivity(parts), complete };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** Statement timeout for one activity query (a day of a busy area takes well under this). */
const ACTIVITY_STATEMENT_TIMEOUT_MS = 120_000;

/** The database side: one range of one area, under a statement timeout. */
export function activityQuery(pool: Pool, projectionVersion: number): ActivityQuery {
  return async (tdArea, from, to) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`set local statement_timeout = ${ACTIVITY_STATEMENT_TIMEOUT_MS}`);
      // First-sight rows (previous_value null) are not changes - excluded.
      const result = await client.query<ActivityRow>(
        `select address, bit_index, max(event_at) as last_changed_at, count(*)::int as changes
           from td_s_bit_transition
          where projection_version = $1 and td_area = $2
            and event_at >= $3 and event_at < $4
            and previous_value is not null
          group by address, bit_index`,
        [projectionVersion, tdArea, from, to],
      );
      await client.query("commit");
      return activityFromRows(result.rows);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}
