import type { Config } from "../config.js";
import { runRefreshReferenceData } from "./refreshReferenceData.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LondonWallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function londonPartsAt(date: Date): LondonWallClockParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * ms from `now` until the next `hour:minute` in Europe/London wall-clock time — same
 * Intl.DateTimeFormat technique as packages/domain/src/trust/serviceDate.ts's traffic-day
 * boundary, so the daily refresh stays pinned to local clock time rather than drifting with UTC.
 *
 * Known limitation: projects today/tomorrow's target using the UTC offset in effect *right now*,
 * so a run scheduled within a few hours either side of the twice-yearly BST/GMT change can land
 * up to the DST delta (one hour) early or late on that specific day — self-corrects the following
 * day. Fine for a non-safety-critical daily reference-data refresh; not worth fully
 * transition-aware scheduling for this.
 */
export function msUntilNextLondonTime(now: Date, hour: number, minute: number): number {
  const parts = londonPartsAt(now);
  const offsetMs =
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    now.getTime();
  let target = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0) - offsetMs;
  if (target <= now.getTime()) {
    target += 24 * 60 * 60 * 1000;
  }
  return target - now.getTime();
}

function parseHourMinute(value: string): { hour: number; minute: number } {
  const [hourStr, minuteStr] = value.split(":");
  return { hour: Number(hourStr), minute: Number(minuteStr) };
}

/**
 * `schedule-reference-refresh` — long-running role that calls `runRefreshReferenceData` once a
 * day at `config.REFERENCE_DATA_REFRESH_TIME` (Europe/London), replacing the previous
 * download-schedule/download-smart/download-corpus manual-only workflow
 * (docs/IMPLEMENTATION_PLAN.md Milestone 7). Never resolves — matches the ingest-* long-running
 * roles. A failed refresh is logged, not thrown: one bad night must not crash-loop the container
 * and cost tomorrow's attempt too.
 */
export async function runScheduleReferenceRefresh(config: Config): Promise<never> {
  if (!config.SCHEDULE_DOWNLOAD_ENABLED) {
    throw new Error(
      "schedule-reference-refresh requires SCHEDULE_DOWNLOAD_ENABLED=true — see " +
        "docs/IMPLEMENTATION_PLAN.md Milestone 7.",
    );
  }

  const { hour, minute } = parseHourMinute(config.REFERENCE_DATA_REFRESH_TIME);

  for (;;) {
    const waitMs = msUntilNextLondonTime(new Date(), hour, minute);
    console.log(
      `schedule-reference-refresh: next run in ${Math.round(waitMs / 60000)} min ` +
        `(${config.REFERENCE_DATA_REFRESH_TIME} Europe/London)`,
    );
    await sleep(waitMs);
    try {
      await runRefreshReferenceData(config);
      console.log("schedule-reference-refresh: run complete");
    } catch (error) {
      console.error("schedule-reference-refresh: run failed", error);
    }
  }
}
