import type { Pool } from "pg";

/** How far before `at` a since-closed feed gap is still worth surfacing on a point-in-time view.
 * A gap earlier the same session matters; one from last week does not tell you anything about
 * the instant you are looking at. Not yet configuration-driven (docs/ARCHITECTURE.md §9 lists
 * freshness/'gap' thresholds as a later setting). */
const GAP_LOOKBACK = "6 hours";

interface FeedGapRow {
  td_area: string | null;
  window_start: Date;
  window_end: Date | null;
  detection_reason: string;
  recoverability: "recoverable" | "unrecoverable" | "unknown";
  covers_at: boolean;
}

export interface FeedGapWarnings {
  /** Human-readable one-liners for `quality.gaps` (docs/API_CONTRACT.md §1). */
  gaps: string[];
  /** True when a gap's affected range actually contains `at` — the state at that instant is
   * suspect, so callers mark `quality.status = "stale"`. */
  coversAt: boolean;
}

function describe(row: FeedGapRow): string {
  const area = row.td_area ? ` ${row.td_area}` : "";
  const start = row.window_start.toISOString();
  const end = row.window_end ? row.window_end.toISOString() : "ongoing";
  return `TD${area} feed gap ${start}–${end} (${row.recoverability}; ${row.detection_reason})`;
}

/**
 * TD feed gaps (`feed_gap`) relevant to a map's areas at time `at` — an open gap, a gap covering
 * `at`, or one that closed within `GAP_LOOKBACK` before it. Shared by live `/state`, historical
 * `/state?at=` and the playback UI so recorder outages are always visible, never hidden
 * (docs/PROJECT_SPEC.md §11.8).
 */
export async function feedGapWarnings(
  pool: Pool,
  tdAreas: string[],
  at: Date,
): Promise<FeedGapWarnings> {
  const { rows } = await pool.query<FeedGapRow>(
    `select td_area,
            coalesce(affected_time_start, detected_start) as window_start,
            coalesce(affected_time_end, detected_end)     as window_end,
            detection_reason, recoverability,
            (coalesce(affected_time_start, detected_start) <= $2
             and (coalesce(affected_time_end, detected_end) is null
                  or coalesce(affected_time_end, detected_end) > $2)) as covers_at
       from feed_gap
      where feed_name = 'TD'
        and (td_area is null or td_area = any($1::text[]))
        and coalesce(affected_time_start, detected_start) <= $2
        and (coalesce(affected_time_end, detected_end) is null
             or coalesce(affected_time_end, detected_end) >= $2 - interval '${GAP_LOOKBACK}')
      order by window_start desc
      limit 20`,
    [tdAreas, at],
  );

  return {
    gaps: rows.map(describe),
    coversAt: rows.some((row) => row.covers_at),
  };
}
