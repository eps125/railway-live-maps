import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { registerRunRoutes } from "./runs.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueTrainId(): string {
  return `T${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

interface InsertRunResult {
  runId: string;
  trustTrainId: string;
}

async function insertRun(overrides: {
  scheduleId?: string | null;
  lifecycleState?: string;
}): Promise<InsertRunResult> {
  const trustTrainId = uniqueTrainId();
  const result = await pool.query<{ id: string }>(
    `insert into train_run (
       trust_train_id, service_date, signalling_id, schedule_id, activated_at, call_type,
       call_mode, operator_code, service_code, lifecycle_state, last_event_at
     ) values ($1,'2026-08-10','2A16',$2,'2026-08-10T10:00:00Z','AUTOMATIC','NORMAL','NT',
       '22222000',$3,'2026-08-10T10:00:00Z')
     returning id`,
    [trustTrainId, overrides.scheduleId ?? null, overrides.lifecycleState ?? "activated"],
  );
  const runId = result.rows[0]?.id;
  if (!runId) throw new Error("Expected train_run insert to return an id");
  return { runId, trustTrainId };
}

async function insertSchedule(trainUid: string): Promise<{ scheduleId: string }> {
  const result = await pool.query<{ id: string }>(
    `insert into schedule (
       train_uid, schedule_start_date, schedule_end_date, stp_indicator, origin_tiploc,
       destination_tiploc, source, raw_source_json
     ) values ($1,'2026-01-01','2026-12-31','P','PRST','LANCSTR','SCHEDULE','{}')
     returning id`,
    [trainUid],
  );
  const scheduleId = result.rows[0]?.id;
  if (!scheduleId) throw new Error("Expected schedule insert to return an id");
  await pool.query(
    `insert into schedule_location (schedule_id, seq_no, location_type, tiploc)
     values ($1,1,'origin','PRST'), ($1,2,'destination','LANCSTR')`,
    [scheduleId],
  );
  return { scheduleId };
}

describe("run routes (integration)", () => {
  const createdRunIds: string[] = [];
  const createdScheduleIds: string[] = [];
  const createdOccupancyIds: string[] = [];

  afterAll(async () => {
    if (createdOccupancyIds.length > 0) {
      await pool.query("delete from berth_run_resolution where occupancy_id = any($1::bigint[])", [
        createdOccupancyIds,
      ]);
      await pool.query("delete from berth_occupancy where id = any($1::bigint[])", [
        createdOccupancyIds,
      ]);
    }
    if (createdRunIds.length > 0) {
      await pool.query("delete from run_schedule_link where train_run_id = any($1::uuid[])", [
        createdRunIds,
      ]);
      await pool.query("delete from train_run where id = any($1::uuid[])", [createdRunIds]);
    }
    if (createdScheduleIds.length > 0) {
      await pool.query("delete from schedule where id = any($1::bigint[])", [createdScheduleIds]);
    }
    await pool.end();
  });

  it("GET /api/v1/runs/:runId returns identity/activation/lifecycle with a null resolverEvidence placeholder", async () => {
    const { runId, trustTrainId } = await insertRun({});
    createdRunIds.push(runId);

    const app = Fastify();
    await registerRunRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      runId,
      trustTrainId,
      lifecycleState: "activated",
      scheduleLink: null,
      resolverEvidence: null,
    });
  });

  it("GET /api/v1/runs/:runId includes the run_schedule_link summary when one exists", async () => {
    const trainUid = `RU${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const { scheduleId } = await insertSchedule(trainUid);
    createdScheduleIds.push(scheduleId);
    const { runId } = await insertRun({ scheduleId });
    createdRunIds.push(runId);

    await pool.query(
      `insert into run_schedule_link (
         train_run_id, activation_train_uid, activation_at, schedule_id, match_outcome
       ) values ($1,$2,'2026-08-10T10:00:00Z',$3,'matched')`,
      [runId, trainUid, scheduleId],
    );

    const app = Fastify();
    await registerRunRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().scheduleLink).toMatchObject({
      matchOutcome: "matched",
      scheduleId,
    });
  });

  it("GET /api/v1/runs/:runId populates resolverEvidence from the run's berth_run_resolution row (Milestone 9)", async () => {
    const { runId } = await insertRun({});
    createdRunIds.push(runId);

    // A minimal seeded occupancy this resolution can reference (FK requires a real one).
    const archiveResult = await pool.query<{ id: string }>(
      `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
       values ($1, 'test-bucket', $2, 1, 'broker-frame') returning id`,
      [`test/${randomUUID()}`, randomUUID()],
    );
    const frameResult = await pool.query<{ id: string }>(
      `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
       values ('TD', '/topic/TD_ALL_SIG_AREA', now(), $1, $2) returning id`,
      [randomUUID(), archiveResult.rows[0]!.id],
    );
    const now = new Date();
    const eventResult = await pool.query<{ id: string; normalized_event_at_utc: Date }>(
      `insert into raw_feed_event (
         frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
         normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
       ) values ($1, 0, 'TD', 'CC', 'C', 'ZZ', '{}', $2, $2, $3, 'parsed', 1)
       returning id, normalized_event_at_utc`,
      [frameResult.rows[0]!.id, now, randomUUID()],
    );
    const occupancyResult = await pool.query<{ id: string; entered_at: Date }>(
      `insert into berth_occupancy (
         projection_version, td_area, berth_code, description, entered_at,
         entry_event_id, entry_event_normalized_at_utc, entry_reason
       ) values ($1, 'ZZ', '0001', '2A16', $2, $3, $4, 'cc_interpose')
       returning id, entered_at`,
      [
        TD_PROJECTION_VERSION,
        now,
        eventResult.rows[0]!.id,
        eventResult.rows[0]!.normalized_event_at_utc,
      ],
    );
    const occupancy = occupancyResult.rows[0]!;
    createdOccupancyIds.push(occupancy.id);

    await pool.query(
      `insert into berth_run_resolution (
         occupancy_id, occupancy_entered_at, status, selected_train_run_id, confidence,
         resolver_version, candidates
       ) values ($1, $2, 'matched', $3, 0.75, 1, '[{"trainRunId":"x","score":75,"reasons":[]}]')`,
      [occupancy.id, occupancy.entered_at, runId],
    );

    const app = Fastify();
    await registerRunRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().resolverEvidence).toMatchObject({
      status: "matched",
      confidence: 0.75,
      resolverVersion: 1,
    });
  });

  it("GET /api/v1/runs/:runId returns 404 with RUN_NOT_FOUND for an unknown runId", async () => {
    const app = Fastify();
    await registerRunRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${randomUUID()}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("RUN_NOT_FOUND");
  });

  it("GET /api/v1/runs/:runId/schedule returns ordered locations for a linked run", async () => {
    const trainUid = `RU${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const { scheduleId } = await insertSchedule(trainUid);
    createdScheduleIds.push(scheduleId);
    const { runId } = await insertRun({ scheduleId });
    createdRunIds.push(runId);

    const app = Fastify();
    await registerRunRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/schedule` });
    expect(response.statusCode).toBe(200);
    expect(response.json().locations).toEqual([
      expect.objectContaining({ seqNo: 1, tiploc: "PRST" }),
      expect.objectContaining({ seqNo: 2, tiploc: "LANCSTR" }),
    ]);
  });

  it("GET /api/v1/runs/:runId/schedule returns 404 with RUN_SCHEDULE_NOT_LINKED for an unlinked run", async () => {
    const { runId } = await insertRun({});
    createdRunIds.push(runId);

    const app = Fastify();
    await registerRunRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: `/api/v1/runs/${runId}/schedule` });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("RUN_SCHEDULE_NOT_LINKED");
  });

  it("GET /api/v1/runs/:runId/schedule returns 404 with RUN_NOT_FOUND for an unknown runId", async () => {
    const app = Fastify();
    await registerRunRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/runs/${randomUUID()}/schedule`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("RUN_NOT_FOUND");
  });
});
