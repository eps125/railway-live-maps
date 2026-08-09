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
}

const EMPTY_SUMMARY: ProjectResolverSummary = {
  newlyResolved: 0,
  retried: 0,
  matched: 0,
  ambiguous: 0,
  unmatched: 0,
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

/**
 * Candidate generation (docs/DATA_MODEL.md §8 evidence #1: exact signalling identity for the
 * occupancy's service date, never a run whose identity was superseded) plus the evidence signals
 * this MVP pass scores (#2 schedule-linked, #3 temporal plausibility via activated_at, #5 SMART/
 * STANOX correlation — see resolveBerthRun.ts's own doc comment for the full evidence-coverage
 * note, including #4/#6/#7's documented deferral).
 */
async function fetchCandidates(
  client: PoolClient,
  tdArea: string,
  berthCode: string,
  description: string,
  serviceDate: string,
  enteredAt: Date,
): Promise<RunCandidate[]> {
  const runs = await client.query<{
    id: string;
    schedule_id: string | null;
    activated_at: Date | null;
  }>(
    `select id, schedule_id, activated_at
     from train_run
     where signalling_id = $1 and service_date = $2 and lifecycle_state != 'superseded'`,
    [description, serviceDate],
  );
  if (runs.rows.length === 0) return [];

  const runIds = runs.rows.map((row) => row.id);
  const linkResult = await client.query<{ train_run_id: string; match_outcome: string }>(
    `select train_run_id, match_outcome from run_schedule_link where train_run_id = any($1::uuid[])`,
    [runIds],
  );
  const linkedRunIds = new Set(
    linkResult.rows.filter((row) => row.match_outcome === "matched").map((row) => row.train_run_id),
  );

  const smartResult = await client.query<{ stanox: string }>(
    `select distinct stanox from smart_berth_step
     where td_area = $1 and to_berth = $2 and stanox is not null`,
    [tdArea, berthCode],
  );
  const smartStanoxes = new Set(smartResult.rows.map((row) => row.stanox));

  const scheduleIds = runs.rows
    .map((row) => row.schedule_id)
    .filter((id): id is string => id !== null);
  const scheduleStanoxes = new Map<string, Set<string>>();
  if (scheduleIds.length > 0 && smartStanoxes.size > 0) {
    const locations = await client.query<{ schedule_id: string; stanox: string }>(
      `select schedule_id, stanox from schedule_location
       where schedule_id = any($1::bigint[]) and stanox is not null`,
      [scheduleIds],
    );
    for (const row of locations.rows) {
      const set = scheduleStanoxes.get(row.schedule_id) ?? new Set<string>();
      set.add(row.stanox);
      scheduleStanoxes.set(row.schedule_id, set);
    }
  }

  return runs.rows.map((run) => {
    const temporallyPlausible =
      run.activated_at !== null &&
      enteredAt.getTime() >= run.activated_at.getTime() &&
      enteredAt.getTime() - run.activated_at.getTime() <= MAX_JOURNEY_MS;
    const candidateStanoxes = run.schedule_id ? scheduleStanoxes.get(run.schedule_id) : undefined;
    const smartStanoxMatch =
      candidateStanoxes !== undefined &&
      [...smartStanoxes].some((stanox) => candidateStanoxes.has(stanox));

    return {
      trainRunId: run.id,
      hasMatchedSchedule: linkedRunIds.has(run.id),
      temporallyPlausible,
      smartStanoxMatch,
    };
  });
}

async function resolveOne(
  client: PoolClient,
  occupancy: OccupancyRow,
): Promise<"matched" | "ambiguous" | "unmatched"> {
  const serviceDate = computeServiceDate(occupancy.entered_at.toISOString());
  const candidates = await fetchCandidates(
    client,
    occupancy.td_area,
    occupancy.berth_code,
    occupancy.description,
    serviceDate,
    occupancy.entered_at,
  );
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

  for (;;) {
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
      let maxId = BigInt(lastId);
      for (const row of batch.rows) {
        const rowId = BigInt(row.id);
        if (rowId > maxId) maxId = rowId;
        const status = await resolveOne(client, row);
        summary.newlyResolved += 1;
        summary[status] += 1;
      }
      await advanceCheckpoint(client, definitionId, maxId.toString());
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
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
    for (const row of stale.rows) {
      const status = await resolveOne(retryClient, row);
      summary.retried += 1;
      summary[status] += 1;
    }
    await retryClient.query("commit");
  } catch (error) {
    await retryClient.query("rollback");
    throw error;
  } finally {
    retryClient.release();
  }

  return summary;
}
