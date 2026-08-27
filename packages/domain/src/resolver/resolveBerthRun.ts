/**
 * Milestone 9 (docs/DATA_MODEL.md §8 "Run resolver"). Pure: no DB I/O — the caller (
 * apps/worker/src/resolver/projector.ts) fetches every `train_run` candidate matching a berth
 * occupancy's description/service-date and passes them in, already annotated with whether each
 * piece of evidence applies. Mirrors packages/domain/src/schedule/resolveStpPrecedence.ts's
 * style exactly: pure scoring/decision logic, DB access lives entirely at the call site.
 *
 * A four-character description is only a candidate key (CLAUDE.md rule 5) — candidate
 * *generation* (exact signalling_id + service-date match) happens before this function is ever
 * called; this function only scores/ranks the candidates it's given and never hides ambiguity
 * (CLAUDE.md rule 7): every candidate considered is returned, not just the winner.
 *
 * Evidence weights follow docs/DATA_MODEL.md §8's descending-importance ordering for the signals
 * this pass implements (exact signalling match is the candidate-generation gate itself, not
 * scored here):
 *   2. Activation directly linked to a valid schedule for the service date.
 *   3. Temporal plausibility around booked and actual times.
 *   4. Continuity from preceding berth occupancy/run links.
 *   5. SMART berth/STANOX evidence.
 * Evidence #6 (map/corridor coverage — satisfied instead via SMART/STANOX grounding, see the M9
 * plan's design-decisions note) and #7 (operator/direction consistency, no ground truth to
 * compare against without map/corridor context) remain documented known limitations, not
 * implemented in this pass.
 *
 * #4 (continuity) was added 2026-08-10 after observing that every occupancy was being scored
 * from scratch with no memory of the same physical train's immediately preceding, already-
 * `matched` occupancy: whenever SMART berth/STANOX coverage (evidence #5) happened to be missing
 * for exactly one berth in an otherwise-unbroken journey, a routine tie between two same-headcode
 * candidates went unbroken for that single step, flipping a confidently-tracked train to
 * `ambiguous` for one berth before immediately recovering. Continuity evidence — the specific
 * train_run_id a *different*, already-`matched` occupancy of the same description resolved to
 * very recently — fixes this without weakening rule 5: it never trusts the raw four-character
 * description alone, only an already-decided resolver outcome.
 *
 * `movementCorrelation` was added 2026-08-27 after observing genuine same-day headcode reuse
 * (two real `2C84` workings, different origins) tie at schedule-linked + temporal + SMART with
 * no continuity to break it — because both of the weaker signals it stacks are coarse: temporal
 * plausibility is only a 24h day-window on `activated_at` (`origin_departure_at` is never
 * populated), and SMART/STANOX evidence matches a candidate schedule's STANOX set *anywhere on
 * its route*, so any two `2C84`s that both traverse Lancaster both score it. Movement correlation
 * is the live-truth form of both: the candidate run's *own* TRUST movement stream places it at a
 * STANOX that SMART-correlates to *this exact berth*, within minutes of the occupancy — actual
 * reported times, this location specifically. It is the single strongest non-identity signal
 * available (only one of two same-headcode trains is physically reporting movements past
 * Lancaster at 20:03), so it carries the highest weight: enough to break a tie on its own, not
 * so much that a single wrong SMART berth→STANOX row silently overrides every other signal.
 * Still never trusts the bare description — it is gated on the candidate set (exact signalling
 * identity + service date) exactly like every other signal here.
 *
 * Weights/thresholds are a versioned, tunable MVP starting point (docs/DATA_MODEL.md §8:
 * "Thresholds belong in versioned resolver configuration and tests") — bump RESOLVER_VERSION
 * whenever they change, since stored `berth_run_resolution` rows record which version produced
 * them.
 */
export const RESOLVER_VERSION = 3;

const SCHEDULE_LINKED_WEIGHT = 40;
const TEMPORAL_PLAUSIBILITY_WEIGHT = 35;
const CONTINUITY_WEIGHT = 30;
const SMART_STANOX_WEIGHT = 25;
/** Highest single weight — see the module doc comment. Strictly greater than any other single
 * weight so an otherwise-perfect tie between two same-headcode candidates resolves to whichever
 * one is actually reporting movements past this berth right now; not the sum of the others, so
 * it can't by itself outweigh a candidate that genuinely wins on every other signal. */
