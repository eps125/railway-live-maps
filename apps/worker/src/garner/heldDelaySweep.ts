import type { Pool } from "pg";
import {
  findHeldTrainCandidates,
  loadActiveEstimates,
  loadBerthAllowances,
  loadBerthStanoxes,
  loadCurrentBerthsForDescriptions,
  loadOpenTdFeedGaps,
  loadRunTrustStates,
  loadScheduleLocations,
  loadTiplocStanoxes,
  recordEstimateChanges,
  type EstimateChangeRow,
  type HeldTrainCandidate,
  type RunTrustState,
  type ScheduleLocationRow,
} from "@railway/database";
import {
  BERTH_ALLOWANCE_DEFAULT_MINUTES,
  decodeTrustMovementFlags,
  estimateHeldDelay,
  londonWallClockToInstant,
  nextRunEstimate,
  parseCifAllowanceMinutes,
  parseCifTimeToMinutes,
  scheduleDayOffset,
  signedVariationMinutes,
  type HeldDelayInput,
  type RunEstimateState,
} from "@railway/domain";

/** Reference data the sweep keeps between ticks: schedules don't change under a running train,
 * SMART and CORPUS change at most daily, allowances only when an admin recalculates them. */
const SCHEDULE_CACHE_MS = 60 * 60 * 1000;
const REFERENCE_CACHE_MS = 10 * 60 * 1000;

export interface HeldDelayContext {
  now: Date;
  trust: RunTrustState | undefined;
  locations: readonly ScheduleLocationRow[];
  tiplocStanox: ReadonlyMap<string, string>;
  berthStanoxes: readonly string[];
  berthAllowanceMinutes: number | undefined;
  feedGapAreas: ReadonlySet<string | null>;
  sameDescriptionBerths: ReadonlyArray<{ tdArea: string; berth: string; eventAt: Date }>;
}

/**
 * Milestone 97b (docs/adr/0021): turns one held-train candidate and the data read for it into
 * `estimateHeldDelay`'s input. Pure, so the schedule-position rules are unit-tested.
 *
 *  - The berth's location in the schedule is the first visit to one of its SMART STANOXes at or
 *    after the last TRUST report's location (strictly after it if that report was a departure or
 *    pass from there: that visit is done).
 *  - Allowances "still ahead" are those recorded at the last reported location and at every
 *    later location before the next one with a STANOX (where TRUST would report next). An
 *    allowance belongs to the section after its timing point (measured, ADR 0021 "Evidence").
 */
export function buildHeldDelayInput(
  candidate: HeldTrainCandidate,
  ctx: HeldDelayContext,
): HeldDelayInput {
  const stanoxOf = (tiploc: string) => ctx.tiplocStanox.get(tiploc) ?? null;
  const berthStanoxes = new Set(ctx.berthStanoxes);
  const raw = ctx.trust?.latestReport ?? null;

  let lastReport: HeldDelayInput["lastReport"] = null;
  let lastReportSeq: number | null = null;
  let leftReportedLocation = false;
  if (raw) {
    const decoded = decodeTrustMovementFlags(raw.flags);
    const hasMinutes =
      typeof raw.timetableVariation === "number" && Number.isFinite(raw.timetableVariation);
    const minutesLate =
      !hasMinutes && (decoded.variation === "late" || decoded.variation === "early")
        ? null
        : decoded.variation === "off_route"
          ? null
          : signedVariationMinutes(raw.timetableVariation, decoded.variation);
    lastReport = {
      minutesLate,
      actualAt: raw.actualAt,
      kind: decoded.eventKind,
      terminated: decoded.terminated,
      atThisBerthLocation: raw.locStanox !== null && berthStanoxes.has(raw.locStanox),
    };
    const reported = ctx.locations.filter(
      (loc) => raw.locStanox !== null && stanoxOf(loc.tiploc) === raw.locStanox,
    );
    lastReportSeq = reported.length > 0 ? Math.min(...reported.map((loc) => loc.seqNo)) : null;
    leftReportedLocation = decoded.eventKind === "departure";
  }

  const berthLocation =
    ctx.locations.find((loc) => {
      const stanox = stanoxOf(loc.tiploc);
      if (stanox === null || !berthStanoxes.has(stanox)) return false;
      if (lastReportSeq === null) return true;
      return leftReportedLocation ? loc.seqNo > lastReportSeq : loc.seqNo >= lastReportSeq;
    }) ?? null;

  let timingPoint: HeldDelayInput["timingPoint"] = null;
  const atDestination = berthLocation?.recordIdentity === "LT";
  if (berthLocation && !atDestination) {
    const kind = berthLocation.departure ? "departure" : berthLocation.pass ? "pass" : null;
    const time = parseCifTimeToMinutes(berthLocation.departure ?? berthLocation.pass);
    if (kind && time !== null) {
      const originDeparture = parseCifTimeToMinutes(ctx.locations[0]?.departure ?? null);
      timingPoint = {
        kind,
        atOrigin: berthLocation.recordIdentity === "LO",
        bookedAt: londonWallClockToInstant(
          candidate.trafficDay,
          time,
          scheduleDayOffset(time, originDeparture, berthLocation.nextDay),
        ),
      };
    }
  }

  let allowancesAheadMinutes = 0;
  if (lastReportSeq !== null) {
    for (const loc of ctx.locations) {
      if (loc.seqNo < lastReportSeq) continue;
      if (loc.seqNo > lastReportSeq && stanoxOf(loc.tiploc) !== null) break;
      allowancesAheadMinutes +=
        parseCifAllowanceMinutes(loc.engineeringAllowance) +
        parseCifAllowanceMinutes(loc.pathingAllowance) +
        parseCifAllowanceMinutes(loc.performanceAllowance);
    }
  }

  const cancellation = ctx.trust?.latestCancellation ?? null;
  return {
    now: ctx.now,
    occupancyEnteredAt: candidate.enteredAt,
    lastReport,
    timingPoint,
    atDestination,
    berthAllowanceMinutes: ctx.berthAllowanceMinutes ?? BERTH_ALLOWANCE_DEFAULT_MINUTES,
    allowancesAheadMinutes,
    cancelled: cancellation !== null && cancellation.reinstate === 0,
    feedGap: ctx.feedGapAreas.has(null) || ctx.feedGapAreas.has(candidate.tdArea),
    seenElsewhere: ctx.sameDescriptionBerths.some(
      (other) =>
        !(other.tdArea === candidate.tdArea && other.berth === candidate.berth) &&
        other.eventAt.getTime() > candidate.enteredAt.getTime(),
    ),
  };
}

