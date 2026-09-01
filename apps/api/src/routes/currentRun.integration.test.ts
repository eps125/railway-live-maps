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
const createdScheduleIds: number[] = [];
const createdTrustIds: string[] = [];
const createdLocationReferenceTiplocs: string[] = [];

let nextScheduleId = Date.now();
function newScheduleId(): number {
  return nextScheduleId++;
}

afterAll(async () => {
  if (createdOccupancyIds.length > 0) {
    await pool.query("delete from berth_current_state where occupancy_id = any($1::bigint[])", [
      createdOccupancyIds,
    ]);
    await pool.query("delete from berth_occupancy where id = any($1::bigint[])", [
      createdOccupancyIds,
    ]);
  }
  if (createdScheduleIds.length > 0) {
    await pool.query("delete from cif_schedules where id = any($1::bigint[])", [
      createdScheduleIds,
    ]);
  }
  if (createdTrustIds.length > 0) {
    await pool.query("delete from trust_movement where trust_id = any($1::text[])", [
      createdTrustIds,
    ]);
    await pool.query("delete from trust_activation_extra where trust_id = any($1::text[])", [
      createdTrustIds,
    ]);
    await pool.query("delete from trust_activation where trust_id = any($1::text[])", [
      createdTrustIds,
    ]);
  }
  if (createdLocationReferenceTiplocs.length > 0) {
    await pool.query("delete from location_reference where tiploc = any($1::text[])", [
      createdLocationReferenceTiplocs,
    ]);
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

/** garner-shaped `cif_schedules` row (migration 0024) covering "today" every day of the week. */
async function seedSchedule(
  signallingId: string,
  stpIndicator: "C" | "N" | "O" | "P",
): Promise<number> {
  const id = newScheduleId();
  await pool.query(
    `insert into cif_schedules (
       id, created, cif_stp_indicator, cif_train_uid,
       runs_mo, runs_tu, runs_we, runs_th, runs_fr, runs_sa, runs_su,
       schedule_start_date, schedule_end_date, signalling_id, atoc_code, cif_train_service_code
     ) values ($1, now(), $2, $3, true,true,true,true,true,true,true,
       (now() - interval '30 days')::date, (now() + interval '30 days')::date, $4, 'NT', '11111000')`,
    [id, stpIndicator, `U${id}`, signallingId],
  );
  createdScheduleIds.push(id);
  return id;
}

async function seedScheduleLocation(
  scheduleId: number,
  seqNo: number,
  tiploc: string,
  recordIdentity: string,
  times: { arrival?: string; departure?: string } = {},
): Promise<void> {
  await pool.query(
    `insert into cif_schedule_locations (
       cif_schedule_id, seq_no, record_identity, tiploc_code, public_arrival, public_departure
     ) values ($1, $2, $3, $4, $5, $6)`,
    [scheduleId, seqNo, recordIdentity, tiploc, times.arrival ?? null, times.departure ?? null],
  );
}

async function seedActivation(scheduleId: number, signallingId: string): Promise<string> {
  const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  createdTrustIds.push(trustId);
  await pool.query(
    `insert into trust_activation (trust_id, created, cif_schedule_id, deduced)
     values ($1, now(), $2, 0)`,
    [trustId, scheduleId],
  );
  await pool.query(
    `insert into trust_activation_extra (trust_id, created, train_uid, toc_id, schedule_wtt_id)
     values ($1, now(), $2, 'NT', $3)`,
    [trustId, `U${scheduleId}`, `W${scheduleId}`],
  );
  void signallingId;
  return trustId;
}

async function seedMovement(
  trustId: string,
  locStanox: string,
  flags: number,
  timetableVariation: number,
): Promise<void> {
  await pool.query(
    `insert into trust_movement (
       trust_id, created, platform, loc_stanox, actual_timestamp, timetable_variation, flags
     ) values ($1, now(), '4', $2, now(), $3, $4)`,
    [trustId, locStanox, timetableVariation, flags],
  );
}

async function seedLocationReference(
  tiploc: string,
  name: string,
  stanox: string | null = null,
): Promise<void> {
  await pool.query(
    `insert into location_reference (tiploc, name, stanox, raw_source_json) values ($1, $2, $3, '{}')`,
    [tiploc, name, stanox],
  );
  createdLocationReferenceTiplocs.push(tiploc);
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

  it("returns the headcode and honesty note with no candidates when garner has no matching schedule", async () => {
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
      expect(body.headcode).toBe("1A23");
      expect(body.effective).toBeNull();
      expect(body.candidateSchedules).toEqual([]);
      expect(body.note).toContain("ADR 0002");
    } finally {
      await app.close();
    }
  });

  it("picks the single STP-effective schedule for the headcode and marks it effective", async () => {
    const area = uniqueArea();
    await seedOccupiedBerth(area, "0002", "2A16");
    const scheduleId = await seedSchedule("2A16", "P");

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/td/areas/${area}/berths/0002/current-run`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.candidateSchedules).toHaveLength(1);
      expect(body.candidateSchedules[0]).toMatchObject({
        scheduleId: String(scheduleId),
        isEffective: true,
        activatedToday: false,
      });
      expect(body.effective).toMatchObject({
        scheduleId: String(scheduleId),
        selectedBy: "stp_precedence",
        activation: null,
      });
    } finally {
      await app.close();
    }
  });

  it("leaves `effective` null when two same-precedence schedules share the headcode and neither is activated", async () => {
    const area = uniqueArea();
    await seedOccupiedBerth(area, "0003", "3A16");
    await seedSchedule("3A16", "P");
    await seedSchedule("3A16", "P");

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/td/areas/${area}/berths/0003/current-run`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.candidateSchedules).toHaveLength(2);
      expect(body.effective).toBeNull();
      expect(body.candidateSchedules.every((c: { isEffective: boolean }) => !c.isEffective)).toBe(
        true,
      );
    } finally {
      await app.close();
    }
  });

  it("breaks an STP tie using a TRUST activation seen today and surfaces its latest movement", async () => {
    const area = uniqueArea();
    await seedOccupiedBerth(area, "0004", "4A16");
    await seedSchedule("4A16", "P");
    const activatedId = await seedSchedule("4A16", "P");
    const trustId = await seedActivation(activatedId, "4A16");
    // flags: departure (0x01) + LATE (0x10); 3 minutes late.
    await seedMovement(trustId, "11224", 0x01 | 0x10, 3);
    await seedLocationReference(`LR${activatedId}`, "Test Loc", "11224");

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/td/areas/${area}/berths/0004/current-run`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.effective).toMatchObject({
        scheduleId: String(activatedId),
        selectedBy: "trust_activation",
      });
      expect(body.effective.activation).toMatchObject({ trustId, deduced: false, tocId: "NT" });
      expect(body.effective.latestMovement).toMatchObject({
        trustId,
        eventKind: "departure",
        variationStatus: "late",
        variationMinutes: 3,
        locName: "Test Loc",
      });
    } finally {
      await app.close();
    }
  });

  it("resolves TIPLOCs to CORPUS names for origin/destination and each calling point", async () => {
    const area = uniqueArea();
    const originTiploc = `OR${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    const destTiploc = `DE${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    const untimedTiploc = `UN${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await seedLocationReference(originTiploc, "Test Origin");
    await seedLocationReference(destTiploc, "Test Destination");

    await seedOccupiedBerth(area, "0005", "5Y01");
    const scheduleId = await seedSchedule("5Y01", "P");
    await seedScheduleLocation(scheduleId, 1, originTiploc, "LO", { departure: "0900" });
    await seedScheduleLocation(scheduleId, 2, untimedTiploc, "LI");
    await seedScheduleLocation(scheduleId, 3, destTiploc, "LT", { arrival: "0930" });

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/td/areas/${area}/berths/0005/current-run`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.effective.originName).toBe("Test Origin");
      expect(body.effective.destinationName).toBe("Test Destination");
      const locations = body.effective.locations as Array<{
        tiploc: string;
        locationName: string | null;
      }>;
      expect(locations.find((l) => l.tiploc === originTiploc)?.locationName).toBe("Test Origin");
      expect(locations.find((l) => l.tiploc === destTiploc)?.locationName).toBe("Test Destination");
      expect(locations.find((l) => l.tiploc === untimedTiploc)?.locationName).toBeNull();
    } finally {
      await app.close();
    }
  });
});
