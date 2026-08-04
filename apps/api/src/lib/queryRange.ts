import { randomUUID } from "node:crypto";

/** docs/API_CONTRACT.md §6: "maximum history range per request: 7 days initially." */
export const MAX_HISTORY_RANGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

export interface ApiErrorBody {
  error: { code: string; message: string; requestId: string; details?: Record<string, unknown> };
}

/** docs/API_CONTRACT.md §5 error format. */
export function apiError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorBody {
  const requestId = randomUUID();
  return details
    ? { error: { code, message, requestId, details } }
    : { error: { code, message, requestId } };
}

export interface ParsedTimeRange {
  from: Date;
  to: Date;
}

export type TimeRangeResult =
  { ok: true; range: ParsedTimeRange } | { ok: false; error: ApiErrorBody };

/** Parses/validates `from`/`to` query params per docs/API_CONTRACT.md §6: bounded range, cursor
 * pagination expected alongside it. Defaults to the last `defaultRangeMs` up to now when either
 * bound is omitted. */
export function parseTimeRange(
  query: { from?: string; to?: string },
  defaultRangeMs: number = MAX_HISTORY_RANGE_MS,
): TimeRangeResult {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - defaultRangeMs);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return {
      ok: false,
      error: apiError("INVALID_TIME_RANGE", "from/to must be valid ISO 8601 timestamps"),
    };
  }
  if (from.getTime() > to.getTime()) {
    return { ok: false, error: apiError("INVALID_TIME_RANGE", "from must not be after to") };
  }
  if (to.getTime() - from.getTime() > MAX_HISTORY_RANGE_MS) {
    return {
      ok: false,
      error: apiError(
        "INVALID_TIME_RANGE",
        "the requested time range exceeds the permitted limit",
        {
          maxRangeMs: MAX_HISTORY_RANGE_MS,
        },
      ),
    };
  }
  return { ok: true, range: { from, to } };
}

/** Clamps a `limit` query param into [1, MAX_LIMIT], defaulting to DEFAULT_LIMIT when absent
 * or not a positive number. */
export function parseLimit(rawLimit: string | undefined): number {
  const parsed = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}
