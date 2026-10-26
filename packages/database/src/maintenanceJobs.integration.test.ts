import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { createPool } from "./pool.js";
import {
  calculateBerthDwellProfiles,
  claimNextMaintenanceJob,
  enqueueMaintenanceJob,
  finishMaintenanceJob,
  getMaintenanceJob,
  listAreaDwellProfileStatus,
  recordMaintenanceJobProgress,
  requestMaintenanceJobCancel,
  requeueInterruptedMaintenanceJobs,
} from "./maintenanceJobs.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const createdJobIds: string[] = [];
const createdAreas: string[] = [];

const AREA_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function uniqueArea(): string {
  const area = `Y${AREA_CHARS[Math.floor(Math.random() * AREA_CHARS.length)]}`;
  createdAreas.push(area);
  return area;
}

async function trackedJob(
  ...args: Parameters<typeof enqueueMaintenanceJob>
): ReturnType<typeof enqueueMaintenanceJob> {
  const job = await enqueueMaintenanceJob(...args);
  createdJobIds.push(job.id);
  return job;
}

/** One raw event every seeded occupancy can point at. */
async function seedEvent(tdArea: string): Promise<{ id: string; at: Date }> {
  const archive = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test-bucket', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const frame = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', now(), $1, $2) returning id`,
    [randomUUID(), archive.rows[0]!.id],
  );
  const event = await pool.query<{ id: string; normalized_event_at_utc: Date }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', 'CA', 'C', $2, '{}', $4, $4, $3, 'parsed', 1)
     returning id, normalized_event_at_utc`,
    [frame.rows[0]!.id, tdArea, randomUUID(), new Date()],
  );
  return { id: event.rows[0]!.id, at: event.rows[0]!.normalized_event_at_utc };
}

/** A berth the projector has seen, with ended occupancies of the given lengths (minutes),
 * entered within the last couple of hours. */
async function seedBerth(
  tdArea: string,
  berth: string,
  durationsMinutes: number[],
  description = "1A23",
): Promise<void> {
  const event = await seedEvent(tdArea);
  await pool.query(
    `insert into berth_current_state (
       projection_version, td_area, berth_code, description, event_at, source_event_id,
       source_event_normalized_at_utc, source_ingestion_sequence
     ) values ($1, $2, $3, null, now(), $4, $5, 0)
     on conflict do nothing`,
    [TD_PROJECTION_VERSION, tdArea, berth, event.id, event.at],
  );
  const base = Date.now() - 2 * 60 * 60 * 1000;
  for (const [index, minutes] of durationsMinutes.entries()) {
    const enteredAt = new Date(base + index * 1000);
    await pool.query(
      `insert into berth_occupancy (
         projection_version, td_area, berth_code, description, entered_at, left_at,
         entry_event_id, entry_event_normalized_at_utc, entry_reason
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'ca_step')`,
      [
        TD_PROJECTION_VERSION,
        tdArea,
        berth,
        description,
        enteredAt,
        new Date(enteredAt.getTime() + minutes * 60_000),
        event.id,
        event.at,
      ],
    );
  }
}

async function cleanArea(tdArea: string): Promise<void> {
  await pool.query("delete from berth_dwell_profile where td_area = $1", [tdArea]);
  await pool.query("delete from berth_current_state where td_area = $1", [tdArea]);
  await pool.query("delete from berth_occupancy where td_area = $1", [tdArea]);
}

beforeEach(async () => {
  // Jobs left by another file would be claimed first; the queue is global.
  await pool.query(
    `update maintenance_job set status = 'cancelled', finished_at = now()
      where status in ('queued', 'running')`,
  );
});

afterAll(async () => {
  for (const area of new Set(createdAreas)) await cleanArea(area);
  if (createdJobIds.length > 0) {
    await pool.query("delete from maintenance_job where id = any($1::bigint[])", [createdJobIds]);
  }
  await pool.end();
});

