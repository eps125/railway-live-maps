/**
 * Pure C-Class berth-step decision logic (docs/DATA_MODEL.md §4, docs/PROJECT_SPEC.md §7). No DB
 * I/O: the caller (apps/worker/src/td/projector.ts) fetches the current open-occupancy snapshot(s)
 * for the relevant berth(es) and executes the returned effects as SQL. Never rejects a valid event
 * because projected state is unexpected — mismatches become `recordAnomaly` effects, not errors.
 */

export interface OpenOccupancySnapshot {
  occupancyId: string;
  description: string;
  enteredAt: string;
}

export type BerthEffect =
  | { kind: "closeOccupancy"; berth: "from" | "to"; occupancyId: string; exitReason: string }
  | { kind: "openOccupancy"; berth: "to"; description: string; entryReason: string }
  | {
      kind: "recordAnomaly";
      anomalyCode: string;
      berth: "from" | "to" | null;
      details: Record<string, unknown>;
    };

export interface BerthReducerResult {
  effects: BerthEffect[];
}

export interface ApplyCAInput {
  fromBerth: string;
  toBerth: string;
  description: string;
  fromOpen: OpenOccupancySnapshot | null;
  toOpen: OpenOccupancySnapshot | null;
}

export interface ApplyCBInput {
  fromBerth: string;
  description: string;
  fromOpen: OpenOccupancySnapshot | null;
}

export interface ApplyCCInput {
  toBerth: string;
  description: string;
  toOpen: OpenOccupancySnapshot | null;
}

/** CA carries one `descr` shared by both halves of the step: the berth stepping out of `from`
 * is expected to already hold it. A missing or differing description is logged, not rejected. */
function checkFromMismatch(
  messageType: "CA" | "CB",
  fromBerth: string,
  description: string,
  fromOpen: OpenOccupancySnapshot | null,
): BerthEffect | null {
  if (fromOpen === null) {
    return {
      kind: "recordAnomaly",
      anomalyCode: "from_berth_empty",
      berth: "from",
      details: { messageType, fromBerth, expectedDescription: description },
    };
  }
  if (fromOpen.description !== description) {
    return {
      kind: "recordAnomaly",
      anomalyCode: "from_berth_description_mismatch",
      berth: "from",
      details: {
        messageType,
        fromBerth,
        expectedDescription: description,
        actualDescription: fromOpen.description,
      },
    };
  }
  return null;
}

/** CA berth step: close `from`, close-and-overwrite `to`, open `to` with `descr`. */
export function applyCA(input: ApplyCAInput): BerthReducerResult {
  const effects: BerthEffect[] = [];

  const mismatch = checkFromMismatch("CA", input.fromBerth, input.description, input.fromOpen);
  if (mismatch) effects.push(mismatch);
  if (input.fromOpen) {
    effects.push({
      kind: "closeOccupancy",
      berth: "from",
      occupancyId: input.fromOpen.occupancyId,
      exitReason: "stepped_out",
    });
  }

  if (input.toOpen) {
    effects.push({
      kind: "closeOccupancy",
      berth: "to",
      occupancyId: input.toOpen.occupancyId,
      exitReason: "overwritten_by_step",
    });
  }
  effects.push({
    kind: "openOccupancy",
    berth: "to",
    description: input.description,
    entryReason: "ca_step",
  });

  return { effects };
}

/** CB berth cancel: close `from`, record a mismatch if empty/different. No `to` involved. */
export function applyCB(input: ApplyCBInput): BerthReducerResult {
  const effects: BerthEffect[] = [];

  const mismatch = checkFromMismatch("CB", input.fromBerth, input.description, input.fromOpen);
  if (mismatch) effects.push(mismatch);
  if (input.fromOpen) {
    effects.push({
      kind: "closeOccupancy",
      berth: "from",
      occupancyId: input.fromOpen.occupancyId,
      exitReason: "cancelled",
    });
  }

  return { effects };
}

/** CC berth interpose: overwrite/open `to` with `descr`. No `from` involved, no mismatch check. */
export function applyCC(input: ApplyCCInput): BerthReducerResult {
  const effects: BerthEffect[] = [];

  if (input.toOpen) {
    effects.push({
      kind: "closeOccupancy",
      berth: "to",
      occupancyId: input.toOpen.occupancyId,
      exitReason: "overwritten_by_interpose",
    });
  }
  effects.push({
    kind: "openOccupancy",
    berth: "to",
    description: input.description,
    entryReason: "cc_interpose",
  });

  return { effects };
}
