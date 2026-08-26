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
import { BERTH_OCCUPANCY_WRITE_LOCK_KEY } from "../shared/advisoryLock.js";

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

export interface ProjectResolverOptions {
  batchSize?: number;
  /** Overrides MAX_BATCHES_PER_RUN — exposed mainly so tests can prove the cap/resume behavior
   * without seeding thousands of rows. */
  maxBatchesPerRun?: number;
  /** Clears every berth_run_resolution row and the denormalized berth_occupancy columns, then
   * reprocesses every occupancy from scratch. */
  rebuild?: boolean;
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
}

const EMPTY_SUMMARY: ProjectResolverSummary = {
  newlyResolved: 0,
  retried: 0,
  matched: 0,
  ambiguous: 0,
  unmatched: 0,
  moreBacklogRemains: false,
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
 * this pass scores (#2 schedule-linked, #3 temporal plausibility via activated_at, #4 continuity
 * from a preceding occupancy, #5 SMART/STANOX correlation — see resolveBerthRun.ts's own doc
 * comment for the full evidence-coverage note, including #6/#7's documented deferral).
 *
 * Fetches for the **whole batch at once** — a fixed 5 queries regardless of how many occupancies
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

    return {
      trainRunId: run.id,
      hasMatchedSchedule: data.linkedRunIds.has(run.id),
      temporallyPlausible,
      recentContinuity: run.id === continuityRunId && !continuitySuppressedByFresherCandidate,
      smartStanoxMatch,
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
 * Turns berth occupancies into resolved (or explicitly not-resolved) train runs
 * (docs/IMPLEMENTATION_PLAN.md Milestone 9). Two phases per invocation:
 *
 * 1. Checkpointed forward scan over newly-created `berth_occupancy` rows (same shape as
 *    project-td's main loop) — every occupancy gets resolved exactly once as it appears.
 * 2. A bounded retry pass over still-**open** occupancies whose last resolution wasn't `matched`
 *    and is older than `RETRY_INTERVAL_MS` — not checkpointed (it revisits rows below the
 *    checkpoint on purpose), naturally self-limiting since it only ever considers currently-open,
 *    still-unresolved occupancies rather than the full history.
 *
 * No self-exclusion advisory lock (unlike project-td): every write here is an idempotent
 * per-occupancy upsert with no *logical* cross-row dependency a concurrent run of this same
 * function could interleave badly with (project-td's self-lock exists specifically because
 * closeOccupancy depends on another row's *prior* effect being committed — nothing here reads one
 * occupancy's resolution to decide another's). The Portainer `projector-resolver` service's loop
 * also only ever runs one invocation of this command at a time regardless.
 *
 * Each batch transaction below DOES take `BERTH_OCCUPANCY_WRITE_LOCK_KEY`
 * (`pg_advisory_xact_lock`) before writing to `berth_occupancy` — a real production deadlock
 * (40P01) on 2026-08-14 against project-td, both updating overlapping `berth_occupancy` rows in
 * different orders within their own multi-row transactions (this projector's main-phase batch
 * updates in ascending `id` order; the retry phase below in `decided_at` order — neither matches
 * project-td's TD-message-arrival order). Postgres deadlocks are possible here even with zero
 * logical dependency between the rows, purely from row-lock acquisition order — see
 * `apps/worker/src/shared/advisoryLock.ts`'s doc comment.
 */
export async function runProjectResolver(
  pool: Pool,
  options: ProjectResolverOptions = {},
): Promise<ProjectResolverSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatchesPerRun = options.maxBatchesPerRun ?? MAX_BATCHES_PER_RUN;
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

    const batch = await pool.query<OccupancyRow>(
      `select id, entered_at, td_area, berth_code, description
       from berth_occupancy
       where projection_version = $1 and id > $2
       order by id
       limit $3`,
      [TD_PROJECTION_VERSION, lastId, batchSize],
    );
    if (batch.rows.length === 0) break;

    const client = await pool.connect();
    try {
      await client.query("begin");
      // Prevents a real 40P01 deadlock against project-td's own berth_occupancy writes — see this
      // function's doc comment and apps/worker/src/shared/advisoryLock.ts. Released automatically
      // on commit/rollback below, never needs an explicit unlock.
      await client.query("select pg_advisory_xact_lock($1)", [BERTH_OCCUPANCY_WRITE_LOCK_KEY]);
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
    // See the main-phase batch transaction above for why.
    await retryClient.query("select pg_advisory_xact_lock($1)", [BERTH_OCCUPANCY_WRITE_LOCK_KEY]);
    const retryCutoff = new Date(Date.now() - RETRY_INTERVAL_MS);
    const stale = await retryClient.query<OccupancyRow>(
      `select bo.id, bo.entered_at, bo.td_area, bo.berth_code, bo.description
       from berth_occupancy bo
       join berth_run_resolution brr on brr.occupancy_id = bo.id
       where bo.projection_version = $1 and bo.left_at is null and brr.status != 'matched'
         and brr.decided_at < $2
       order by brr.decided_at asc
       limit $3`,
      [TD_PROJECTION_VERSION, retryCutoff, batchSize],
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
}
