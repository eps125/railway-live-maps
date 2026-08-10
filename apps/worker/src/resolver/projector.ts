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

export { RESOLVER_VERSION };
export const RESOLVER_PROJECTION_NAME = "berth-run-resolver";

const DEFAULT_BATCH_SIZE = 200;
/** Caps how much of a large backlog one invocation processes before returning. Without this, the
 * very first run after deploying this projector against an already-large nationwide
 * `berth_occupancy` history (every TD area, since go-live) would work through the entire backlog
 * in one call — the Portainer `projector` service's loop invokes this command fresh every cycle
 * and doesn't print anything until the call returns, so a long first run looks indistinguishable
 * from a hang, and blocks project-td/project-vstp/project-trust (the lines after it in that loop)
 * from running the whole time. Capping batches per invocation means each loop cycle makes bounded,
 * visible progress (a `project-resolver complete: {...}` line every ~1s) instead of one silent
 * multi-minute-or-longer call — the backlog just takes several cycles to fully drain instead of one. */
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
interface BatchCandidateData {
  /** Key: `${signallingId}|${serviceDate}`. */
  trainRunsByKey: Map<string, TrainRunCandidateRow[]>;
  /** train_run ids whose activation has a matched schedule link. */
  linkedRunIds: Set<string>;
  /** Key: `${tdArea}|${berthCode}`. */
  smartStanoxesByAreaBerth: Map<string, Set<string>>;
  /** Key: schedule id. */
  scheduleStanoxes: Map<string, Set<string>>;
}

/**
 * Candidate generation (docs/DATA_MODEL.md §8 evidence #1: exact signalling identity for the
 * occupancy's service date, never a run whose identity was superseded) plus the evidence signals
 * this MVP pass scores (#2 schedule-linked, #3 temporal plausibility via activated_at, #5 SMART/
 * STANOX correlation — see resolveBerthRun.ts's own doc comment for the full evidence-coverage
 * note, including #4/#6/#7's documented deferral).
 *
 * Fetches for the **whole batch at once** — a fixed 4 queries regardless of how many occupancies
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

  return { trainRunsByKey, linkedRunIds, smartStanoxesByAreaBerth, scheduleStanoxes };
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
      smartStanoxMatch,
    };
  });
}

async function resolveOne(
  client: PoolClient,
  occupancy: OccupancyRow,
  serviceDate: string,
  data: BatchCandidateData,
): Promise<"matched" | "ambiguous" | "unmatched"> {
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

  return result.status;
}

/** Resolves every occupancy in `rows` against one shared `fetchBatchCandidateData` call. */
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
    const status = await resolveOne(client, row, serviceDate, data);
    summary[countAs] += 1;
    summary[status] += 1;
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
 * No advisory lock (unlike project-td): every write here is an idempotent per-occupancy upsert
 * with no cross-row dependency a concurrent run could interleave badly with (project-td's lock
 * exists specifically because closeOccupancy depends on another row's *prior* effect being
 * committed — nothing here reads one occupancy's resolution to decide another's). The Portainer
 * `projector` service's loop also only ever runs one project-* command at a time regardless.
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
