import { NULL_DESCRIPTION } from "./berthReducer.js";

/**
 * Pure: what a single `td_berth_event` row (CA/CB/CC — CT never reaches `td_berth_event`) implies
 * changed for berth current-state, independent of any map binding. A CA step yields two changes
 * (`from` clears, `to` updates); CB/CC yield one each.
 *
 * Mirrors the exact semantics `berthReducer.ts`'s `applyCA`/`applyCB`/`applyCC` encode, so every
 * consumer — the worker's live/history projectors AND the API's point-in-time playback `/events`
 * endpoint (Milestone 10) — derives the same berth changes from the same event (CLAUDE.md
 * rule 13: one domain model, one set of state semantics). In particular, a `to`-berth description
 * of `NULL_DESCRIPTION` (see berthReducer.ts) is a signaller manually blanking the berth, not a
 * real headcode, and reports as `description: null` here exactly as `applyCA`/`applyCC` never
 * open an occupancy for it — otherwise live state and playback would disagree about whether the
 * berth is "occupied by ----".
 */
export interface BerthChange {
  tdArea: string;
  berth: string;
  /** null = the berth is now empty (a `berth.cleared` delta). */
  description: string | null;
  eventAt: string;
}

export interface TdBerthEventInput {
  messageType: "CA" | "CB" | "CC";
  tdArea: string;
  fromBerth: string | null;
  toBerth: string | null;
  description: string;
  eventAt: string;
}

export function berthChangesForEvent(input: TdBerthEventInput): BerthChange[] {
  const changes: BerthChange[] = [];
  if (input.messageType === "CA") {
    if (input.fromBerth) {
      changes.push({
        tdArea: input.tdArea,
        berth: input.fromBerth,
        description: null,
        eventAt: input.eventAt,
      });
    }
    if (input.toBerth) {
      changes.push({
        tdArea: input.tdArea,
        berth: input.toBerth,
        description: input.description === NULL_DESCRIPTION ? null : input.description,
        eventAt: input.eventAt,
      });
    }
  } else if (input.messageType === "CB") {
    if (input.fromBerth) {
      changes.push({
        tdArea: input.tdArea,
        berth: input.fromBerth,
        description: null,
        eventAt: input.eventAt,
      });
    }
  } else {
    if (input.toBerth) {
      changes.push({
        tdArea: input.tdArea,
        berth: input.toBerth,
        description: input.description === NULL_DESCRIPTION ? null : input.description,
        eventAt: input.eventAt,
      });
    }
  }
  return changes;
}