export interface HeldDelaySweepResult {
  candidates: number;
  activeEstimates: number;
  changesRecorded: number;
  /** Runs whose shown band may have changed, for the delay push. */
  changedTrustIds: string[];
}

class TimedCache<V> {
  private readonly entries = new Map<string, { value: V; at: number }>();
  constructor(private readonly ttlMs: number) {}
  get(key: string, now: number): V | undefined {
    const entry = this.entries.get(key);
    if (!entry || now - entry.at > this.ttlMs) return undefined;
    return entry.value;
  }
  set(key: string, value: V, now: number): void {
    this.entries.set(key, { value, at: now });
  }
  prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.at > this.ttlMs) this.entries.delete(key);
    }
  }
}

/**
 * Milestone 97b (docs/adr/0021): `ingest-garner`'s held-train sweep, run every tick after the
 * TRUST delay-band projection. Works out each mapped, linked train's estimate and records a row
 * only when a run's estimated band changes or its estimate ends — so a quiet tick writes nothing.
 * Per-run state is the table itself (restart-safe); the in-memory `lastEstimatedAt` only sharpens
 * "has TRUST reported since this estimate was last produced" while the process lives.
 */
export class HeldDelaySweep {
  private readonly schedules = new TimedCache<ScheduleLocationRow[]>(SCHEDULE_CACHE_MS);
  private readonly tiplocStanox = new TimedCache<string | null>(REFERENCE_CACHE_MS);
  private readonly berthStanoxes = new TimedCache<string[]>(REFERENCE_CACHE_MS);
  private readonly allowances = new TimedCache<number | null>(REFERENCE_CACHE_MS);
  private readonly lastEstimatedAt = new Map<string, Date>();

