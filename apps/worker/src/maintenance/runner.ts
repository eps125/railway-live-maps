import {
  calculateBerthDwellProfiles,
  claimNextMaintenanceJob,
  finishMaintenanceJob,
  recordMaintenanceJobProgress,
  requeueInterruptedMaintenanceJobs,
  type BerthDwellProfileSummary,
  type MaintenanceJob,
  countLiveEstimatesIn,
  deleteBackfilledEstimatesIn,
} from "@railway/database";
import type { Pool } from "pg";
import { repairRunLinks, type RepairRunLinksSummary } from "../commands/repairRunLinks.js";
import { MapBindingsCache, mappedBerths } from "../garner/delayBandPublisher.js";
import { HeldDelaySweep, type ReplayState } from "../garner/heldDelaySweep.js";
import { runDaemonLoop } from "../shared/daemonLoop.js";

/**
 * Milestone 97a (docs/adr/0021): runs the admin-queued `maintenance_job`s, one at a time, inside
 * the worker's `serve` role. Each job checks for a cancel request between steps (one TD area, or
 * one slice of a backfill) and records its progress there, so the admin page can follow it.
 */
export const MAINTENANCE_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_ALLOWANCE_WINDOW_DAYS = 14;
export const MAX_ALLOWANCE_WINDOW_DAYS = 60;
/** A backfill runs in slices this long, oldest first, so progress and cancelling are per slice. */
export const LINK_BACKFILL_SLICE_MS = 6 * 60 * 60 * 1000;
const MAX_WRONG_RUN_SAMPLES = 20;

type JobOutcome =
  | { status: "succeeded"; result: Record<string, unknown> }
  | { status: "cancelled"; result: Record<string, unknown> };

export async function runBerthAllowancesJob(
  pool: Pool,
  job: MaintenanceJob,
  now: Date = new Date(),
): Promise<JobOutcome> {
  const requested = Number(job.params.windowDays ?? DEFAULT_ALLOWANCE_WINDOW_DAYS);
  const windowDays = Math.min(
    MAX_ALLOWANCE_WINDOW_DAYS,
    Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_ALLOWANCE_WINDOW_DAYS),
  );
  const to = now;
  const from = new Date(to.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const areas: Record<string, BerthDwellProfileSummary> = {};
  // One area at a time, so one job never reads a lot at once (the live site comes first).
  for (const [index, tdArea] of job.tdAreas.entries()) {
    const { cancelRequested } = await recordMaintenanceJobProgress(pool, job.id, {
      step: "area",
      current: tdArea,
      done: index,
      total: job.tdAreas.length,
    });
    if (cancelRequested) {
      return { status: "cancelled", result: { windowDays, areas } };
    }
    areas[tdArea] = await calculateBerthDwellProfiles(pool, { tdArea, from, to, jobId: job.id });
  }
  await recordMaintenanceJobProgress(pool, job.id, {
    step: "area",
    current: null,
    done: job.tdAreas.length,
    total: job.tdAreas.length,
  });
  return {
    status: "succeeded",
    result: { windowDays, from: from.toISOString(), to: to.toISOString(), areas },
  };
}

function emptyRepairSummary(): RepairRunLinksSummary {
  return {
    examined: 0,
    alreadyLinked: 0,
    stillUnmatched: 0,
    linked: 0,
    carriedForward: 0,
    wrongRun: 0,
    wrongRunSamples: [],
    corrected: 0,
    repointed: 0,
  };
}

function addRepairSummary(total: RepairRunLinksSummary, slice: RepairRunLinksSummary): void {
  total.examined += slice.examined;
  total.alreadyLinked += slice.alreadyLinked;
  total.stillUnmatched += slice.stillUnmatched;
  total.linked += slice.linked;
  total.carriedForward += slice.carriedForward;
  total.wrongRun += slice.wrongRun;
  total.corrected += slice.corrected;
  total.repointed += slice.repointed;
  for (const sample of slice.wrongRunSamples) {
    if (total.wrongRunSamples.length >= MAX_WRONG_RUN_SAMPLES) break;
    total.wrongRunSamples.push(sample);
  }
}

export async function runLinkBackfillJob(pool: Pool, job: MaintenanceJob): Promise<JobOutcome> {
  const from = new Date(String(job.params.from));
  const to = new Date(String(job.params.to));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    throw new Error("link_backfill: params.from and params.to must be timestamps, from before to");
  }
  const correct = job.params.correct === true;
  const totalSlices = Math.ceil((to.getTime() - from.getTime()) / LINK_BACKFILL_SLICE_MS);
  const summary = emptyRepairSummary();
  for (let slice = 0; slice < totalSlices; slice += 1) {
    const sliceFrom = new Date(from.getTime() + slice * LINK_BACKFILL_SLICE_MS);
    const sliceTo = new Date(Math.min(to.getTime(), sliceFrom.getTime() + LINK_BACKFILL_SLICE_MS));
    const { cancelRequested } = await recordMaintenanceJobProgress(pool, job.id, {
      step: "slice",
      current: sliceFrom.toISOString(),
      done: slice,
      total: totalSlices,
      linked: summary.linked,
    });
    if (cancelRequested) return { status: "cancelled", result: { correct, ...summary } };
    addRepairSummary(
      summary,
      await repairRunLinks(pool, {
        from: sliceFrom,
        to: sliceTo,
        dryRun: false,
        correct,
        areas: job.tdAreas,
      }),
    );
  }
  await recordMaintenanceJobProgress(pool, job.id, {
    step: "slice",
    current: null,
    done: totalSlices,
    total: totalSlices,
    linked: summary.linked,
  });
  return { status: "succeeded", result: { correct, ...summary } };
}

