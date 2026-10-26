import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimNextMaintenanceJob,
  createPool,
  enqueueMaintenanceJob,
  getMaintenanceJob,
  requestMaintenanceJobCancel,
} from "@railway/database";
import { runBerthAllowancesJob, runNextMaintenanceJob } from "./runner.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const createdJobIds: string[] = [];

async function queue(
  kind: "berth_allowances" | "link_backfill",
  tdAreas: string[],
  params: Record<string, unknown> = {},
) {
  const job = await enqueueMaintenanceJob(pool, { kind, tdAreas, params, requestedBy: "test" });
  createdJobIds.push(job.id);
  return job;
}

beforeEach(async () => {
  await pool.query(
    `update maintenance_job set status = 'cancelled', finished_at = now()
      where status in ('queued', 'running')`,
  );
});

afterAll(async () => {
  if (createdJobIds.length > 0) {
    await pool.query(
      "delete from berth_dwell_profile where maintenance_job_id = any($1::bigint[])",
      [createdJobIds],
    );
    await pool.query("delete from maintenance_job where id = any($1::bigint[])", [createdJobIds]);
  }
  await pool.end();
});

describe("maintenance job runner (integration)", () => {
  it("runs a queued berth-allowances job to the end and records what it did", async () => {
    // An area with no berths at all still completes, with an empty summary.
    const job = await queue("berth_allowances", ["YZ"], { windowDays: 3 });
    expect(await runNextMaintenanceJob(pool)).toBe(true);
    const done = await getMaintenanceJob(pool, job.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result).toMatchObject({
      windowDays: 3,
      areas: { YZ: { berths: 0, measured: 0, defaulted: 0, occupancies: 0 } },
    });
    expect(done?.progress).toMatchObject({ done: 1, total: 1 });
    expect(await runNextMaintenanceJob(pool)).toBe(false);
  });

  it("stops between areas when an admin cancels a running job", async () => {
    const job = await queue("berth_allowances", ["YY", "YZ"]);
    const claimed = await claimNextMaintenanceJob(pool);
    expect(claimed?.id).toBe(job.id);
    await requestMaintenanceJobCancel(pool, job.id);
    const outcome = await runBerthAllowancesJob(pool, claimed!);
    expect(outcome.status).toBe("cancelled");
    expect(outcome.result.areas).toEqual({});
  });

  it("records a failing job as failed, with the reason, and keeps the queue moving", async () => {
    // Not on any published map, so repair-run-links refuses it.
    const failing = await queue("link_backfill", ["YX"], {
      from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
    });
    const next = await queue("berth_allowances", ["YZ"]);
    expect(await runNextMaintenanceJob(pool)).toBe(true);
    const failed = await getMaintenanceJob(pool, failing.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/not on any published map: YX/);
    expect(await runNextMaintenanceJob(pool)).toBe(true);
    expect((await getMaintenanceJob(pool, next.id))?.status).toBe("succeeded");
  });
});
