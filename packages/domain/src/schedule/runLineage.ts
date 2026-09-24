/**
 * Milestone 39 (docs/adr/0007): pure decision logic for sticky run-lineage matching. No DB I/O —
 * the caller (`apps/worker/src/runLineage/projector.ts`, `apps/api/src/routes/currentRun.ts`)
 * fetches whatever state these functions need and applies the verdict as SQL.
 */

export type RunMatchBasisExtended =
  | "trust_activation"
  | "stp_precedence"
  | "station_berth_timetable"
  | "headcode_only"
  | "step_chain"
  | "boundary_correlated";

export type MatchConfidence = "solid" | "weak";

/** `headcode_only` is the one existing tier already labelled the weakest evidence (docs/adr/0006)
 * — everything else ADR 0006/0035 can produce is "solid". Used to seed a freshly-`resolved` run's
 * own confidence; inherited links are capped by `capInheritedConfidence` below instead. */
export function confidenceForBasis(basis: RunMatchBasisExtended): MatchConfidence {
  return basis === "headcode_only" ? "weak" : "solid";
}

/**
 * A `step_chain` (or `boundary_correlated`) link is only ever as strong as whatever match it
 * descended from — inheriting from a `headcode_only` match stays `headcode_only`/`weak`
 * downstream, never upgrades, even though the physical step itself is strong evidence (owner
 * decision, 2026-09-14: the step doesn't vouch for the *headcode identification* it's carrying
 * forward, only for physical continuity of whatever that identification already was).
 */
export function capInheritedConfidence(sourceConfidence: MatchConfidence): MatchConfidence {
  return sourceConfidence;
}

export interface StepChainInput {
  /** Whether the closing occupancy (`from_berth`) already had a resolved run link. */
  sourceHasLink: boolean;
  /** Whether the opening occupancy (`to_berth`) was opened by a genuine `CA` step
   * (`entry_reason = 'ca_step'`) rather than a fresh `CC` interpose. */
  isCleanStep: boolean;
  /** Whether a `feed_gap` for this TD area overlaps the step's event time. */
  duringFeedGap: boolean;
}

export type StepChainVerdict = { propagate: true } | { propagate: false; reason: string };

/**
 * Whether an occupancy transition qualifies for step-chain identity inheritance. Deliberately
 * conservative: anything that isn't a clean, gap-free `CA` step from an already-linked occupancy
 * resets to fresh resolution (owner decision, 2026-09-14 — this also covers portion joins/splits,
 * which never appear as a clean `CA` step in the first place and so fall through to "not a clean
 * step" here without any special-case code).
 */
export function evaluateStepChain(input: StepChainInput): StepChainVerdict {
  if (!input.isCleanStep) {
    return { propagate: false, reason: "not_a_clean_step" };
  }
  if (input.duringFeedGap) {
    return { propagate: false, reason: "feed_gap" };
  }
  if (!input.sourceHasLink) {
    return { propagate: false, reason: "source_unlinked" };
  }
  return { propagate: true };
}

export interface BoundaryCrossingInput {
  /** Unclaimed same-headcode occupancies at the entry berth within the crossing window. */
  candidateCount: number;
}

export type BoundaryCrossingVerdict =
  { status: "matched" } | { status: "ambiguous" } | { status: "none"; reason: string };

/**
 * Whether an already-matched run carries across an owner-curated TD-area boundary
 * (`td_area_boundary`). The curated berth pair is the evidence (owner decision, 2026-09-24,
 * docs/adr/0007 Milestone 69 addendum): the caller has already required the same headcode on both
 * sides and an entry close in time to the exit, so exactly one such entry inherits the run — no
 * TRUST or schedule corroboration. More than one is `ambiguous`, never a guess.
 */
export function evaluateBoundaryCrossing(input: BoundaryCrossingInput): BoundaryCrossingVerdict {
  if (input.candidateCount === 0) {
    return { status: "none", reason: "no_candidate" };
  }
  if (input.candidateCount > 1) {
    return { status: "ambiguous" };
  }
  return { status: "matched" };
}

export interface ResolvedRunIdentity {
  cifScheduleId: string;
  cifTrainUid: string;
  trafficDay: string;
}

/** Whether a freshly-resolved identity is the same physical run an occupancy is already linked
 * to (a no-op) or a genuinely different one (a correction — the caller should supersede the old
 * `train_run` row rather than silently leaving two live rows pointing at the same occupancy). */
export function isSameRunIdentity(a: ResolvedRunIdentity, b: ResolvedRunIdentity): boolean {
  return (
    a.cifScheduleId === b.cifScheduleId &&
    a.cifTrainUid === b.cifTrainUid &&
    a.trafficDay === b.trafficDay
  );
}
