import type { LiveDeltaMessage } from "@railway/protocol";
import type { BerthChange } from "@railway/domain";
// `berthChangesForEvent` moved to `@railway/domain` in Milestone 10 so the API's point-in-time
// playback `/events` endpoint reuses the same CA/CB/CC → berth-change semantics. Re-exported
// here so existing worker imports (`projector.ts`, `liveProjector.ts`, tests) are unchanged.
export { berthChangesForEvent, type BerthChange, type TdBerthEventInput } from "@railway/domain";

export interface MapBinding {
  mapSlug: string;
  elementId: string;
}

/** Pure: turns one berth change into the delta message for every map that binds it — a berth
 * can legitimately appear on more than one published map. `sequence` is the source
 * td_berth_event's real `ingestion_sequence`, so these deltas tie back to true nationwide
 * event order (unlike the polling adapter's best-effort local counter). */
export function buildDeltaMessages(
  change: BerthChange,
  bindings: MapBinding[],
  sequence: number,
): Array<{ mapSlug: string; message: LiveDeltaMessage }> {
  return bindings.map(({ mapSlug, elementId }) => ({
    mapSlug,
    message:
      change.description === null
        ? {
            type: "berth.cleared" as const,
            sequence,
            eventAt: change.eventAt,
            elementId,
            tdArea: change.tdArea,
            berth: change.berth,
          }
        : {
            type: "berth.updated" as const,
            sequence,
            eventAt: change.eventAt,
            elementId,
            tdArea: change.tdArea,
            berth: change.berth,
            description: change.description,
            enteredAt: change.eventAt,
          },
  }));
}
