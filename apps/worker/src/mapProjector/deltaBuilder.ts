import type { LiveDeltaMessage } from "@railway/protocol";

/** What a single td_berth_event row (CA/CB/CC — CT never reaches td_berth_event, see
 * apps/worker/src/td/projector.ts) implies changed, independent of any map binding. A CA
 * step yields two changes (from clears, to updates); CB/CC yield one each. Pure — no map or
 * DB context here, that's `resolveDeltasForChanges`'s job. */
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

/** Pure: the berth state changes implied by one td_berth_event row. Mirrors the exact
 * semantics packages/domain/src/td/berthReducer.ts's applyCA/applyCB/applyCC encode for the
 * current-state projection, so this stays consistent with what berth_current_state actually
 * ends up holding. */
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
        description: input.description,
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
        description: input.description,
        eventAt: input.eventAt,
      });
    }
  }
  return changes;
}

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
            runSummary: null,
          },
  }));
}
