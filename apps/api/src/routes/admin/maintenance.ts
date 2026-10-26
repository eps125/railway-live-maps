import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  MAINTENANCE_JOB_KINDS,
  enqueueMaintenanceJob,
  getMappedTdAreas,
  listAreaDwellProfileStatus,
  listMaintenanceJobs,
  requestMaintenanceJobCancel,
  type MaintenanceJob,
  type MaintenanceJobKind,
} from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { apiError } from "../../lib/queryRange.js";
import { audit } from "../../lib/audit.js";

export interface MaintenanceRoutesDeps {
  pool: Pool;
}

/** A backfill longer than this is refused — split it into several jobs instead. */
export const MAX_LINK_BACKFILL_DAYS = 62;
const MAX_ALLOWANCE_WINDOW_DAYS = 60;
const TD_AREA_PATTERN = /^[A-Z0-9]{2}$/;

function jobResponse(job: MaintenanceJob) {
  return {
    id: job.id,
    kind: job.kind,
    tdAreas: job.tdAreas,
    params: job.params,
    status: job.status,
    cancelRequested: job.cancelRequested,
    attempts: job.attempts,
    progress: job.progress,
    result: job.result,
    error: job.error,
    requestedBy: job.requestedBy,
    requestedAt: job.requestedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

interface QueueJobBody {
  kind?: unknown;
  tdAreas?: unknown;
  params?: unknown;
}

type Validated =
  | {
      ok: true;
      kind: MaintenanceJobKind;
      tdAreas: string[];
      params: Record<string, unknown>;
    }
  | { ok: false; code: string; message: string };

/** Pure request validation, apart from the area checks that need the database (done by the
 * route). Exported for unit tests. */
export function validateQueueJobBody(body: QueueJobBody, now: Date = new Date()): Validated {
  const { kind, tdAreas, params } = body;
  if (typeof kind !== "string" || !(MAINTENANCE_JOB_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: `kind must be one of ${MAINTENANCE_JOB_KINDS.join(", ")}`,
    };
  }
  if (!Array.isArray(tdAreas) || tdAreas.length === 0) {
    return { ok: false, code: "VALIDATION_ERROR", message: "tdAreas must be a non-empty array" };
  }
  const areas = [
    ...new Set(tdAreas.map((area) => (typeof area === "string" ? area.trim().toUpperCase() : ""))),
  ];
  const bad = areas.filter((area) => !TD_AREA_PATTERN.test(area));
  if (bad.length > 0) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      message: `Not a TD area id: ${bad.map((a) => `"${a}"`).join(", ")}`,
    };
  }
  const raw = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;

  if (kind === "berth_allowances") {
    const windowDays = raw.windowDays ?? 14;
    if (
      typeof windowDays !== "number" ||
      !Number.isInteger(windowDays) ||
      windowDays < 1 ||
      windowDays > MAX_ALLOWANCE_WINDOW_DAYS
    ) {
      return {
        ok: false,
        code: "VALIDATION_ERROR",
        message: `windowDays must be a whole number from 1 to ${MAX_ALLOWANCE_WINDOW_DAYS}`,
      };
    }
    return { ok: true, kind: "berth_allowances", tdAreas: areas, params: { windowDays } };
  }

  const from = typeof raw.from === "string" ? new Date(raw.from) : null;
  const to = typeof raw.to === "string" ? new Date(raw.to) : null;
  if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return {
      ok: false,
      code: "INVALID_TIME_RANGE",
      message: "params.from and params.to must be ISO 8601 timestamps",
    };
  }
  if (to <= from) {
    return {
      ok: false,
      code: "INVALID_TIME_RANGE",
      message: "params.to must be after params.from",
    };
  }
  if (to.getTime() > now.getTime() + 5 * 60 * 1000) {
    return { ok: false, code: "INVALID_TIME_RANGE", message: "params.to can't be in the future" };
  }
  if (to.getTime() - from.getTime() > MAX_LINK_BACKFILL_DAYS * 24 * 60 * 60 * 1000) {
    return {
      ok: false,
      code: "INVALID_TIME_RANGE",
      message: `A backfill can cover at most ${MAX_LINK_BACKFILL_DAYS} days; queue several jobs`,
    };
  }
  if (raw.correct !== undefined && typeof raw.correct !== "boolean") {
    return { ok: false, code: "VALIDATION_ERROR", message: "params.correct must be true or false" };
  }
  return {
    ok: true,
    kind: "link_backfill",
    tdAreas: areas,
    params: { from: from.toISOString(), to: to.toISOString(), correct: raw.correct === true },
  };
}

