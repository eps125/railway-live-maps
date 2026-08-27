import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  getOrCreateProjectionDefinition,
  ensureCheckpoint,
  getCheckpoint,
  advanceCheckpoint,
  resetCheckpoint,
} from "@railway/database";
import {
  resolveBerthRun,
  RESOLVER_VERSION,
  computeServiceDate,
  TD_PROJECTION_VERSION,
  type RunCandidate,
} from "@railway/domain";
import { advisoryLockKey, BERTH_OCCUPANCY_WRITE_LOCK_KEY } from "../shared/advisoryLock.js";

export { RESOLVER_VERSION };
export const RESOLVER_PROJECTION_NAME = "berth-run-resolver";

const DEFAULT_BATCH_SIZE = 200;
/** Caps how much of a large backlog one invocation processes before returning. Without this, the
 * very first run after deploying this projector against an already-large nationwide
 * `berth_occupancy` history (every TD area, since go-live) would work through the entire backlog
 * in one call — the Portainer `projector-resolver` service's loop invokes this command fresh
 * every cycle and doesn't print anything until the call returns, so a long first run looks
 * indistinguishable from a hang. Originally this also blocked project-td/project-vstp/
 * project-trust, which shared this same loop; they've since moved to their own `projector-td`/
 * `projector-schedule` loops (2026-08-10/2026-08-11) specifically because this cap alone wasn't
 * tight enough to stop resolver's own internal batch loop from starving them of turns even within
 * this file. Capping batches per invocation means each loop cycle makes bounded, visible progress
 * (a `project-resolver complete: {...}` line every ~1s) instead of one silent multi-minute-or-
 * longer call — the backlog just takes several cycles to fully drain instead of one. */
const MAX_BATCHES_PER_RUN = 25;
/** How far apart resolution attempts must be for a still-open, not-yet-matched occupancy to be
 * retried — mirrors TRUST's own deferred-relink pass (a later-arriving activation can turn an
 * unmatched/ambiguous outcome into a matched one), bounded to open occupancies only so a
 * genuinely unresolvable closed occupancy isn't retried forever. */
const RETRY_INTERVAL_MS = 5 * 60 * 1000;
/** A berth occupancy can't plausibly belong to a run that hasn't activated yet, or one that
 * activated implausibly long ago — 24h is a generous upper bound for even the longest UK
 * freight/sleeper services. train_run.origin_departure_at is never actually populated yet (the
 * real TRUST activation field it should come from isn't wired up — apps/worker/src/trust/
 * projector.ts hardcodes it null), so activated_at is the only genuinely-populated timestamp
 * available for this check; that makes this a day-level plausibility signal, not per-calling-
 * point precision (schedule_location's own times are raw CIF-style text, not parsed timestamps). */
const MAX_JOURNEY_MS = 24 * 60 * 60 * 1000;
/** How far back a preceding occupancy of the same description **in the same TD area** can still
 * count as continuity evidence (resolveBerthRun.ts's `recentContinuity`). Real inter-berth timing
 * is seconds to low minutes even on a quiet corridor; 10 minutes is a generous bound that
 * comfortably covers gaps without reaching into an unrelated, much older occupancy that happens
 * to share a headcode.
 *
 * Confirmed live 2026-08-11 that a window alone isn't enough: a TD headcode gets set on a
 * stabled unit well before TRUST fires the corresponding activation (sometimes 1-2+ hours
 * ahead, for the unit's *next* working), so a real headcode can sit with zero matching
 * candidates for a long stretch — plenty of time for an unrelated earlier match (a genuinely
 * different real train that shared the same headcode hours earlier) to keep re-winning via
 * continuity, since nothing about the mechanism ever recognized reality had moved on. Two
 * changes address this: continuity is now scoped per (description, td_area) instead of
 * description alone (a nationwide-unscoped match let an occupancy in one TD area's continuity
 * chain feed into a same-description occupancy anywhere else in the country), and
 * buildCandidates below never lets continuity win over a candidate with a strictly more recent
 * `activatedAt` — a freshly-activated real train is stronger, more literal evidence that the
 * headcode has moved on than a self-reinforcing chain. Where neither signal clearly wins, the
 * honest result is `ambiguous`, not a confident guess (CLAUDE.md rule 7). */