describe("maintenance job queue (integration)", () => {
  it("claims the oldest queued job, one at a time, and records how it finished", async () => {
    const first = await trackedJob(pool, {
      kind: "berth_allowances",
      tdAreas: ["PX"],
      requestedBy: "test",
    });
    const second = await trackedJob(pool, {
      kind: "berth_allowances",
      tdAreas: ["CL"],
      requestedBy: "test",
    });

    const claimed = await claimNextMaintenanceJob(pool);
    expect(claimed?.id).toBe(first.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    // Only one job runs at once.
    expect(await claimNextMaintenanceJob(pool)).toBeNull();

    expect(await recordMaintenanceJobProgress(pool, first.id, { done: 1, total: 1 })).toEqual({
      cancelRequested: false,
    });
    await finishMaintenanceJob(pool, first.id, { status: "succeeded", result: { ok: true } });
    const finished = await getMaintenanceJob(pool, first.id);
    expect(finished).toMatchObject({ status: "succeeded", result: { ok: true } });
    expect(finished?.finishedAt).not.toBeNull();

    expect((await claimNextMaintenanceJob(pool))?.id).toBe(second.id);
  });

  it("cancels a queued job at once, and asks a running one to stop", async () => {
    const queued = await trackedJob(pool, {
      kind: "berth_allowances",
      tdAreas: ["PX"],
      requestedBy: "test",
    });
    expect((await requestMaintenanceJobCancel(pool, queued.id))?.status).toBe("cancelled");
    expect(await requestMaintenanceJobCancel(pool, queued.id)).toBeNull();

    const running = await trackedJob(pool, {
      kind: "berth_allowances",
      tdAreas: ["PX"],
      requestedBy: "test",
    });
    await claimNextMaintenanceJob(pool);
    const asked = await requestMaintenanceJobCancel(pool, running.id);
    expect(asked).toMatchObject({ status: "running", cancelRequested: true });
    expect(await recordMaintenanceJobProgress(pool, running.id, {})).toEqual({
      cancelRequested: true,
    });
    await finishMaintenanceJob(pool, running.id, { status: "cancelled" });
  });

  it("puts an interrupted job back in the queue, until it has used its attempts", async () => {
    const job = await trackedJob(pool, {
      kind: "link_backfill",
      tdAreas: ["PX"],
      requestedBy: "test",
    });
    await pool.query("update maintenance_job set max_attempts = 2 where id = $1", [job.id]);

    await claimNextMaintenanceJob(pool);
    expect(await requeueInterruptedMaintenanceJobs(pool)).toEqual({ requeued: 1, failed: 0 });
    expect((await getMaintenanceJob(pool, job.id))?.status).toBe("queued");

    await claimNextMaintenanceJob(pool);
    expect(await requeueInterruptedMaintenanceJobs(pool)).toEqual({ requeued: 0, failed: 1 });
    const gaveUp = await getMaintenanceJob(pool, job.id);
    expect(gaveUp?.status).toBe("failed");
    expect(gaveUp?.error).toMatch(/Interrupted/);
  });
});

describe("calculateBerthDwellProfiles (integration)", () => {
  it("measures a berth with enough occupancies, defaults a quiet one, and skips an unused one", async () => {
    const area = uniqueArea();
    await cleanArea(area);
    // 60 passes of about a minute and one 200-minute stand.
    await seedBerth(area, "0001", [
      ...Array.from({ length: 60 }, (_, i) => 0.8 + (i % 5) / 10),
      200,
    ]);
    await seedBerth(area, "0002", [2, 2, 2]);
    // Not a headcode, so not counted at all.
    await seedBerth(area, "0003", [5, 5, 5], "****");

    const to = new Date();
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
    const summary = await calculateBerthDwellProfiles(pool, { tdArea: area, from, to });
    expect(summary).toEqual({ berths: 2, measured: 1, defaulted: 1, occupancies: 64 });

    const { rows } = await pool.query<{
      berth_code: string;
      basis: string;
      sample_size: number;
      dropped: number;
      allowance_minutes: string;
    }>(
      `select berth_code, basis, sample_size, dropped, allowance_minutes::text
         from berth_dwell_profile where td_area = $1 order by berth_code`,
      [area],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ berth_code: "0001", basis: "measured", sample_size: 61 });
    expect(rows[0]!.dropped).toBe(1);
    expect(Number(rows[0]!.allowance_minutes)).toBeCloseTo(1.2, 1);
    expect(rows[1]).toMatchObject({ berth_code: "0002", basis: "default", sample_size: 3 });
    expect(Number(rows[1]!.allowance_minutes)).toBe(3);

    // Re-running replaces, never duplicates.
    await calculateBerthDwellProfiles(pool, { tdArea: area, from, to });
    const status = await listAreaDwellProfileStatus(pool, [area]);
    expect(status).toEqual([
      { tdArea: area, berths: 2, measured: 1, lastCalculatedAt: expect.any(Date) },
    ]);
  });
});