/** A replay steps through its window this often: bands change only at 15/30/60 minutes, so a
 * minute's resolution is all the map could show (the live sweep's 20 s is for freshness). */
export const ESTIMATE_BACKFILL_STEP_MS = 60_000;
/** Progress is recorded, and a cancel request checked, every this many replayed minutes. */
const ESTIMATE_BACKFILL_PROGRESS_STEPS = 60;

/**
 * Milestone 97d (docs/adr/0021): replays the held-train sweep over `[from, to)` for the job's
 * TD areas (their berths on today's published maps), minute by minute, with every input as
 * known at each moment, and records the estimates the live map would have shown
 * (`source = 'backfill'`). Refuses a window with live estimates in it, so live history is never
 * rewritten; replaces its own earlier backfill rows in the window; and ends every estimate
 * still in force at `to`.
 */
export async function runEstimateBackfillJob(pool: Pool, job: MaintenanceJob): Promise<JobOutcome> {
  const from = new Date(String(job.params.from));
  const to = new Date(String(job.params.to));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    throw new Error(
      "estimate_backfill: params.from and params.to must be timestamps, from before to",
    );
  }
  const live = await countLiveEstimatesIn(pool, from, to);
  if (live > 0) {
    throw new Error(
      `estimate_backfill: ${live} live estimates already recorded in this window; end it before they start`,
    );
  }
  const areas = new Set(job.tdAreas);
  const berths = mappedBerths(await new MapBindingsCache(pool).current()).filter((b) =>
    areas.has(b.tdArea),
  );
  const replaced = await deleteBackfilledEstimatesIn(pool, from, to);

  const sweep = new HeldDelaySweep();
  const state: ReplayState = new Map();
  const totalSteps = Math.ceil((to.getTime() - from.getTime()) / ESTIMATE_BACKFILL_STEP_MS);
  const summary = { rows: 0, estimatesSet: 0, mostHeldAtOnce: 0, trains: new Set<string>() };
  const progress = (done: number, current: Date | null) =>
    recordMaintenanceJobProgress(pool, job.id, {
      step: "minute",
      current: current?.toISOString() ?? null,
      done,
      total: totalSteps,
      rows: summary.rows,
    });
  const result = () => ({
    from: from.toISOString(),
    to: to.toISOString(),
    berths: berths.length,
    replacedRows: replaced,
    rows: summary.rows,
    estimatesSet: summary.estimatesSet,
    trains: summary.trains.size,
    mostHeldAtOnce: summary.mostHeldAtOnce,
  });

  for (let i = 0; i < totalSteps; i += 1) {
    const at = new Date(from.getTime() + i * ESTIMATE_BACKFILL_STEP_MS);
    if (i % ESTIMATE_BACKFILL_PROGRESS_STEPS === 0) {
      const { cancelRequested } = await progress(i, at);
      if (cancelRequested) {
        summary.rows += await sweep.closeReplay(pool, state, at);
        return { status: "cancelled", result: result() };
      }
    }
    const before = new Set(state.keys());
    const step = await sweep.replayStep(pool, berths, at, state);
    summary.rows += step.changesRecorded;
    summary.mostHeldAtOnce = Math.max(summary.mostHeldAtOnce, step.activeEstimates);
    for (const trustId of state.keys()) {
      if (!before.has(trustId)) summary.estimatesSet += 1;
      summary.trains.add(trustId);
    }
  }
  summary.rows += await sweep.closeReplay(pool, state, to);
  await progress(totalSteps, null);
  return { status: "succeeded", result: result() };
}

/** Claims and runs at most one job. Returns whether one ran. A failure is recorded on the job
 * (never thrown out of here), so one bad job can't stop the queue. */
export async function runNextMaintenanceJob(pool: Pool): Promise<boolean> {
  const job = await claimNextMaintenanceJob(pool);
  if (!job) return false;
  console.log(`maintenance: job ${job.id} (${job.kind}) started for ${job.tdAreas.join(", ")}`);
  try {
    const outcome =
      job.kind === "berth_allowances"
        ? await runBerthAllowancesJob(pool, job)
        : job.kind === "estimate_backfill"
          ? await runEstimateBackfillJob(pool, job)
          : await runLinkBackfillJob(pool, job);
    await finishMaintenanceJob(pool, job.id, outcome);
    console.log(`maintenance: job ${job.id} ${outcome.status}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`maintenance: job ${job.id} failed`, error);
    await finishMaintenanceJob(pool, job.id, { status: "failed", error: message });
  }
  return true;
}

/** The `serve` role's job loop. Resolves on SIGTERM/SIGINT, after the current job's step. A job
 * cut off by the container stopping is put back in the queue on the next start. */
export async function runMaintenanceJobLoop(pool: Pool): Promise<void> {
  // Inside the loop, not before it: if the database isn't reachable yet (or migration 0053 isn't
  // applied yet) this just fails a tick and is retried, instead of taking `serve` down with it.
  let requeueDone = false;
  await runDaemonLoop({
    label: "maintenance",
    intervalMs: MAINTENANCE_POLL_INTERVAL_MS,
    errorBackoffMs: 30_000,
    tick: async () => {
      if (!requeueDone) {
        const { requeued, failed } = await requeueInterruptedMaintenanceJobs(pool);
        requeueDone = true;
        if (requeued > 0 || failed > 0) {
          console.log(`maintenance: interrupted jobs requeued ${requeued}, given up ${failed}`);
        }
      }
      await runNextMaintenanceJob(pool);
    },
  });
}