const MOVEMENT_CORRELATION_WEIGHT = 45;
const MAX_SCORE =
  SCHEDULE_LINKED_WEIGHT +
  TEMPORAL_PLAUSIBILITY_WEIGHT +
  CONTINUITY_WEIGHT +
  SMART_STANOX_WEIGHT +
  MOVEMENT_CORRELATION_WEIGHT;

export interface RunCandidate {
  trainRunId: string;
  /** run_schedule_link.match_outcome === 'matched' for this candidate's activation. */
  hasMatchedSchedule: boolean;
  /** The occupancy's entered_at falls within the candidate's schedule's plausible day window. */
  temporallyPlausible: boolean;
  /** A different, more recent occupancy of the same description resolved to this exact
   * train_run_id with status `matched` (bounded lookback window — see the caller). Evidence about
   * an already-decided resolver outcome, never about the raw description alone (rule 5). */
  recentContinuity: boolean;
  /** smart_berth_step ties this exact berth to a STANOX the candidate's schedule calls at. */
  smartStanoxMatch: boolean;
  /** The candidate run's own recent TRUST movement stream reported it at a STANOX that
   * smart_berth_step ties to *this exact berth*, within a bounded window of the occupancy's
   * entered_at (see the caller's MOVEMENT_CORRELATION_WINDOW_MS). Live-truth evidence about the
   * candidate run's own reported position, never about the raw description (rule 5). */
  movementCorrelation: boolean;
}

export interface ScoredCandidate {
  trainRunId: string;
  score: number;
  confidence: number;
  reasons: string[];
}

export type ResolveBerthRunResult =
  | {
      status: "matched";
      selectedTrainRunId: string;
      confidence: number;
      candidates: ScoredCandidate[];
    }
  | { status: "ambiguous"; candidates: ScoredCandidate[] }
  | { status: "unmatched"; candidates: ScoredCandidate[] };

function scoreCandidate(candidate: RunCandidate): ScoredCandidate {
  let score = 0;
  const reasons: string[] = [];
  if (candidate.hasMatchedSchedule) {
    score += SCHEDULE_LINKED_WEIGHT;
    reasons.push("activation linked to a matched schedule");
  }
  if (candidate.temporallyPlausible) {
    score += TEMPORAL_PLAUSIBILITY_WEIGHT;
    reasons.push("occupancy time falls within the schedule's plausible window");
  }
  if (candidate.recentContinuity) {
    score += CONTINUITY_WEIGHT;
    reasons.push("a preceding occupancy of the same description was just matched to this run");
  }
  if (candidate.smartStanoxMatch) {
    score += SMART_STANOX_WEIGHT;
    reasons.push("SMART berth-to-STANOX correlation matches a called STANOX");
  }
  if (candidate.movementCorrelation) {
    score += MOVEMENT_CORRELATION_WEIGHT;
    reasons.push("this run's own TRUST movement reports place it at this berth around this time");
  }
  return { trainRunId: candidate.trainRunId, score, confidence: score / MAX_SCORE, reasons };
}

/**
 * `matched` requires exactly one candidate strictly ahead of every other (an exact tie at the
 * top — including two candidates with zero evidence beyond the bare signalling-id match — is
 * `ambiguous`, not an arbitrary pick: CLAUDE.md rule 5's whole point is that two runs can
 * legitimately share a headcode). `unmatched` covers both "no candidates at all" and "every
 * candidate scored zero" (a signalling-id match alone is never enough evidence to claim a run).
 */
export function resolveBerthRun(candidates: RunCandidate[]): ResolveBerthRunResult {
  const scored = candidates.map(scoreCandidate).sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { status: "unmatched", candidates: [] };
  }

  const topScore = scored[0]!.score;
  if (topScore <= 0) {
    return { status: "unmatched", candidates: scored };
  }

  const topCandidates = scored.filter((candidate) => candidate.score === topScore);
  if (topCandidates.length > 1) {
    return { status: "ambiguous", candidates: scored };
  }

  const winner = scored[0]!;
  return {
    status: "matched",
    selectedTrainRunId: winner.trainRunId,
    confidence: winner.confidence,
    candidates: scored,
  };
}