const CONTINUITY_WINDOW_MS = 10 * 60 * 1000;
/** How close a candidate run's own TRUST movement report (by reported `loc_stanox`) must fall to
 * a berth occupancy's `entered_at` to count as live-position evidence that the headcode belongs
 * to that run (resolveBerthRun.ts's `movementCorrelation`). TRUST movement reports lag the
 * physical event by tens of seconds to a couple of minutes and TD/TRUST clocks aren't identical,
 * so this is deliberately looser than CONTINUITY_WINDOW_MS's inter-berth timing — but still far
 * tighter than the resolver's only other temporal signal (a 24h day-window on `activated_at`),
 * which is the whole point: two genuine same-day workings of one headcode are hours apart, so an
 * 8-minute window cleanly separates the one physically reporting past this berth now from the one
 * that isn't. Correlated only against the berth's own SMART `to_berth` STANOX set (already
 * fetched for evidence #5), never neighbouring berths — a deliberately conservative start. */
const MOVEMENT_CORRELATION_WINDOW_MS = 8 * 60 * 1000;

/** Advisory-lock name suffix for the backfill phase — a *separate* self-exclusion lock from the
 * normal loop's, so an operator-invoked `project-resolver --backfill` runs alongside the
 * 1-second Portainer `projector-resolver` loop instead of losing every turn to it. Their
 * per-batch berth_occupancy writes are still serialized by BERTH_OCCUPANCY_WRITE_LOCK_KEY, so
 * concurrency here is safe; it just means history catch-up makes progress in the gaps rather
 * than being starved. Two backfills still can't overlap each other (same suffix). */
const BACKFILL_LOCK_SUFFIX = ":backfill";

export interface ProjectResolverOptions {
  batchSize?: number;
  /** Overrides MAX_BATCHES_PER_RUN — exposed mainly so tests can prove the cap/resume behavior
   * without seeding thousands of rows. */
  maxBatchesPerRun?: number;
  /** Clears every berth_run_resolution row and the denormalized berth_occupancy columns, then
   * reprocesses every occupancy from scratch. Deliberately bypasses `liveWindowMs` — this is the
   * rare, explicit "reprocess the entire retained history" escape hatch. */
  rebuild?: boolean;
  /**
   * The normal (non-rebuild, non-backfill) forward scan and retry pass only consider occupancies
   * with `entered_at >= now() - liveWindowMs`. This is what keeps a `RESOLVER_VERSION` bump from
   * making the live map wait while the resolver grinds oldest-first through every retained day of
   * nationwide `berth_occupancy` before it ever reaches "now" (the forward scan is `id`-ordered,
   * so today is otherwise processed last). Ingestion and the TD/berth-occupancy projections stay
   * fully nationwide and unfiltered — only this downstream evidence-combining projection gets a
   * freshness window, and `--backfill` / `--rebuild` can still resolve older history on demand.
   *
   * Omitted ⇒ unbounded (every existing occupancy considered). The `project-resolver` command
   * always supplies a finite value from `RESOLVER_LIVE_WINDOW_HOURS`; tests that seed fixtures at
   * fixed historical dates rely on the unbounded default.
   */
  liveWindowMs?: number;
  /**
   * Backfill mode: instead of the checkpointed forward scan + retry pass, resolve every
   * occupancy with `entered_at >= backfillSince` that isn't already at `RESOLVER_VERSION` (a
   * left join against `berth_run_resolution`, no checkpoint bookkeeping — naturally resumable and
   * self-terminating). Bounded per invocation by `maxBatchesPerRun`; re-run until
   * `moreBacklogRemains` is false. Runs under its own advisory lock (see BACKFILL_LOCK_SUFFIX).
   */
  backfillSince?: Date;
}

export interface ProjectResolverSummary {
  newlyResolved: number;
  retried: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  /** True when this invocation stopped at MAX_BATCHES_PER_RUN with more backlog still waiting —
   * not an error, just "the next cycle will keep draining it." */
  moreBacklogRemains: boolean;
  /** True when this invocation did nothing because another runProjectResolver was already in
   * progress — not an error, just "try again next tick." See the self-exclusion lock note on
   * runProjectResolver below. */
  skippedLockContention: boolean;
}

const EMPTY_SUMMARY: ProjectResolverSummary = {
  newlyResolved: 0,
  retried: 0,
  matched: 0,
  ambiguous: 0,
  unmatched: 0,
  moreBacklogRemains: false,
  skippedLockContention: false,
};

interface OccupancyRow {
  id: string;
  entered_at: Date;
  td_area: string;
  berth_code: string;
  description: string;
}

function computeConfigHash(): string {
  return createHash("sha256").update(`resolver-v${RESOLVER_VERSION}`).digest("hex");
}

