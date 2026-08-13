import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { registerCurrentRunRoutes } from "./currentRun.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const createdOccupancyIds: string[] = [];
const createdRunIds: string[] = [];
const createdScheduleIds: string[] = [];

afterAll(async () => {
  if (createdOccupancyIds.length > 0) {
    await pool.query("delete from berth_run_resolution where occupancy_id = any($1::bigint[])", [
      createdOccupancyIds,
    ]);
    await pool.query("delete from berth_current_state where occupancy_id = any($1::bigint[])", [
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

function uniqueArea(): string {
  return `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
}

async function seedOccupiedBerth(
  tdArea: string,
  berth: string,
  description: string,
): Promise<{ occupancyId: string }> {
  const now = new Date();
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
  const eventResult = await pool.query<{
    id: string;
    normalized_event_at_utc: Date;
    ingestion_sequence: string;
  }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', 'CC', 'C', $2, '{}', $3, $3, $4, 'parsed', 1)
     returning id, normalized_event_at_utc, ingestion_sequence`,
    [frameResult.rows[0]!.id, tdArea, now, randomUUID()],
  );
  const event = eventResult.rows[0]!;
  const occupancyResult = await pool.query<{ id: string }>(
    `insert into berth_occupancy (
       projection_version, td_area, berth_code, description, entered_at,
       entry_event_id, entry_event_normalized_at_utc, entry_reason
     ) values ($1, $2, $3, $4, $5, $6, $7, 'cc_interpose')
     returning id`,
    [
      TD_PROJECTION_VERSION,
      tdArea,
      berth,
      description,
      now,
      event.id,
      event.normalized_event_at_utc,
    ],
  );
  const occupancyId = occupancyResult.rows[0]!.id;
  createdOccupancyIds.push(occupancyId);

  await pool.query(
    `insert into berth_current_state (
       projection_version, td_area, berth_code, description, occupancy_id, occupancy_entered_at,
       event_at, source_event_id, source_event_normalized_at_utc, source_ingestion_sequence
     ) values ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9)`,
    [
      TD_PROJECTION_VERSION,
      tdArea,
      berth,
      description,
      occupancyId,
      now,
      event.id,
      event.normalized_event_at_utc,
      event.ingestion_sequence,
    ],
  );

  return { occupancyId };
}

async function seedTrainRun(
  signallingId: string,
  scheduleId: string | null = null,
): Promise<string> {
  const trustTrainId = `T${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const result = await pool.query<{ id: string }>(
    `insert into train_run (trust_train_id, signalling_id, service_date, schedule_id, last_event_at)
     values ($1, $2, '2026-08-10', $3, now())
     returning id`,
    [trustTrainId, signallingId, scheduleId],
  );
  const runId = result.rows[0]!.id;
  createdRunIds.push(runId);
  return runId;
}

/** source: 'VSTP', not 'SCHEDULE' — apps/worker/src/schedule/scheduleImporter.ts's full-file
 * swap unconditionally deletes every source='SCHEDULE' row, which would collide with these
 * test fixtures outliving this test run (same reasoning as the resolver integration suite's
 * own seedSchedule helper). */
async function seedSchedule(trainUid: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into schedule (
       train_uid, schedule_start_date, schedule_end_date, stp_indicator, source, raw_source_json
     ) values ($1, '2026-01-01', '2026-12-31', 'P', 'VSTP', '{}')
     returning id`,
    [trainUid],
  );
  const scheduleId = result.rows[0]!.id;
  createdScheduleIds.push(scheduleId);
  return scheduleId;
}

async function seedResolution(
  occupancyId: string,
  status: "matched" | "ambiguous" | "unmatched",
  selectedTrainRunId: string | null,
  candidates: unknown[] = [],
): Promise<void> {
  const occupancy = await pool.query<{ entered_at: Date }>(
    `select entered_at from berth_occupancy where id = $1`,
    [occupancyId],
  );
  await pool.query(
    `insert into berth_run_resolution (
       occupancy_id, occupancy_entered_at, status, selected_train_run_id, confidence,
       resolver_version, candidates
     ) values ($1, $2, $3, $4, $5, 1, $6)`,
    [
      occupancyId,
      occupancy.rows[0]!.entered_at,
      status,
      selectedTrainRunId,
      selectedTrainRunId ? 1 : null,
      JSON.stringify(candidates),
    ],
  );
}

async function buildApp() {
  const app = Fastify();
  await registerCurrentRunRoutes(app, { pool });
  await app.ready();
  return app;
}

describe("GET /api/v1/td/areas/:tdArea/berths/:berth/current-run (integration)", () => {
  it("404s with BERTH_NOT_OCCUPIED when there's no current occupancy", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/td/areas/${uniqueArea()}/berths/0001/current-run`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("BERTH_NOT_OCCUPIED");
    } finally {
      await app.close();
    }
  });

  it("returns description-only when the berth is occupied but not yet resolved", async () => {
    const area = uniqueArea();
    await seedOccupiedBerth(area, "0001", "1A23");
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/td/areas/${area}/berths/0001/current-run`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.description).toBe("1A23");
      expect(body.resolution).toBeNull();
      expect(body.run).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("returns full run detail when matched", async () => {
    const area = uniqueArea();
    const { occupancyId } = await seedOccupiedBerth(area, "0002", "2A16");
    const runId = await seedTrainRun("2A16");
    await seedResolution(occupancyId, "matched", runId);

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/td/areas/${area}/berths/0002/current-run`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.resolution).toMatchObject({ status: "matched", confidence: 1 });
      expect(body.run).toMatchObject({ runId, signallingId: "2A16" });
    } finally {
      await app.close();
    }
  });

  it("returns the candidate list without picking a run when ambiguous, never fabricating a match", async () => {
    const area = uniqueArea();
    const { occupancyId } = await seedOccupiedBerth(area, "0003", "3A16");
    await seedResolution(occupancyId, "ambiguous", null);

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/td/areas/${area}/berths/0003/current-run`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.resolution.status).toBe("ambiguous");
      expect(body.run).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("enriches ambiguous candidates with headcode/UID/TRUST id looked up fresh, not stored stale", async () => {
    const area = uniqueArea();
    const { occupancyId } = await seedOccupiedBerth(area, "0004", "2T37");
    const scheduleId = await seedSchedule("C17206");
    const linkedRunId = await seedTrainRun("2T37", scheduleId);
    const unlinkedRunId = await seedTrainRun("2T37", null);
    await seedResolution(occupancyId, "ambiguous", null, [
      { trainRunId: linkedRunId, score: 58, confidence: 0.58, reasons: ["schedule-linked"] },
      { trainRunId: unlinkedRunId, score: 40, confidence: 0.4, reasons: ["description-only"] },
    ]);

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/td/areas/${area}/berths/0004/current-run`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const candidates = body.resolution.candidates as Array<{
        trainRunId: string;
        signallingId: string | null;
        trustTrainId: string | null;
        trainUid: string | null;
      }>;

      const linked = candidates.find((c) => c.trainRunId === linkedRunId);
      expect(linked).toMatchObject({ signallingId: "2T37", trainUid: "C17206" });
      expect(linked?.trustTrainId).toEqual(expect.any(String));

      const unlinked = candidates.find((c) => c.trainRunId === unlinkedRunId);
      expect(unlinked).toMatchObject({ signallingId: "2T37", trainUid: null });
      expect(unlinked?.trustTrainId).toEqual(expect.any(String));
    } finally {
      await app.close();
    }
  });
});
