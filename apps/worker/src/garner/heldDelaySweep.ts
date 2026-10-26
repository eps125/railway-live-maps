import type { Pool } from "pg";
import {
  buildHeldDelayInput,
  findHeldTrainCandidates,
  findHeldTrainCandidatesAt,
  loadOccupiedBerthsForDescriptionsAt,
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
import {
  ESTIMATE_CARRY_LIMIT_MINUTES,
  estimateHeldDelay,
  nextRunEstimate,
  type RunEstimateState,
} from "@railway/domain";

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

/** Milestone 97d: a backfill replay's per-run estimates, carried from minute to minute, with
 * the berth each run was last seen in (the lineage for the row that ends it). */
export type ReplayState = Map<string, { state: RunEstimateState; last: HeldTrainCandidate }>;

function rowBase(candidate: HeldTrainCandidate, at: Date) {
  return {
    trustId: candidate.trustId,
    activatedAt: candidate.activatedAt,
    tdArea: candidate.tdArea,
    berth: candidate.berth,
    occupancyId: candidate.occupancyId,
    occupancyEnteredAt: candidate.enteredAt,
    effectiveAt: at,
  };
}

function clearedRow(candidate: HeldTrainCandidate, at: Date, reason: string): EstimateChangeRow {
  return {
    ...rowBase(candidate, at),
    band: "cleared",
    minutesLate: null,
    basis: null,
    clearReason: reason,
  };
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

  /** One live tick: as things stand now, against the estimates recorded in the table. */
  async run(
    pool: Pool,
    berths: ReadonlyArray<{ tdArea: string; berth: string }>,
    now: Date = new Date(),
  ): Promise<HeldDelaySweepResult> {
    return this.step(pool, berths, now, { kind: "live" });
  }

  /**
   * Milestone 97d (docs/adr/0021): one minute of a backfill replay — the same decision as a live
   * tick, but with every input as it was known at `at` (occupancies covering it, TRUST reports
   * received by it) and each run's estimate carried in `state` rather than read back from the
   * table. Rows are recorded as `source = 'backfill'`, stamped `at`.
   */
  async replayStep(
    pool: Pool,
    berths: ReadonlyArray<{ tdArea: string; berth: string }>,
    at: Date,
    state: ReplayState,
  ): Promise<HeldDelaySweepResult> {
    return this.step(pool, berths, at, { kind: "replay", state });
  }

  /** Ends every estimate a replay still holds at the end of its window, so nothing it recorded
   * runs on into history it didn't replay. */
  async closeReplay(pool: Pool, state: ReplayState, at: Date): Promise<number> {
    const changes: EstimateChangeRow[] = [...state.values()].map(({ last }) =>
      clearedRow(last, at, "backfill_end"),
    );
    state.clear();
    return recordEstimateChanges(pool, changes, "backfill");
  }

  private async step(
    pool: Pool,
    berths: ReadonlyArray<{ tdArea: string; berth: string }>,
    now: Date,
    mode: { kind: "live" } | { kind: "replay"; state: ReplayState },
  ): Promise<HeldDelaySweepResult> {
    const nowMs = now.getTime();
    const replay = mode.kind === "replay" ? mode.state : null;
    const all = replay
      ? await findHeldTrainCandidatesAt(pool, berths, now)
      : await findHeldTrainCandidates(pool, berths);
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
    const changes: EstimateChangeRow[] = [];

    if (candidates.length > 0) {
      const runs = candidates.map((c) => ({ trustId: c.trustId, activatedAt: c.activatedAt }));
      const descriptions = [...new Set(candidates.map((c) => c.description))];
      const [trust, active, feedGapAreas, sameDescription] = await Promise.all([
        loadRunTrustStates(pool, runs, replay ? now : null),
        replay
          ? Promise.resolve(new Map<string, RunEstimateState>())
          : loadActiveEstimates(pool, runs),
        loadOpenTdFeedGaps(pool, now),
        replay
          ? loadOccupiedBerthsForDescriptionsAt(pool, descriptions, now)
          : loadCurrentBerthsForDescriptions(pool, descriptions),
      ]);
      await this.fillReferenceCaches(pool, candidates, nowMs);

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

        let previous: RunEstimateState | null;
        if (replay) {
          previous = replay.get(candidate.trustId)?.state ?? null;
        } else {
          previous = active.get(candidate.trustId) ?? null;
          const remembered = this.lastEstimatedAt.get(candidate.trustId);
          if (previous && remembered && remembered > previous.lastEstimatedAt) {
            previous = { ...previous, lastEstimatedAt: remembered };
          }
        }
        const next = nextRunEstimate(
          previous,
          estimateHeldDelay(input),
          runTrust?.latestReceivedAt ?? null,
          now,
        );
        if (next.state) {
          result.activeEstimates += 1;
          if (replay) replay.set(candidate.trustId, { state: next.state, last: candidate });
          else this.lastEstimatedAt.set(candidate.trustId, next.state.lastEstimatedAt);
        } else if (replay) {
          replay.delete(candidate.trustId);
        } else {
          this.lastEstimatedAt.delete(candidate.trustId);
        }
        if (!next.change) continue;
        changes.push(
          next.change.kind === "set"
            ? {
                ...rowBase(candidate, now),
                band: next.change.state.band,
                minutesLate: next.change.state.minutesLate,
                basis: next.change.state.basis,
                clearReason: null,
              }
            : clearedRow(candidate, now, next.change.reason),
        );
      }
    }

    if (replay) {
      // A run that has left every mapped berth is no longer looked at, so its estimate would
      // otherwise stand until the end of the window. End it where a live carry would have ended.
      for (const [trustId, held] of replay) {
        if (byRun.has(trustId)) continue;
        const idleMs = nowMs - held.state.lastEstimatedAt.getTime();
        if (idleMs > ESTIMATE_CARRY_LIMIT_MINUTES * 60_000) {
          changes.push(clearedRow(held.last, now, "carry_expired"));
          replay.delete(trustId);
        }
      }
    }

    result.changesRecorded = await recordEstimateChanges(
      pool,
      changes,
      replay ? "backfill" : "live",
    );
    result.changedTrustIds = [...new Set(changes.map((c) => c.trustId))];
    if (!replay) {
      // Forget runs no longer held anywhere we look.
      for (const trustId of this.lastEstimatedAt.keys()) {
        if (!byRun.has(trustId)) this.lastEstimatedAt.delete(trustId);
      }
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
