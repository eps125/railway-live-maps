import { shownDescription, type BerthInfo } from "./liveCells.js";
import type { BerthState } from "./types.js";

/** The train an open run popup is showing: the berth it was last seen in, and the headcode it
 * showed there when the popup was opened (or last followed). */
export interface FollowedTrain {
  elementId: string;
  headcode: string | null;
}

/** Where the popup's train is now. `lost` says the popup can no longer tell: `gone` when no berth
 * on the map shows the headcode (stepped off the map, or into an unmapped gap), `ambiguous` when
 * more than one does. A lost popup keeps showing what it last knew and stops asking the API. */
export interface FollowResult {
  elementId: string;
  lost: "gone" | "ambiguous" | null;
}

/**
 * 2026-10-30 (owner request): a popup is sticky — when its train steps, it moves with it rather
 * than closing. The train is followed by its headcode, with the same rule the delay colours use
 * to carry a band forward (`matchDelayBands`): it moves to another berth only when exactly one
 * berth on the map shows that headcode. Two berths showing it is never resolved by guessing
 * which train is which (CLAUDE.md rule 5); the popup says so and waits until only one does.
 * Uses what each berth *shows* (`shownDescription`), so an inhibited fringe twin never counts as
 * a second sighting.
 */
export function followTrain(
  followed: FollowedTrain,
  berths: Record<string, BerthState>,
  info: BerthInfo,
): FollowResult {
  const { elementId, headcode } = followed;
  if (!headcode) return { elementId, lost: null };
  const here = info.berths.get(elementId);
  if (here && shownDescription(here, berths) === headcode) return { elementId, lost: null };
  const showing: string[] = [];
  for (const [id, berth] of info.berths) {
    if (shownDescription(berth, berths) === headcode) showing.push(id);
  }
  if (showing.length === 1) return { elementId: showing[0]!, lost: null };
  return { elementId, lost: showing.length === 0 ? "gone" : "ambiguous" };
}

/** How far (map units) a station or labelled place may be from the train's berth to count as
 * "near" it: about four berth cells, so a station's name, drawn over its platforms, reaches the
 * berths along them. */
export const NEAR_PLACE_DISTANCE = 400;

/**
 * 2026-10-30 (owner): the places on the map near the popup's train, for the journey to say where
 * it is in place names rather than berth codes — the TIPLOCs of station and label elements that
 * carry one, within `NEAR_PLACE_DISTANCE` of `point` (the berth's centre), nearest first.
 */
export function nearbyPlaceTiplocs(
  point: { x: number; y: number },
  elements: Iterable<{ type: string; x?: number; y?: number; tiploc?: string }>,
  maxDistance = NEAR_PLACE_DISTANCE,
): string[] {
  const found: Array<{ tiploc: string; distance: number }> = [];
  for (const element of elements) {
    if (element.type !== "station" && element.type !== "label") continue;
    if (!element.tiploc || element.x === undefined || element.y === undefined) continue;
    const distance = Math.hypot(element.x - point.x, element.y - point.y);
    if (distance <= maxDistance) found.push({ tiploc: element.tiploc, distance });
  }
  found.sort((a, b) => a.distance - b.distance);
  return [...new Set(found.map((f) => f.tiploc))];
}