/**
 * Milestone 97a (docs/adr/0021): admin "Area maintenance". Queues jobs the worker runs one at a
 * time (`maintenance_job`): recalculating berth allowances, and backfilling run links for an area
 * (what a newly mapped area needs before its history shows delay colours). Registered inside the
 * admin-gated scope in `server.ts`. Every queue and cancel is audited.
 */
export async function registerMaintenanceRoutes(
  app: FastifyInstance,
  deps: MaintenanceRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get("/api/v1/admin/maintenance/areas", async () => {
    const mapped = [...(await getMappedTdAreas(pool))].sort();
    const status = await listAreaDwellProfileStatus(pool, mapped);
    return {
      areas: status.map((area) => ({
        tdArea: area.tdArea,
        allowanceBerths: area.berths,
        measuredBerths: area.measured,
        allowancesCalculatedAt: area.lastCalculatedAt?.toISOString() ?? null,
      })),
    };
  });

  app.get("/api/v1/admin/maintenance/jobs", async () => {
    const jobs = await listMaintenanceJobs(pool, 50);
    return { jobs: jobs.map(jobResponse) };
  });

  app.post<{ Body: QueueJobBody }>("/api/v1/admin/maintenance/jobs", async (request, reply) => {
    const validated = validateQueueJobBody(request.body ?? {});
    if (!validated.ok) {
      reply.code(400);
      return apiError(validated.code, validated.message);
    }

    if (validated.kind === "link_backfill") {
      // repair-run-links only links occupancies in mapped areas.
      const mapped = await getMappedTdAreas(pool);
      const unmapped = validated.tdAreas.filter((area) => !mapped.has(area));
      if (unmapped.length > 0) {
        reply.code(400);
        return apiError(
          "AREA_NOT_MAPPED",
          `Not on any published map, so it has no run links to backfill: ${unmapped.join(", ")}`,
        );
      }
    } else {
      // Any captured area may be measured, so a new map's allowances can be ready before it's
      // published.
      const { rows } = await pool.query<{ td_area: string }>(
        `select a.td_area from unnest($1::text[]) as a(td_area)
          where exists (
            select 1 from berth_current_state b
             where b.projection_version = $2 and b.td_area = a.td_area
          )`,
        [validated.tdAreas, TD_PROJECTION_VERSION],
      );
      const known = new Set(rows.map((row) => row.td_area));
      const unknown = validated.tdAreas.filter((area) => !known.has(area));
      if (unknown.length > 0) {
        reply.code(400);
        return apiError("UNKNOWN_TD_AREA", `No berths have been seen in: ${unknown.join(", ")}`);
      }
    }

    const job = await enqueueMaintenanceJob(pool, {
      kind: validated.kind,
      tdAreas: validated.tdAreas,
      params: validated.params,
      requestedBy: request.authSession?.username ?? "unknown",
    });
    await audit(
      pool,
      request,
      "maintenance.queue",
      { type: "maintenance_job", id: job.id },
      {
        kind: job.kind,
        tdAreas: job.tdAreas,
        params: job.params,
      },
    );
    reply.code(201);
    return jobResponse(job);
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/maintenance/jobs/:id/cancel",
    async (request, reply) => {
      if (!/^[0-9]+$/.test(request.params.id)) {
        reply.code(404);
        return apiError("JOB_NOT_FOUND", `No maintenance job "${request.params.id}"`);
      }
      const job = await requestMaintenanceJobCancel(pool, request.params.id);
      if (!job) {
        reply.code(409);
        return apiError("JOB_NOT_ACTIVE", "That job has already finished (or doesn't exist)");
      }
      await audit(
        pool,
        request,
        "maintenance.cancel",
        { type: "maintenance_job", id: job.id },
        { kind: job.kind, status: job.status },
      );
      return jobResponse(job);
    },
  );
}