  async run(
    pool: Pool,
    berths: ReadonlyArray<{ tdArea: string; berth: string }>,
    now: Date = new Date(),
  ): Promise<HeldDelaySweepResult> {
    const nowMs = now.getTime();
    const all = await findHeldTrainCandidates(pool, berths);
    // One decision per run: where it is now (its newest occupancy).
    const byRun = new Map<string, HeldTrainCandidate>();
    for (const candidate of all) {
      const existing = byRun.get(candidate.trustId);
      if (!existing || candidate.enteredAt > existing.enteredAt) {
        byRun.set(candidate.trustId, candidate);
      }
    }
    const candidates = [...byRun.values()];
    const result: HeldDelaySweepResult = {
      candidates: candidates.length,
      activeEstimates: 0,
      changesRecorded: 0,
      changedTrustIds: [],
    };
    if (candidates.length === 0) return result;

    const runs = candidates.map((c) => ({ trustId: c.trustId, activatedAt: c.activatedAt }));
    const [trust, active, feedGapAreas, sameDescription] = await Promise.all([
      loadRunTrustStates(pool, runs),
      loadActiveEstimates(pool, runs),
      loadOpenTdFeedGaps(pool, now),
      loadCurrentBerthsForDescriptions(pool, [...new Set(candidates.map((c) => c.description))]),
    ]);
    await this.fillReferenceCaches(pool, candidates, nowMs);

    const changes: EstimateChangeRow[] = [];
    for (const candidate of candidates) {
      const key = `${candidate.tdArea}|${candidate.berth}`;
      const locations = this.schedules.get(candidate.cifScheduleId, nowMs) ?? [];
      const tiplocStanox = new Map<string, string>();
      for (const loc of locations) {
        const stanox = this.tiplocStanox.get(loc.tiploc, nowMs);
        if (stanox) tiplocStanox.set(loc.tiploc, stanox);
      }
      const runTrust = trust.get(candidate.trustId);
      const input = buildHeldDelayInput(candidate, {
        now,
        trust: runTrust,
        locations,
        tiplocStanox,
        berthStanoxes: this.berthStanoxes.get(key, nowMs) ?? [],
        berthAllowanceMinutes: this.allowances.get(key, nowMs) ?? undefined,
        feedGapAreas,
        sameDescriptionBerths: sameDescription.get(candidate.description) ?? [],
      });

      let previous: RunEstimateState | null = active.get(candidate.trustId) ?? null;
      const remembered = this.lastEstimatedAt.get(candidate.trustId);
      if (previous && remembered && remembered > previous.lastEstimatedAt) {
        previous = { ...previous, lastEstimatedAt: remembered };
      }
      const step = nextRunEstimate(
        previous,
        estimateHeldDelay(input),
        runTrust?.latestReceivedAt ?? null,
        now,
      );
      if (step.state) {
        result.activeEstimates += 1;
        this.lastEstimatedAt.set(candidate.trustId, step.state.lastEstimatedAt);
      } else {
        this.lastEstimatedAt.delete(candidate.trustId);
      }
      if (!step.change) continue;
      const base = {
        trustId: candidate.trustId,
        activatedAt: candidate.activatedAt,
        tdArea: candidate.tdArea,
        berth: candidate.berth,
        occupancyId: candidate.occupancyId,
        occupancyEnteredAt: candidate.enteredAt,
        effectiveAt: now,
      };
      changes.push(
        step.change.kind === "set"
          ? {
              ...base,
              band: step.change.state.band,
              minutesLate: step.change.state.minutesLate,
              basis: step.change.state.basis,
              clearReason: null,
            }
          : {
              ...base,
              band: "cleared",
              minutesLate: null,
              basis: null,
              clearReason: step.change.reason,
            },
      );
    }

    result.changesRecorded = await recordEstimateChanges(pool, changes);
    result.changedTrustIds = [...new Set(changes.map((c) => c.trustId))];
    // Forget runs no longer held anywhere we look.
    for (const trustId of this.lastEstimatedAt.keys()) {
      if (!byRun.has(trustId)) this.lastEstimatedAt.delete(trustId);
    }
    return result;
  }

  private async fillReferenceCaches(
    pool: Pool,
    candidates: readonly HeldTrainCandidate[],
    nowMs: number,
  ): Promise<void> {
    this.schedules.prune(nowMs);
    this.tiplocStanox.prune(nowMs);
    this.berthStanoxes.prune(nowMs);
    this.allowances.prune(nowMs);

    const missingSchedules = [
      ...new Set(
        candidates.map((c) => c.cifScheduleId).filter((id) => !this.schedules.get(id, nowMs)),
      ),
    ];
    if (missingSchedules.length > 0) {
      const loaded = await loadScheduleLocations(pool, missingSchedules);
      for (const id of missingSchedules) this.schedules.set(id, loaded.get(id) ?? [], nowMs);
    }

    const tiplocs = new Set<string>();
    for (const c of candidates) {
      for (const loc of this.schedules.get(c.cifScheduleId, nowMs) ?? []) {
        if (this.tiplocStanox.get(loc.tiploc, nowMs) === undefined) tiplocs.add(loc.tiploc);
      }
    }
    if (tiplocs.size > 0) {
      const loaded = await loadTiplocStanoxes(pool, [...tiplocs]);
      for (const tiploc of tiplocs)
        this.tiplocStanox.set(tiploc, loaded.get(tiploc) ?? null, nowMs);
    }

    const missingBerths = [
      ...new Map(
        candidates
          .filter((c) => this.berthStanoxes.get(`${c.tdArea}|${c.berth}`, nowMs) === undefined)
          .map((c) => [`${c.tdArea}|${c.berth}`, { tdArea: c.tdArea, berth: c.berth }]),
      ).values(),
    ];
    if (missingBerths.length > 0) {
      const [stanoxes, allowances] = await Promise.all([
        loadBerthStanoxes(pool, missingBerths),
        loadBerthAllowances(pool, missingBerths),
      ]);
      for (const { tdArea, berth } of missingBerths) {
        const key = `${tdArea}|${berth}`;
        this.berthStanoxes.set(key, stanoxes.get(key) ?? [], nowMs);
        this.allowances.set(key, allowances.get(key) ?? null, nowMs);
      }
    }
  }
}
