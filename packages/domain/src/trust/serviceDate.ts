/**
 * Pure traffic-day calculation (docs/IMPLEMENTATION_PLAN.md Milestone 8). UK rail convention
 * treats the traffic/service day as starting a few hours after local midnight, not at
 * midnight itself, so a late-running post-midnight service still belongs to the previous
 * timetable day. **The exact boundary hour below (03:00 Europe/London) is a documented
 * assumption, not a verified fact** — confirm against the real openraildata wiki page before
 * treating it as exact, same caveat style as the S-Class-decode gap.
 */
const SERVICE_DAY_BOUNDARY_HOUR = 3;

/** `eventAtIso` is a UTC ISO 8601 timestamp. Returns the traffic day as `YYYY-MM-DD`. Uses
 * `Intl.DateTimeFormat` for the London wall-clock read (correctly follows BST/GMT), then does
 * all day-arithmetic in UTC-epoch space via `Date.UTC`/`getUTC*` — deliberately avoids
 * `new Date(dateString)` local-timezone parsing, which silently shifts calendar dates by a day
 * depending on the host process's timezone (see apps/api/src/routes/schedule.ts's own fix for
 * the same class of bug). */
export function computeServiceDate(eventAtIso: string): string {
  const eventAt = new Date(eventAtIso);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(eventAt);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");

  const calendarDayUtcMs = Date.UTC(year, month - 1, day);
  const adjustedUtcMs =
    hour < SERVICE_DAY_BOUNDARY_HOUR ? calendarDayUtcMs - 24 * 60 * 60 * 1000 : calendarDayUtcMs;
  const adjusted = new Date(adjustedUtcMs);

  const yyyy = adjusted.getUTCFullYear();
  const mm = String(adjusted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(adjusted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
