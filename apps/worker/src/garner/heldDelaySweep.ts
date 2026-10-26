import type { Pool } from "pg";
import {
  buildHeldDelayInput,
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
  type ScheduleLocationRow,
} from "@railway/database";
import { estimateHeldDelay, nextRunEstimate, type RunEstimateState } from "@railway/domain";

/** Reference data the sweep keeps between ticks: schedules don't change under a running train,
 * SMART and CORPUS change at most daily, allowances only when an admin recalculates them. */
const SCHEDULE_CACHE_MS = 60 * 60 * 1000;
const REFERENCE_CACHE_MS = 10 * 60 * 1000;

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
