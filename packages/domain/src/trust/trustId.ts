/**
 * TRUST's own 10-character train identity string encodes the run's *reporting headcode* within
 * it — confirmed against a real TRUST Change of Identity, 2026-09-17: `"426C02C417"` ->
 * `"420C02C417"` is headcode `6C02` -> `0C02`. Format: 2-digit start hour + this run's own
 * 4-character headcode + 2-character TOC + 2-digit day of month. The day-of-month component is
 * already relied on elsewhere in this codebase (`apps/api/src/routes/currentRun.ts` and
 * openrail's own `livetrain.c`/`liverail.c` both use `substring(trust_id FROM 9)`) — this is the
 * same format, just the headcode slice instead of the day-of-month one.
 *
 * docs/adr/0010: this matters beyond display. garner's `cif_schedules.signalling_id` is the
 * *originally booked* headcode and never retroactively updates, so once a Change of Identity
 * changes a run's headcode, the TD berth itself starts showing the *new* headcode while the
 * schedule stays keyed by the old one — a plain headcode search for the schedule then finds
 * nothing, or worse, a different, unrelated real train that genuinely carries the new headcode
 * elsewhere (CLAUDE.md rule 5's exact failure mode; confirmed against a real incident where this
 * silently produced a wrong match). `findSchedulesByIdentityHeadcodeChange`
 * (`packages/database/src/runResolution.ts`) uses this same encoding directly in SQL to close
 * that gap at the source; this function exists for callers needing it in TypeScript (display,
 * tests).
 */
export function headcodeFromTrustId(trustId: string): string | null {
  if (trustId.length !== 10) return null;
  return trustId.slice(2, 6);
}
