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

/** Owner request 2026-09-17: for a combined berth (docs/MAP_EDITOR_SPEC.md's berth section) — up
 * to 4 bindings sharing one elementId, for a split-berth permissive-working group — a change to
 * any ONE member must republish the full joined text across every currently-occupied member, not
 * just the member that moved. `buildDeltaMessages` itself has no DB access to look up siblings
 * (kept pure/fixture-driven), so the caller supplies the already-joined state per
 * `${mapSlug}|${elementId}` for any binding that is part of such a group; every other binding
 * (the overwhelming non-combined case) falls back to `change`'s own state, unchanged from before
 * this existed. */
export type CombinedBerthOverrides = Map<
  string,
  { description: string | null; enteredAt: string | null }
>;

/** Pure: turns one berth change into the delta message for every map that binds it — a berth
 * can legitimately appear on more than one published map. `sequence` is the source
 * td_berth_event's real `ingestion_sequence`, so these deltas tie back to true nationwide
 * event order (unlike the polling adapter's best-effort local counter). */
export function buildDeltaMessages(
  change: BerthChange,
  bindings: MapBinding[],
  sequence: number,
  combinedOverrides?: CombinedBerthOverrides,
): Array<{ mapSlug: string; message: LiveDeltaMessage }> {
  return bindings.map(({ mapSlug, elementId }) => {
    const override = combinedOverrides?.get(`${mapSlug}|${elementId}`);
    const description = override ? override.description : change.description;
    const enteredAt = override ? override.enteredAt : change.eventAt;
    return {
      mapSlug,
      message:
        description === null
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
              description,
              enteredAt: enteredAt ?? change.eventAt,
            },
    };
  });
}
