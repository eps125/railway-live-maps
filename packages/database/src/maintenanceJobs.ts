import { TD_PROJECTION_VERSION, berthAllowance } from "@railway/domain";
import type { Queryable } from "./checkpoint.js";

/**
 * Milestone 97a (docs/adr/0021): admin-run area maintenance jobs (`maintenance_job`, migration
 * 0053). The API queues them; the worker's `serve` role claims one at a time and runs it. Every
 * state change is a single guarded `update`, so two workers (or a worker and the API) can never
 * both move a job: the partial unique index on `status = 'running'` also stops two running at once.
 */
export const MAINTENANCE_JOB_KINDS = ["berth_allowances", "link_backfill"] as const;
export type MaintenanceJobKind = (typeof MAINTENANCE_JOB_KINDS)[number];
export type MaintenanceJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface MaintenanceJob {
  id: string;
  kind: MaintenanceJobKind;
  tdAreas: string[];
  params: Record<string, unknown>;
  status: MaintenanceJobStatus;
  cancelRequested: boolean;
  attempts: number;
  maxAttempts: number;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  requestedBy: string;
  requestedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

interface MaintenanceJobRow {
  id: string;
  kind: MaintenanceJobKind;
  td_areas: string[];
  params: Record<string, unknown>;
  status: MaintenanceJobStatus;
  cancel_requested: boolean;
  attempts: number;
  max_attempts: number;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  requested_by: string;
  requested_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const JOB_COLUMNS = `id::text as id, kind, td_areas, params, status, cancel_requested, attempts,
  max_attempts, progress, result, error, requested_by, requested_at, started_at, finished_at`;

function toJob(row: MaintenanceJobRow): MaintenanceJob {
  return {
    id: row.id,
    kind: row.kind,
    tdAreas: row.td_areas,
    params: row.params,
    status: row.status,
    cancelRequested: row.cancel_requested,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    progress: row.progress,
    result: row.result,
    error: row.error,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function enqueueMaintenanceJob(
  db: Queryable,
  job: {
    kind: MaintenanceJobKind;
    tdAreas: readonly string[];
    params?: Record<string, unknown>;
    requestedBy: string;
  },
): Promise<MaintenanceJob> {
  const { rows } = await db.query<MaintenanceJobRow>(
    `insert into maintenance_job (kind, td_areas, params, requested_by)
     values ($1, $2::text[], $3::jsonb, $4)
     returning ${JOB_COLUMNS}`,
    [job.kind, [...job.tdAreas], JSON.stringify(job.params ?? {}), job.requestedBy],
  );
  return toJob(rows[0] as MaintenanceJobRow);
}

export async function getMaintenanceJob(db: Queryable, id: string): Promise<MaintenanceJob | null> {
  const { rows } = await db.query<MaintenanceJobRow>(
    `select ${JOB_COLUMNS} from maintenance_job where id = $1`,
    [id],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

export async function listMaintenanceJobs(db: Queryable, limit = 50): Promise<MaintenanceJob[]> {
  const { rows } = await db.query<MaintenanceJobRow>(
    `select ${JOB_COLUMNS} from maintenance_job order by requested_at desc, id desc limit $1`,
    [limit],
  );
  return rows.map(toJob);
}

/** A queued job is cancelled straight away; a running one is asked to stop, which the runner
 * checks between steps. Returns the job as it now is, or `null` if it had already finished. */
export async function requestMaintenanceJobCancel(
  db: Queryable,
  id: string,
): Promise<MaintenanceJob | null> {
  const { rows } = await db.query<MaintenanceJobRow>(
    `update maintenance_job
        set status = case when status = 'queued' then 'cancelled' else status end,
            finished_at = case when status = 'queued' then now() else finished_at end,
            cancel_requested = true
      where id = $1 and status in ('queued', 'running')
      returning ${JOB_COLUMNS}`,
    [id],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

/** On worker start: any job still marked running was interrupted (a redeploy, a crash). Both job
 * kinds are idempotent, so it goes back in the queue unless it has used up its attempts. */
export async function requeueInterruptedMaintenanceJobs(
  db: Queryable,
): Promise<{ requeued: number; failed: number }> {
  const { rows } = await db.query<{ status: MaintenanceJobStatus }>(
    `update maintenance_job
        set status = case
              when cancel_requested then 'cancelled'
              when attempts < max_attempts then 'queued'
              else 'failed' end,
            finished_at = case
              when cancel_requested or attempts >= max_attempts then now() else null end,
            started_at = case
              when cancel_requested or attempts >= max_attempts then started_at else null end,
            error = case
              when not cancel_requested and attempts >= max_attempts
                then 'Interrupted too many times (worker restarted while it ran)'
              else error end
      where status = 'running'
      returning status`,
  );
  return {
    requeued: rows.filter((row) => row.status === "queued").length,
    failed: rows.filter((row) => row.status === "failed").length,
  };
}

/** Claims the oldest queued job, or returns `null` when there's none (or one is already running). */
export async function claimNextMaintenanceJob(db: Queryable): Promise<MaintenanceJob | null> {
  try {
    const { rows } = await db.query<MaintenanceJobRow>(
      `update maintenance_job
          set status = 'running', started_at = now(), attempts = attempts + 1, progress = '{}'::jsonb
        where id = (
          select id from maintenance_job
           where status = 'queued'
             and not exists (select 1 from maintenance_job where status = 'running')
           order by requested_at, id
           limit 1
           for update skip locked
        )
        returning ${JOB_COLUMNS}`,
    );
    return rows[0] ? toJob(rows[0]) : null;
  } catch (error) {
    // Another claimer won the race for the single running slot.
    if ((error as { code?: string }).code === "23505") return null;
    throw error;
  }
}

/** Records progress; returns whether an admin has asked the job to stop. */
export async function recordMaintenanceJobProgress(
  db: Queryable,
  id: string,
  progress: Record<string, unknown>,
): Promise<{ cancelRequested: boolean }> {
  const { rows } = await db.query<{ cancel_requested: boolean }>(
    `update maintenance_job set progress = $2::jsonb
      where id = $1 and status = 'running'
      returning cancel_requested`,
    [id, JSON.stringify(progress)],
  );
  return { cancelRequested: rows[0]?.cancel_requested ?? true };
}

export async function finishMaintenanceJob(
  db: Queryable,
  id: string,
  outcome: {
    status: "succeeded" | "failed" | "cancelled";
    result?: Record<string, unknown> | null;
    error?: string | null;
  },
): Promise<void> {
  await db.query(
    `update maintenance_job
        set status = $2, result = $3::jsonb, error = $4, finished_at = now()
      where id = $1 and status = 'running'`,
    [
      id,
      outcome.status,
      outcome.result === undefined || outcome.result === null
        ? null
        : JSON.stringify(outcome.result),
      outcome.error ?? null,
    ],
  );
}

export interface BerthDwellProfileSummary {
  berths: number;
  measured: number;
  defaulted: number;
  occupancies: number;
}

/**
 * Recalculates `berth_dwell_profile` for one TD area from its occupancies in `[from, to)`, using
 * `berthAllowance`. Reads one berth at a time through the `(td_area, berth_code, entered_at)`
 * index, taking the area's berths from `berth_current_state`, the same access path as
 * `repair-run-links`: filtering on `td_area` and `entered_at` alone walks every index entry of
 * the area in each partition (no skip scan in Postgres 17).
 *
 * Only described occupancies that have ended count, and only headcode-shaped descriptions
 * (`^[0-9][A-Z][0-9]{2}$`), so engineering and test descriptions don't skew a berth. A berth with
 * no such occupancies in the window gets no row; the estimate then uses the default.
 */
export async function calculateBerthDwellProfiles(
  db: Queryable,
  args: { tdArea: string; from: Date; to: Date; jobId?: string | null },
): Promise<BerthDwellProfileSummary> {
  const { rows } = await db.query<{ berth_code: string; minutes: number[] }>(
    `select b.berth_code, d.minutes
       from berth_current_state b
       cross join lateral (
         select array_agg(extract(epoch from o.left_at - o.entered_at)::float8 / 60.0) as minutes
           from berth_occupancy o
          where o.td_area = b.td_area and o.berth_code = b.berth_code
            and o.entered_at >= $2 and o.entered_at < $3
            and o.left_at is not null
            and o.description ~ '^[0-9][A-Z][0-9]{2}$'
       ) d
      where b.projection_version = $4 and b.td_area = $1 and d.minutes is not null`,
    [args.tdArea, args.from, args.to, TD_PROJECTION_VERSION],
  );

  const summary: BerthDwellProfileSummary = {
    berths: 0,
    measured: 0,
    defaulted: 0,
    occupancies: 0,
  };
  for (const row of rows) {
    const allowance = berthAllowance(row.minutes);
    summary.berths += 1;
    summary.occupancies += allowance.sampleSize;
    if (allowance.basis === "measured") summary.measured += 1;
    else summary.defaulted += 1;
    const measured = allowance.basis === "measured" ? allowance : null;
    await db.query(
      `insert into berth_dwell_profile (
         td_area, berth_code, basis, sample_size, dropped, median_minutes, q1_minutes,
         q3_minutes, fence_minutes, allowance_minutes, window_from, window_to, calculated_at,
         maintenance_job_id
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13)
       on conflict (td_area, berth_code) do update set
         basis = excluded.basis, sample_size = excluded.sample_size, dropped = excluded.dropped,
         median_minutes = excluded.median_minutes, q1_minutes = excluded.q1_minutes,
         q3_minutes = excluded.q3_minutes, fence_minutes = excluded.fence_minutes,
         allowance_minutes = excluded.allowance_minutes, window_from = excluded.window_from,
         window_to = excluded.window_to, calculated_at = excluded.calculated_at,
         maintenance_job_id = excluded.maintenance_job_id`,
      [
        args.tdArea,
        row.berth_code,
        allowance.basis,
        allowance.sampleSize,
        allowance.dropped,
        measured?.medianMinutes ?? null,
        measured?.q1Minutes ?? null,
        measured?.q3Minutes ?? null,
        measured?.fenceMinutes ?? null,
        allowance.allowanceMinutes,
        args.from,
        args.to,
        args.jobId ?? null,
      ],
    );
  }
  return summary;
}

export interface AreaDwellProfileStatus {
  tdArea: string;
  berths: number;
  measured: number;
  lastCalculatedAt: Date | null;
}

/** Per TD area: how many berths have an allowance and when it was last calculated. */
export async function listAreaDwellProfileStatus(
  db: Queryable,
  tdAreas: readonly string[],
): Promise<AreaDwellProfileStatus[]> {
  const { rows } = await db.query<{
    td_area: string;
    berths: string;
    measured: string;
    last_calculated_at: Date | null;
  }>(
    `select a.td_area, count(p.berth_code)::text as berths,
            count(p.berth_code) filter (where p.basis = 'measured')::text as measured,
            max(p.calculated_at) as last_calculated_at
       from unnest($1::text[]) as a(td_area)
       left join berth_dwell_profile p on p.td_area = a.td_area
      group by a.td_area
      order by a.td_area`,
    [[...tdAreas]],
  );
  return rows.map((row) => ({
    tdArea: row.td_area,
    berths: Number(row.berths),
    measured: Number(row.measured),
    lastCalculatedAt: row.last_calculated_at,
  }));
}