async function clearProjectionRows(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("delete from berth_run_resolution");
    await client.query(
      `update berth_occupancy set resolved_run_id = null, resolution_status = 'unmatched'
       where projection_version = $1`,
      [TD_PROJECTION_VERSION],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

interface TrainRunCandidateRow {
  id: string;
  scheduleId: string | null;
  activatedAt: Date | null;
}

/** Everything `resolveOne` needs to score every occupancy in the current batch, fetched with a
 * small, fixed number of queries regardless of batch size — see the module doc comment for why
 * this replaced a per-occupancy query loop. */
interface ContinuityEntry {
  enteredAt: Date;
  trainRunId: string;
}

interface BatchCandidateData {
  /** Key: `${signallingId}|${serviceDate}`. */
  trainRunsByKey: Map<string, TrainRunCandidateRow[]>;
  /** train_run ids whose activation has a matched schedule link. */
  linkedRunIds: Set<string>;
  /** Key: `${tdArea}|${berthCode}`. */
  smartStanoxesByAreaBerth: Map<string, Set<string>>;
  /** Key: schedule id. */
  scheduleStanoxes: Map<string, Set<string>>;
  /** Key: train_run id. Every `movement` TRUST report for that candidate run whose `event_at`
   * falls in the batch's `entered_at` span ± MOVEMENT_CORRELATION_WINDOW_MS, with the STANOX it
   * reported — the raw material for resolveBerthRun.ts's `movementCorrelation` signal. */
  movementStanoxesByRunId: Map<string, Array<{ stanox: string; eventAt: Date }>>;
  /** Key: `${description}|${tdArea}`. The most recent `matched` occupancy of that description in
   * that TD area seen so far — seeded from berth_run_resolution before the batch starts, then
   * kept current as resolveBatch resolves each occupancy in order, so continuity can chain
   * forward within one batch too. Scoped by area (not description alone) so a match in one part
   * of the country can never feed a same-description occupancy somewhere unrelated. */
  continuityByDescriptionArea: Map<string, ContinuityEntry>;
}

/**
 * Candidate generation (docs/DATA_MODEL.md §8 evidence #1: exact signalling identity for the
 * occupancy's service date, never a run whose identity was superseded) plus the evidence signals
 * this pass scores (#2 schedule-linked, #3 temporal plausibility via activated_at, #3b live
 * movement-report correlation — the candidate's own TRUST movement stream reporting past this
 * berth's SMART STANOX near the occupancy time, #4 continuity from a preceding occupancy, #5
 * SMART/STANOX correlation — see resolveBerthRun.ts's own doc comment for the full
 * evidence-coverage note, including #6/#7's documented deferral).
 *
 * Fetches for the **whole batch at once** — a fixed 6 queries regardless of how many occupancies
 * are in it, using the same `join (select unnest(...) ...) wanted` pattern
 * `apps/api/src/lib/liveState.ts`'s `computeLiveState` already established for this. A prior
 * version queried per-occupancy (up to 4 sequential round trips each), which was fine against
 * fixture-sized test data but effectively hung in production against the real nationwide
 * `berth_occupancy` backlog — hundreds of thousands of round trips on the very first run.
 */
async function fetchBatchCandidateData(
  client: PoolClient,
  occupancies: Array<{ row: OccupancyRow; serviceDate: string }>,
): Promise<BatchCandidateData> {
  const signallingIds: string[] = [];
  const serviceDates: string[] = [];
  const seenPairs = new Set<string>();
  for (const { row, serviceDate } of occupancies) {
    const pairKey = `${row.description}|${serviceDate}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);
    signallingIds.push(row.description);
    serviceDates.push(serviceDate);
  }

  const runs =
    signallingIds.length > 0
      ? await client.query<{
          id: string;
          schedule_id: string | null;
          activated_at: Date | null;
          signalling_id: string;
          service_date: string;
        }>(
          `select tr.id, tr.schedule_id, tr.activated_at, tr.signalling_id, tr.service_date::text as service_date
           from train_run tr
           join (select unnest($1::text[]) as signalling_id, unnest($2::date[]) as service_date) wanted
             on wanted.signalling_id = tr.signalling_id and wanted.service_date = tr.service_date
           where tr.lifecycle_state != 'superseded'`,
          [signallingIds, serviceDates],
        )
      : { rows: [] };

  const trainRunsByKey = new Map<string, TrainRunCandidateRow[]>();
  for (const run of runs.rows) {
    const key = `${run.signalling_id}|${run.service_date}`;
    const list = trainRunsByKey.get(key) ?? [];
    list.push({ id: run.id, scheduleId: run.schedule_id, activatedAt: run.activated_at });
    trainRunsByKey.set(key, list);
  }

  const runIds = runs.rows.map((run) => run.id);
  const linkResult =
    runIds.length > 0
      ? await client.query<{ train_run_id: string }>(
          `select train_run_id from run_schedule_link
           where train_run_id = any($1::uuid[]) and match_outcome = 'matched'`,
          [runIds],
        )
      : { rows: [] };
  const linkedRunIds = new Set(linkResult.rows.map((row) => row.train_run_id));

  // Live movement-report correlation (#3b). Every 'movement' TRUST event for any candidate run in
  // this batch, bounded to the batch's occupancy-time span widened by the correlation window on
  // both sides — one query for the whole batch, same shape as the others here. loc_stanox lives
  // in the raw event body (train_run_event has no normalized column for it); the
  // train_run_event_train_run_idx (train_run_id, event_at desc) index covers the filter.
  const enteredAtMsForMovement = occupancies.map(({ row }) => row.entered_at.getTime());
  const movementResult =
    runIds.length > 0
      ? await client.query<{ train_run_id: string; loc_stanox: string; event_at: Date }>(
          `select train_run_id, raw_event_json->'body'->>'loc_stanox' as loc_stanox, event_at
           from train_run_event
           where train_run_id = any($1::uuid[]) and trust_message_type = 'movement'
             and event_at >= $2 and event_at <= $3
             and raw_event_json->'body'->>'loc_stanox' is not null`,
          [
            runIds,
            new Date(Math.min(...enteredAtMsForMovement) - MOVEMENT_CORRELATION_WINDOW_MS),
            new Date(Math.max(...enteredAtMsForMovement) + MOVEMENT_CORRELATION_WINDOW_MS),
          ],
        )
      : { rows: [] };
  const movementStanoxesByRunId = new Map<string, Array<{ stanox: string; eventAt: Date }>>();
  for (const row of movementResult.rows) {
    const list = movementStanoxesByRunId.get(row.train_run_id) ?? [];
    list.push({ stanox: row.loc_stanox, eventAt: row.event_at });
    movementStanoxesByRunId.set(row.train_run_id, list);
  }

  const tdAreas: string[] = [];
  const berthCodes: string[] = [];
  const seenAreaBerths = new Set<string>();
  for (const { row } of occupancies) {
    const key = `${row.td_area}|${row.berth_code}`;
    if (seenAreaBerths.has(key)) continue;
    seenAreaBerths.add(key);
    tdAreas.push(row.td_area);
    berthCodes.push(row.berth_code);
  }

  const smartResult =
    tdAreas.length > 0
      ? await client.query<{ td_area: string; to_berth: string; stanox: string }>(
          `select sbs.td_area, sbs.to_berth, sbs.stanox
           from smart_berth_step sbs
           join (select unnest($1::text[]) as td_area, unnest($2::text[]) as to_berth) wanted
             on wanted.td_area = sbs.td_area and wanted.to_berth = sbs.to_berth
           where sbs.stanox is not null`,
          [tdAreas, berthCodes],
        )
      : { rows: [] };
  const smartStanoxesByAreaBerth = new Map<string, Set<string>>();
  for (const row of smartResult.rows) {
    const key = `${row.td_area}|${row.to_berth}`;
    const set = smartStanoxesByAreaBerth.get(key) ?? new Set<string>();
    set.add(row.stanox);
    smartStanoxesByAreaBerth.set(key, set);
  }

  const scheduleIds = [
    ...new Set(runs.rows.map((run) => run.schedule_id).filter((id): id is string => id !== null)),
  ];
  const scheduleStanoxes = new Map<string, Set<string>>();
  if (scheduleIds.length > 0) {
    // schedule_location.stanox is never populated for VSTP-sourced schedules (confirmed
    // 2026-08-10: apps/worker/src/vstp/projector.ts's real-message extraction only carries
    // tiploc, never stanox — the wire format itself doesn't include one) — VSTP is currently
    // the *only* source with any schedule data at all, so without this fallback SMART evidence
    // is architecturally unreachable regardless of how correct smart_berth_step is. Bridges via
    // CORPUS's tiploc->stanox mapping (location_reference) when the schedule's own stanox is
    // absent; prefers the schedule's own value when present (e.g. once real CIF SCHEDULE data,
    // which does carry stanox directly, is imported).
    const locations = await client.query<{ schedule_id: string; stanox: string }>(
      `select sl.schedule_id, coalesce(sl.stanox, lr.stanox) as stanox
       from schedule_location sl
       left join location_reference lr on lr.tiploc = sl.tiploc
       where sl.schedule_id = any($1::bigint[]) and coalesce(sl.stanox, lr.stanox) is not null`,
      [scheduleIds],
    );
    for (const row of locations.rows) {
      const set = scheduleStanoxes.get(row.schedule_id) ?? new Set<string>();
      set.add(row.stanox);
      scheduleStanoxes.set(row.schedule_id, set);
    }
  }

  const continuityDescriptions: string[] = [];
  const continuityAreas: string[] = [];
  const seenContinuityKeys = new Set<string>();
  for (const { row } of occupancies) {
    const key = `${row.description}|${row.td_area}`;
    if (seenContinuityKeys.has(key)) continue;
    seenContinuityKeys.add(key);
    continuityDescriptions.push(row.description);
    continuityAreas.push(row.td_area);
  }

  const continuityByDescriptionArea = new Map<string, ContinuityEntry>();
  if (continuityDescriptions.length > 0) {
    const enteredAts = occupancies.map(({ row }) => row.entered_at.getTime());
    const earliestNeeded = new Date(Math.min(...enteredAts) - CONTINUITY_WINDOW_MS);
    const latestNeeded = new Date(Math.max(...enteredAts));
    const continuityResult = await client.query<{
      description: string;
      td_area: string;
      entered_at: Date;
      selected_train_run_id: string;
    }>(
      `select bo.description, bo.td_area, bo.entered_at, brr.selected_train_run_id
       from berth_run_resolution brr
       join berth_occupancy bo on bo.id = brr.occupancy_id
       join (select unnest($1::text[]) as description, unnest($2::text[]) as td_area) wanted
         on wanted.description = bo.description and wanted.td_area = bo.td_area
       where brr.status = 'matched' and bo.entered_at >= $3 and bo.entered_at <= $4`,
      [continuityDescriptions, continuityAreas, earliestNeeded, latestNeeded],
    );
    for (const row of continuityResult.rows) {
      const key = `${row.description}|${row.td_area}`;
      const existing = continuityByDescriptionArea.get(key);
      if (!existing || row.entered_at.getTime() > existing.enteredAt.getTime()) {
        continuityByDescriptionArea.set(key, {
          enteredAt: row.entered_at,
          trainRunId: row.selected_train_run_id,
        });
      }
    }
  }

  return {
    trainRunsByKey,
    linkedRunIds,
    smartStanoxesByAreaBerth,
    scheduleStanoxes,
    movementStanoxesByRunId,
    continuityByDescriptionArea,
  };
}

function buildCandidates(
  occupancy: OccupancyRow,
  serviceDate: string,
  data: BatchCandidateData,
): RunCandidate[] {
  const runs = data.trainRunsByKey.get(`${occupancy.description}|${serviceDate}`) ?? [];
  const smartStanoxes =
    data.smartStanoxesByAreaBerth.get(`${occupancy.td_area}|${occupancy.berth_code}`) ??
    new Set<string>();
  const continuity = data.continuityByDescriptionArea.get(
    `${occupancy.description}|${occupancy.td_area}`,
  );
  const continuityRunId =
    continuity !== undefined &&
    continuity.enteredAt.getTime() < occupancy.entered_at.getTime() &&
    occupancy.entered_at.getTime() - continuity.enteredAt.getTime() <= CONTINUITY_WINDOW_MS
      ? continuity.trainRunId
      : null;
  const continuityRun = continuityRunId
    ? runs.find((run) => run.id === continuityRunId)
    : undefined;
  // A candidate whose own activation is more recent than the continuity-tracked run's is
  // stronger, more literal evidence that the headcode has moved on to a different real train —
  // see CONTINUITY_WINDOW_MS's doc comment for the real incident this fixes. Suppressing
  // continuity here (rather than just not applying it to the fresher candidate) means a
  // genuinely tied field of same-headcode candidates comes out `ambiguous`, not an arbitrary
  // pick of whichever candidate happens to be freshest.
  const continuitySuppressedByFresherCandidate =
    continuityRun?.activatedAt != null &&
    runs.some(
      (run) =>
        run.id !== continuityRun.id &&
        run.activatedAt !== null &&
        run.activatedAt.getTime() > continuityRun.activatedAt!.getTime(),
    );

  return runs.map((run) => {
    const temporallyPlausible =
      run.activatedAt !== null &&
      occupancy.entered_at.getTime() >= run.activatedAt.getTime() &&
      occupancy.entered_at.getTime() - run.activatedAt.getTime() <= MAX_JOURNEY_MS;
    const candidateStanoxes = run.scheduleId
      ? data.scheduleStanoxes.get(run.scheduleId)
      : undefined;
    const smartStanoxMatch =
      candidateStanoxes !== undefined &&
      [...smartStanoxes].some((stanox) => candidateStanoxes.has(stanox));

    // Live-truth (#3b): this run's own recent TRUST movement stream reported it at a STANOX that
    // SMART ties to *this berth*, within MOVEMENT_CORRELATION_WINDOW_MS of when the train stepped
    // into it. Needs the berth's SMART coverage to exist at all — no SMART STANOX for the berth
    // means nothing to correlate against, same precondition as smartStanoxMatch.
    const movementCorrelation =
      smartStanoxes.size > 0 &&
      (data.movementStanoxesByRunId.get(run.id) ?? []).some(
        (report) =>
          smartStanoxes.has(report.stanox) &&
          Math.abs(report.eventAt.getTime() - occupancy.entered_at.getTime()) <=
            MOVEMENT_CORRELATION_WINDOW_MS,
      );

    return {
      trainRunId: run.id,
      hasMatchedSchedule: data.linkedRunIds.has(run.id),
      temporallyPlausible,
      recentContinuity: run.id === continuityRunId && !continuitySuppressedByFresherCandidate,
      smartStanoxMatch,
      movementCorrelation,
    };
  });
}

async function resolveOne(
  client: PoolClient,
  occupancy: OccupancyRow,
  serviceDate: string,
  data: BatchCandidateData,
): Promise<{ status: "matched" | "ambiguous" | "unmatched"; selectedRunId: string | null }> {
  const candidates = buildCandidates(occupancy, serviceDate, data);
  const result = resolveBerthRun(candidates);
  const selectedRunId = result.status === "matched" ? result.selectedTrainRunId : null;
  const confidence = result.status === "matched" ? result.confidence : null;

  await client.query(
    `insert into berth_run_resolution (
       occupancy_id, occupancy_entered_at, status, selected_train_run_id, confidence,
       resolver_version, decided_at, candidates
     ) values ($1,$2,$3,$4,$5,$6, now(), $7)
     on conflict (occupancy_id) do update set
       status = excluded.status, selected_train_run_id = excluded.selected_train_run_id,
       confidence = excluded.confidence, resolver_version = excluded.resolver_version,
       decided_at = now(), candidates = excluded.candidates`,
    [
      occupancy.id,
      occupancy.entered_at,
      result.status,
      selectedRunId,
      confidence,
      RESOLVER_VERSION,
      JSON.stringify(result.candidates),
    ],
  );

  await client.query(
    `update berth_occupancy set resolved_run_id = $2, resolution_status = $3 where id = $1`,
    [occupancy.id, selectedRunId, result.status],
  );

  return { status: result.status, selectedRunId };
}

/** Resolves every occupancy in `rows` against one shared `fetchBatchCandidateData` call. Updates
 * `data.continuityByDescriptionArea` as each occupancy resolves so a `matched` result becomes
 * continuity evidence for the *next* occupancy of the same description/area later in this same
 * batch — without this, a long unbroken run of same-description steps landing in one batch could
 * only ever chain-heal from continuity seeded before the batch started, not from matches it just
 * made itself. */
async function resolveBatch(
  client: PoolClient,
  rows: OccupancyRow[],
  summary: ProjectResolverSummary,
  countAs: "newlyResolved" | "retried",
): Promise<void> {
  const withServiceDates = rows.map((row) => ({
    row,
    serviceDate: computeServiceDate(row.entered_at.toISOString()),
  }));
  const data = await fetchBatchCandidateData(client, withServiceDates);
  // Only take the shared cross-projector lock now, right before the actual berth_occupancy
  // writes below — fetchBatchCandidateData above is pure reads and never touches berth_occupancy
  // via UPDATE, so it doesn't need it. Confirmed 2026-08-27 in production that acquiring this lock
  // any earlier (immediately after BEGIN, before this read) seriously throttled project-td: under
  // real backlog load fetchBatchCandidateData's continuity-seed query can run for many seconds of
  // disk I/O, during which project-td's own batches were blocked waiting on a lock they had no
  // actual need to wait for yet — checkpoint commits went from sub-second apart to 16+ seconds
  // apart. See apps/worker/src/shared/advisoryLock.ts's doc comment for what this lock protects.
  await client.query("select pg_advisory_xact_lock($1)", [BERTH_OCCUPANCY_WRITE_LOCK_KEY]);
  for (const { row, serviceDate } of withServiceDates) {
    const { status, selectedRunId } = await resolveOne(client, row, serviceDate, data);
    summary[countAs] += 1;
    summary[status] += 1;
    if (status === "matched" && selectedRunId) {
      const key = `${row.description}|${row.td_area}`;
      const existing = data.continuityByDescriptionArea.get(key);
      if (!existing || row.entered_at.getTime() > existing.enteredAt.getTime()) {
        data.continuityByDescriptionArea.set(key, {
          enteredAt: row.entered_at,
          trainRunId: selectedRunId,
        });
      }
    }
  }
}

/**
 * Backfill phase (`project-resolver --backfill --since <date>`): resolve every occupancy with
 * `entered_at >= since` that isn't already at `RESOLVER_VERSION`, oldest `id` first. No checkpoint
 * — the `berth_run_resolution` left join *is* the progress marker (every processed row is stamped
 * with the current `resolver_version` by `resolveOne`, so it drops out of the next query),
 * which makes this naturally resumable across invocations and self-terminating once the range is
 * fully current. Bounded per invocation by `maxBatchesPerRun`, same as the main loop; re-run
 * until `moreBacklogRemains` is false. Writes still serialize with the live loop via
 * `BERTH_OCCUPANCY_WRITE_LOCK_KEY` inside `resolveBatch`.
 */
async function runBackfillPhase(
  pool: Pool,
  since: Date,
  batchSize: number,
  maxBatchesPerRun: number,
): Promise<ProjectResolverSummary> {
  const summary: ProjectResolverSummary = { ...EMPTY_SUMMARY };

  for (let batchesProcessed = 0; batchesProcessed < maxBatchesPerRun; batchesProcessed++) {
    const batch = await pool.query<OccupancyRow>(
      `select bo.id, bo.entered_at, bo.td_area, bo.berth_code, bo.description
       from berth_occupancy bo
       left join berth_run_resolution brr on brr.occupancy_id = bo.id
       where bo.projection_version = $1 and bo.entered_at >= $2
         and (brr.occupancy_id is null or brr.resolver_version is distinct from $3)
       order by bo.id
       limit $4`,
      [TD_PROJECTION_VERSION, since, RESOLVER_VERSION, batchSize],
    );
    if (batch.rows.length === 0) break;

    const client = await pool.connect();
    try {
      await client.query("begin");
      await resolveBatch(client, batch.rows, summary, "newlyResolved");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    if (batch.rows.length === batchSize && batchesProcessed === maxBatchesPerRun - 1) {
      summary.moreBacklogRemains = true;
    }
  }

  return summary;
}

/**
 * Turns berth occupancies into resolved (or explicitly not-resolved) train runs
 * (docs/IMPLEMENTATION_PLAN.md Milestone 9).
 *
 * With `options.backfillSince` set this instead runs `runBackfillPhase` (see there) under a
 * separate advisory lock and returns — the two phases below are the normal live-loop path.
 *
 * Two phases per normal invocation:
 *
 * 1. Checkpointed forward scan over newly-created `berth_occupancy` rows (same shape as
 *    project-td's main loop) — every occupancy gets resolved exactly once as it appears. Bounded
 *    to `entered_at >= now() - options.liveWindowMs` (unless `--rebuild`), so a RESOLVER_VERSION
 *    bump doesn't make the live map wait out an oldest-first pass over every retained nationwide
 *    day before reaching "now"; older history is caught up via `--backfill` on demand.
 * 2. A bounded retry pass over still-**open** occupancies whose last resolution wasn't `matched`
 *    and is older than `RETRY_INTERVAL_MS`, and that are still inside the same freshness window —
 *    not checkpointed (it revisits rows below the checkpoint on purpose), naturally self-limiting
 *    since it only ever considers currently-open, still-unresolved, still-recent occupancies
 *    rather than the full history.
 *
 * Takes a self-exclusion advisory lock for its entire run, same pattern as project-td (added
 * 2026-08-27): every write here is an idempotent per-occupancy upsert with no *logical* cross-row
 * dependency a concurrent run of this same function could interleave badly with, so this was
 * originally skipped on the theory that the Portainer `projector-resolver` service's own `while
 * true; do node dist/index.js project-resolver; sleep 1; done` loop already guarantees only one
 * invocation runs at a time. That guarantee only holds *within* one container's lifetime — a
 * redeploy doesn't guarantee the old container's process has fully exited before the new one's
 * loop starts, and this was confirmed live in production the same day: three concurrent
 * connections were observed all running this function's own batch-select query at once. The lock
 * makes that structurally impossible regardless of what triggers the overlap.
 *
 * Each batch (both phases, via `resolveBatch`) DOES take `BERTH_OCCUPANCY_WRITE_LOCK_KEY`
 * (`pg_advisory_xact_lock`) before writing to `berth_occupancy` — a real production deadlock
 * (40P01) on 2026-08-14 against project-td, both updating overlapping `berth_occupancy` rows in
 * different orders within their own multi-row transactions (this projector's main-phase batch
 * updates in ascending `id` order; the retry phase below in `decided_at` order — neither matches
 * project-td's TD-message-arrival order). Postgres deadlocks are possible here even with zero
 * logical dependency between the rows, purely from row-lock acquisition order — see
 * `apps/worker/src/shared/advisoryLock.ts`'s doc comment.
 *
 * The lock is taken inside `resolveBatch`, *after* `fetchBatchCandidateData` rather than at the
 * top of the transaction — confirmed 2026-08-27 in production that acquiring it any earlier
 * seriously throttles project-td, since `fetchBatchCandidateData`'s continuity-seed query can run
 * for many seconds of disk I/O under real backlog load and doesn't touch `berth_occupancy` via
 * UPDATE at all, so it never needed the lock's protection in the first place.
 */
export async function runProjectResolver(
  pool: Pool,
  options: ProjectResolverOptions = {},
): Promise<ProjectResolverSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatchesPerRun = options.maxBatchesPerRun ?? MAX_BATCHES_PER_RUN;
  const liveWindowMs = options.liveWindowMs ?? Number.POSITIVE_INFINITY;
  // `--rebuild` deliberately reprocesses the whole retained history; a non-finite window means
  // "no window" (the unbounded default / test fixtures at fixed historical dates). Either way,
  // collapse to the epoch so `entered_at >= $cutoff` is a no-op rather than a NULL/invalid param.
  const windowCutoff =
    options.rebuild || !Number.isFinite(liveWindowMs)
      ? new Date(0)
      : new Date(Date.now() - liveWindowMs);

  const isBackfill = options.backfillSince !== undefined;
  const lockKey = advisoryLockKey(
    isBackfill ? `${RESOLVER_PROJECTION_NAME}${BACKFILL_LOCK_SUFFIX}` : RESOLVER_PROJECTION_NAME,
  );
  const lockClient = await pool.connect();
  try {
    const lockResult = await lockClient.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [lockKey],
    );
    if (!lockResult.rows[0]?.locked) {
      return { ...EMPTY_SUMMARY, skippedLockContention: true };
    }

    if (isBackfill) {
      return await runBackfillPhase(
        pool,
        options.backfillSince as Date,
        batchSize,
        maxBatchesPerRun,
      );
    }

    const definitionId = await getOrCreateProjectionDefinition(
      pool,
      RESOLVER_PROJECTION_NAME,
      RESOLVER_VERSION,
      computeConfigHash(),
    );
    await ensureCheckpoint(pool, definitionId);

    if (options.rebuild) {
      await clearProjectionRows(pool);
      await resetCheckpoint(pool, definitionId);
    }

    const summary: ProjectResolverSummary = { ...EMPTY_SUMMARY };

    for (let batchesProcessed = 0; batchesProcessed < maxBatchesPerRun; batchesProcessed++) {
      const checkpoint = await getCheckpoint(pool, definitionId);
      const lastId = checkpoint?.lastIngestionSequence ?? "0";

      // `entered_at >= $4` keeps a RESOLVER_VERSION bump (fresh checkpoint at 0) from grinding
      // oldest-first through every retained nationwide day before reaching "now" — see
      // ProjectResolverOptions.liveWindowMs. Rows older than the window below an already-advanced
      // checkpoint stay on whatever resolver version last decided them until `--backfill` picks
      // them up; nothing is deleted.
      const batch = await pool.query<OccupancyRow>(
        `select id, entered_at, td_area, berth_code, description
         from berth_occupancy
         where projection_version = $1 and id > $2 and entered_at >= $4
         order by id
         limit $3`,
        [TD_PROJECTION_VERSION, lastId, batchSize, windowCutoff],
      );
      if (batch.rows.length === 0) break;

      const client = await pool.connect();
      try {
        await client.query("begin");
        const maxId = batch.rows.reduce((max, row) => {
          const rowId = BigInt(row.id);
          return rowId > max ? rowId : max;
        }, BigInt(lastId));
        await resolveBatch(client, batch.rows, summary, "newlyResolved");
        await advanceCheckpoint(client, definitionId, maxId.toString());
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }

      if (batch.rows.length === batchSize && batchesProcessed === maxBatchesPerRun - 1) {
        summary.moreBacklogRemains = true;
      }
    }

    const retryClient = await pool.connect();
    try {
      await retryClient.query("begin");
      const retryCutoff = new Date(Date.now() - RETRY_INTERVAL_MS);
      // Same freshness window as the forward scan: an occupancy still open (no clearing message)
      // days after it was entered is almost certainly stale, not genuinely awaiting a
      // later-arriving activation — stop retrying it forever.
      const stale = await retryClient.query<OccupancyRow>(
        `select bo.id, bo.entered_at, bo.td_area, bo.berth_code, bo.description
         from berth_occupancy bo
         join berth_run_resolution brr on brr.occupancy_id = bo.id
         where bo.projection_version = $1 and bo.left_at is null and brr.status != 'matched'
           and brr.decided_at < $2 and bo.entered_at >= $4
         order by brr.decided_at asc
         limit $3`,
        [TD_PROJECTION_VERSION, retryCutoff, batchSize, windowCutoff],
      );
      await resolveBatch(retryClient, stale.rows, summary, "retried");
      await retryClient.query("commit");
    } catch (error) {
      await retryClient.query("rollback");
      throw error;
    } finally {
      retryClient.release();
    }

    return summary;
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [lockKey]).catch(() => {});
    lockClient.release();
  }
}
