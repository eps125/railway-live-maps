import type { Pool } from "pg";
import {
  findDayMismatchedOpenLinks,
  getMappedTdAreas,
  londonMinutesSinceMidnight,
  londonToday,
  repointLinkToRunDay,
  resolveFreshRunMatch,
  type DayMismatchedLink,
  type FreshResolutionResult,
} from "@railway/database";
import { trafficDayFromTrustId } from "@railway/domain";

/**
 * ADR 0008 amendment (2026-10-31): corrects run links a day out. An open occupancy whose linked
 * run is paired with an activation for another day (by its TRUST ID) is resolved again with the
 * unchanged resolver; the link moves only when the resolver now gives the same schedule on the
 * activation's day. Nothing else is ever touched: a correctly linked train has no mismatch, and a
 * re-resolution that disagrees in any way leaves the link as it is.
 *
 * Switched by `RUN_LINK_DAY_CORRECTION_ENABLED`; every move is recorded in
 * `run_link_day_correction` (migration 0064) so it can be undone.
 */

/** At most this many mismatched links are looked at per sweep. */
export const DAY_CORRECTION_BATCH_LIMIT = 200;
/** The same occupancy isn't re-resolved more often than this while it stays mismatched (until
 * midnight, say, for an activation made before it). */
export const DAY_CORRECTION_COOLDOWN_MS = 60_000;

export type DayCorrectionDecision =
  | { move: true; trafficDay: string }
  | {
      move: false;
      reason: "no_day_in_trust_id" | "not_matched" | "other_schedule" | "other_day" | "same_day";
    };

/** Pure: whether a fresh resolution justifies moving a mismatched link, and to which day. */
export function decideDayCorrection(
  link: Pick<DayMismatchedLink, "cifScheduleId" | "trafficDay" | "trustId" | "activatedAt">,
  fresh: Pick<FreshResolutionResult, "matchStatus" | "effectiveRow" | "trafficDay" | "matchBasis">,
): DayCorrectionDecision {
  const activationDay = trafficDayFromTrustId(link.trustId, link.activatedAt);
  if (activationDay === null) return { move: false, reason: "no_day_in_trust_id" };
  if (activationDay === link.trafficDay) return { move: false, reason: "same_day" };
  if (fresh.matchStatus !== "matched" || !fresh.effectiveRow || !fresh.matchBasis) {
    return { move: false, reason: "not_matched" };
  }
  if (fresh.effectiveRow.id !== link.cifScheduleId)
    return { move: false, reason: "other_schedule" };
  if (fresh.trafficDay !== activationDay) return { move: false, reason: "other_day" };
  return { move: true, trafficDay: activationDay };
}

export function createDayCorrectionCooldown(): Map<string, number> {
  return new Map();
}

export interface DayCorrectionSummary {
  mismatched: number;
  checked: number;
  moved: number;
}

export async function sweepDayMismatchedLinks(
  pool: Pool,
  scope: "mapped" | "nationwide",
  cooldown: Map<string, number>,
  now: Date = new Date(),
): Promise<DayCorrectionSummary> {
  const summary: DayCorrectionSummary = { mismatched: 0, checked: 0, moved: 0 };
  const areas = scope === "mapped" ? [...(await getMappedTdAreas(pool))] : null;
  if (areas && areas.length === 0) return summary;
  const links = await findDayMismatchedOpenLinks(pool, areas, DAY_CORRECTION_BATCH_LIMIT);
  summary.mismatched = links.length;
  if (links.length === 0) return summary;

  const nowMs = now.getTime();
  for (const [key, at] of cooldown) {
    if (nowMs - at > 24 * 60 * 60_000) cooldown.delete(key);
  }
  const today = londonToday(now);
  const nowMinutes = londonMinutesSinceMidnight(now);

  for (const link of links) {
    const key = `${link.occupancyId}:${link.enteredAt.toISOString()}:${link.trustId}`;
    const last = cooldown.get(key);
    if (last !== undefined && nowMs - last < DAY_CORRECTION_COOLDOWN_MS) continue;
    cooldown.set(key, nowMs);
    summary.checked += 1;

    const fresh = await resolveFreshRunMatch(pool, {
      tdArea: link.tdArea,
      berth: link.berth,
      headcode: link.description,
      today,
      nowMinutes,
    });
    const decision = decideDayCorrection(link, fresh);
    if (!decision.move || !fresh.effectiveRow || !fresh.matchBasis) continue;

    const moved = await repointLinkToRunDay(pool, link, {
      cifScheduleId: fresh.effectiveRow.id,
      cifTrainUid: fresh.effectiveRow.cif_train_uid,
      trafficDay: decision.trafficDay,
      matchBasis: fresh.matchBasis,
      matchConfidence: fresh.isSolidMatch ? "solid" : "weak",
      tdArea: link.tdArea,
      berth: link.berth,
    });
    if (!moved) continue;
    summary.moved += 1;
    console.log(
      JSON.stringify({
        event: "run_link_day_corrected",
        tdArea: link.tdArea,
        berth: link.berth,
        description: link.description,
        trustId: link.trustId,
        fromRun: link.trainRunId,
        fromDay: link.trafficDay,
        toRun: moved.newTrainRunId,
        toDay: decision.trafficDay,
        newRunCreated: moved.newRunCreated,
        matchBasis: fresh.matchBasis,
      }),
    );
  }
  return summary;
}
