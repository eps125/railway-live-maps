/**
 * Whether a TRUST run's cancellation rules it out as the train now in a berth (owner-approved
 * 2026-10-26). Real incident that day: storm cancellations on Sunday 25 October (reason XW) left
 * yesterday's cancelled, never-moved runs "activated" inside the docs/adr/0008 [today, yesterday]
 * probe, so they tied with today's real train at the TRUST-activation tier — PX/CL link coverage
 * fell from ~80% to ~40% through the afternoon and delay colours went with it.
 *
 * `latest` is the run's most recent `trust_cancellation` row (a reinstatement is a row with
 * `reinstate <> 0`, so the latest row alone says whether a cancellation is still in effect):
 *  - whole-run cancellations (`AT ORIGIN`, `ON CALL`, `OUT OF PLAN`) rule the run out;
 *  - `EN ROUTE` (a part-cancellation, the train terminating short at `loc_stanox`) rules it out
 *    only when the run was resolved to yesterday, or the cancellation point comes strictly before
 *    this berth's calling point — today's train still on its way to that point is kept;
 *  - a reinstated run, or a type this rule doesn't know, is never evidence.
 */
export interface LatestTrustCancellation {
  type: string | null;
  reinstate: number;
}

const WHOLE_RUN_CANCELLATION_TYPES = new Set(["AT ORIGIN", "ON CALL", "OUT OF PLAN"]);

export function cancellationRulesOutRun(
  latest: LatestTrustCancellation | null,
  context: { resolvedToYesterday: boolean; cancelledBeforeBerth: boolean },
): boolean {
  if (!latest || Number(latest.reinstate) !== 0 || !latest.type) return false;
  const type = latest.type.trim().toUpperCase();
  if (WHOLE_RUN_CANCELLATION_TYPES.has(type)) return true;
  if (type === "EN ROUTE") return context.resolvedToYesterday || context.cancelledBeforeBerth;
  return false;
}
