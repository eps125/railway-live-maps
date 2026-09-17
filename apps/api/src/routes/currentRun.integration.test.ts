import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import type { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { registerCurrentRunRoutes } from "./currentRun.js";
import { createSession, SESSION_COOKIE_NAME } from "../auth/session.js";

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
const createdSmartBerthStepIds: string[] = [];
const createdTrainAllocationIds: number[] = [];

/** Minimal in-memory stand-in for ioredis's `Redis` (this sandbox has no real Redis server —
 * mirrors the FakeRedis pattern in `../auth/session.test.ts`). Only the handful of methods
 * `getSession`/`createSession` actually call. */
class FakeRedis {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, value);
    return "OK";
  }
  async expire(): Promise<number> {
    return 1;
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

const fakeRedis = new FakeRedis() as unknown as Redis;
const SESSION_TTL_SECONDS = 3600;

/** Owner request (2026-09-13): the route now optionally reads a session cookie to decide full
 * vs. reduced/anonymous detail — most existing tests here are exercising the *full* response
 * shape, so they authenticate via this helper. The new anonymous-specific tests below
 * deliberately omit it. */
async function authHeaders(): Promise<{ cookie: string }> {
  const token = await createSession(
    fakeRedis,
    { userId: randomUUID(), username: "test-editor", role: "editor" },
    SESSION_TTL_SECONDS,
  );
  return { cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

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
    // docs/adr/0009: the mirrored "change" tables — cleaned up first since none of them carry a
    // foreign key back to trust_activation (ADR 0002's deliberate choice), so ordering here is
    // just tidiness, not a constraint requirement.
    await pool.query("delete from trust_changeorigin where trust_id = any($1::text[])", [
      createdTrustIds,
    ]);
    await pool.query("delete from trust_changeid where trust_id = any($1::text[])", [
      createdTrustIds,
    ]);
    await pool.query("delete from trust_changelocation where trust_id = any($1::text[])", [
      createdTrustIds,
    ]);
    await pool.query("delete from trust_cancellation where trust_id = any($1::text[])", [
      createdTrustIds,
    ]);
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
  if (createdSmartBerthStepIds.length > 0) {
    await pool.query("delete from smart_berth_step where id = any($1::bigint[])", [
      createdSmartBerthStepIds,
    ]);
  }
  if (createdTrainAllocationIds.length > 0) {
    await pool.query("delete from train_allocation where id = any($1::bigint[])", [
      createdTrainAllocationIds,
    ]);
  }
  await pool.end();
});

function uniqueArea(): string {
  return `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
}

/** Same Europe/London date the route computes internally (`londonToday`) — for seeding
 * `train_allocation.schedule_start_date` against "today" reliably. */
function londonTodayDateString(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

/** The calendar day before `londonTodayDateString()` — for seeding an overnight train's schedule
 * as if it only ever covered yesterday's traffic day (docs/adr/0008's fix), deterministically
 * regardless of what time of day this test actually runs. */
function londonYesterdayDateString(): string {
  const today = new Date(`${londonTodayDateString()}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);
}

/** Milestone 35: the route computes "now" from a real `new Date()` internally (not injectable),
 * so these tests seed schedule times relative to the actual current London wall-clock time
 * rather than a fixed one — mirrors `currentRun.ts`'s own `londonMinutesSinceMidnight`. Returns
 * an `HHMM` string `offsetMinutes` away (wrapping at the day boundary), for seeding
 * `cif_schedule_locations` times. */
function londonHHMMOffsetFromNow(offsetMinutes: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const nowMinutes = hour * 60 + minute;
  const targetMinutes = (((nowMinutes + offsetMinutes) % 1440) + 1440) % 1440;
  const targetHour = Math.floor(targetMinutes / 60);
  const targetMinute = Math.floor(targetMinutes % 60);
  return `${String(targetHour).padStart(2, "0")}${String(targetMinute).padStart(2, "0")}`;
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

/** Like `seedSchedule`, but with an explicit `schedule_start_date`/`schedule_end_date` instead of
 * the usual "always covers today" ±30-day window — for docs/adr/0008 fixtures that need a
 * schedule to be valid on exactly one specific calendar date (e.g. only yesterday's), regardless
 * of what time of day the test actually runs. */
async function seedScheduleForDateRange(
  signallingId: string,
  stpIndicator: "C" | "N" | "O" | "P",
  startDate: string,
  endDate: string,
): Promise<number> {
  const id = newScheduleId();
  await pool.query(
    `insert into cif_schedules (
       id, created, cif_stp_indicator, cif_train_uid,
       runs_mo, runs_tu, runs_we, runs_th, runs_fr, runs_sa, runs_su,
       schedule_start_date, schedule_end_date, signalling_id, atoc_code, cif_train_service_code
     ) values ($1, now(), $2, $3, true,true,true,true,true,true,true,
       $4::date, $5::date, $6, 'NT', '11111000')`,
    [id, stpIndicator, `U${id}`, startDate, endDate, signallingId],
  );
  createdScheduleIds.push(id);
  return id;
}

/** Like `seedSchedule`, but with an explicit `cif_train_uid` instead of the usual auto-derived
 * `U<id>` — for fixtures needing two schedule *rows* (e.g. a Permanent + Overlay pair) that share
 * one physical train's identity, to distinguish that from two genuinely different trains sharing
 * a headcode (docs/adr/0008 second addendum). */
async function seedScheduleForTrainUid(
  signallingId: string,
  stpIndicator: "C" | "N" | "O" | "P",
  trainUid: string,
): Promise<number> {
  const id = newScheduleId();
  await pool.query(
    `insert into cif_schedules (
       id, created, cif_stp_indicator, cif_train_uid,
       runs_mo, runs_tu, runs_we, runs_th, runs_fr, runs_sa, runs_su,
       schedule_start_date, schedule_end_date, signalling_id, atoc_code, cif_train_service_code
     ) values ($1, now(), $2, $3, true,true,true,true,true,true,true,
       (now() - interval '30 days')::date, (now() + interval '30 days')::date, $4, 'NT', '11111000')`,
    [id, stpIndicator, trainUid, signallingId],
  );
  createdScheduleIds.push(id);
  return id;
}

/** Like `seedActivation`, but backdated to `createdAt` — for docs/adr/0008 fixtures proving an
 * overnight train's activation from *before* London midnight still counts once the calendar
 * rolls over, now that the cutoff widens to yesterday rather than staying pinned to today. */
async function seedActivationAt(scheduleId: number, createdAt: Date): Promise<string> {
  const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  createdTrustIds.push(trustId);
  await pool.query(
    `insert into trust_activation (trust_id, created, cif_schedule_id, deduced)
     values ($1, $2, $3, 0)`,
    [trustId, createdAt, scheduleId],
  );
  await pool.query(
    `insert into trust_activation_extra (trust_id, created, train_uid, toc_id, schedule_wtt_id)
     values ($1, $2, $3, 'NT', $4)`,
    [trustId, createdAt, `U${scheduleId}`, `W${scheduleId}`],
  );
  return trustId;
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

/** docs/adr/0010: an activation under an *exact*, caller-chosen 10-character trust_id — needed
 * (unlike `seedActivation`'s random id) whenever a test cares about the TRUST id's own encoding,
 * e.g. `findSchedulesByIdentityHeadcodeChange`'s headcode-from-trust_id decoding. */
async function seedActivationWithTrustId(scheduleId: number, trustId: string): Promise<void> {
  createdTrustIds.push(trustId);
  await pool.query(
    `insert into trust_activation (trust_id, created, cif_schedule_id, deduced)
     values ($1, now(), $2, 0)`,
    [trustId, scheduleId],
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

/** docs/adr/0009: garner's TRUST Change of Origin mirror (migration 0025) — `locStanox` is the
 * STANOX the run now actually originates from. */
async function seedChangeOrigin(trustId: string, locStanox: string, reason = "OP"): Promise<void> {
  await pool.query(
    `insert into trust_changeorigin (trust_id, created, reason, loc_stanox) values ($1, now(), $2, $3)`,
    [trustId, reason, locStanox],
  );
}

/** docs/adr/0009: garner's TRUST Change of Identity mirror — `newTrustId` is registered with
 * `createdTrustIds` too, so `afterAll` cleans up whatever it wrote under the new identity as well
 * as the old one. */
async function seedChangeId(trustId: string, newTrustId: string): Promise<void> {
  createdTrustIds.push(newTrustId);
  await pool.query(
    `insert into trust_changeid (trust_id, created, new_trust_id) values ($1, now(), $2)`,
    [trustId, newTrustId],
  );
}

/** docs/adr/0009: garner's TRUST Change of Location mirror — revises one scheduled calling point
 * from `originalStanox` to `stanox`. */
async function seedChangeLocation(
  trustId: string,
  originalStanox: string,
  stanox: string,
): Promise<void> {
  await pool.query(
    `insert into trust_changelocation (trust_id, created, original_stanox, stanox) values ($1, now(), $2, $3)`,
    [trustId, originalStanox, stanox],
  );
}

/** docs/adr/0009: garner's TRUST Cancellation mirror — a part-cancellation (`reinstate = 0`, a
 * `locStanox`) is read as the run's new effective destination (owner-confirmed 2026-09-17 reading:
 * TRUST has no dedicated "change of destination" message); `reinstate = 1` cancels that back out. */
async function seedCancellation(
  trustId: string,
  locStanox: string,
  reinstate: 0 | 1,
  reason = "OP",
): Promise<void> {
  await pool.query(
    `insert into trust_cancellation (trust_id, created, reason, type, loc_stanox, reinstate)
     values ($1, now(), $2, 'P', $3, $4)`,
    [trustId, reason, locStanox, reinstate],
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

/** Milestone 34 (docs/adr/0006): a berth's SMART-derived STANOX — the position-scoping input.
 * `from_berth`/`to_berth` both accept the seeded berth; tests use `from_berth`. */
async function seedSmartBerthStep(tdArea: string, berth: string, stanox: string): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `insert into smart_berth_step (td_area, from_berth, to_berth, stanox, event_type, raw_source_json)
     values ($1, $2, $3, $4, 'A', '{}') returning id`,
    [tdArea, berth, `${berth}X`, stanox],
  );
  createdSmartBerthStepIds.push(result.rows[0]!.id);
}

/** Owner request (2026-09-13): real unit/stock allocation, mirrored from garner's
 * `train_allocation` (migration 0031). One row per unit; `position` orders a multi-unit
 * formation. */
async function seedTrainAllocation(
  cifTrainUid: string,
  scheduleStartDate: string,
  unitNo: string,
  position: number,
  vehicles: string,
  reported: Date = new Date(),
): Promise<void> {
  const id = newScheduleId();
  await pool.query(
    `insert into train_allocation (
       id, cif_train_uid, headcode, schedule_start_date, origin_tiploc, dest_tiploc,
       unit_no, "position", fleet_id, vehicles, reported, message_id
     ) values ($1, $2, 'TEST', $3::date, 'ORIGIN', 'DEST', $4, $5, '465/0', $6, $7, $8)`,
    [id, cifTrainUid, scheduleStartDate, unitNo, position, vehicles, reported, randomUUID()],
  );
  createdTrainAllocationIds.push(id);
}

async function buildApp() {
  const app = Fastify();
  await app.register(fastifyCookie);
  await registerCurrentRunRoutes(app, {
    pool,
    redis: fakeRedis,
    sessionTtlSeconds: SESSION_TTL_SECONDS,
  });
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
        headers: await authHeaders(),
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
        headers: await authHeaders(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.headcode).toBe("1A23");
      expect(body.matchStatus).toBe("unmatched");
      expect(body.matchBasis).toBeNull();
      expect(body.effective).toBeNull();
      expect(body.candidateSchedules).toEqual([]);
      expect(body.note).toContain("No candidate schedule found");
      // Regression (2026-09-14, PX 0127/0133): an unmatched berth has no effective train to key
      // an allocation by, which the web popup's `unitAllocation.length` renders unconditionally —
      // `null` here crashed the whole page with no error boundary to catch it.
      expect(body.unitAllocation).toEqual([]);
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
        headers: await authHeaders(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.candidateSchedules).toHaveLength(1);
      expect(body.candidateSchedules[0]).toMatchObject({
        scheduleId: String(scheduleId),
        isEffective: true,
        activatedToday: false,
      });
      // No SMART data seeded for this berth — falls to the unscoped headcode_only tier, even
      // though STP precedence is what actually picked the single candidate within it.
      expect(body.matchStatus).toBe("matched");
      expect(body.matchBasis).toBe("headcode_only");
      expect(body.positionScoped).toBe(false);
      expect(body.effective).toMatchObject({
        scheduleId: String(scheduleId),
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
        headers: await authHeaders(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.candidateSchedules).toHaveLength(2);
      expect(body.matchStatus).toBe("ambiguous");
      expect(body.matchBasis).toBe("headcode_only");
      expect(body.effective).toBeNull();
      expect(body.candidateSchedules.every((c: { isEffective: boolean }) => !c.isEffective)).toBe(
        true,
      );
      // Same regression as the unmatched case above — ambiguous also has no single effective
      // train, so this must stay `[]`, not `null`.
      expect(body.unitAllocation).toEqual([]);
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
        headers: await authHeaders(),
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      // No SMART data seeded — headcode_only tier — even though the activation is what actually
      // broke the tie inside it.
      expect(body.matchStatus).toBe("matched");
      expect(body.matchBasis).toBe("headcode_only");
      expect(body.effective).toMatchObject({ scheduleId: String(activatedId) });
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
        headers: await authHeaders(),
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

  describe("position scoping (Milestone 34, docs/adr/0006)", () => {
    it("excludes a same-headcode schedule calling nowhere near this berth's SMART-derived STANOX", async () => {
      const area = uniqueArea();
      const nearTiploc = `NR${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const farTiploc = `FR${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(nearTiploc, "Near Loc", stanox);
      await seedSmartBerthStep(area, "0006", stanox);

      await seedOccupiedBerth(area, "0006", "6A16");
      const nearId = await seedSchedule("6A16", "P");
      await seedScheduleLocation(nearId, 1, nearTiploc, "LO", { departure: "0900" });
      const farId = await seedSchedule("6A16", "P");
      await seedScheduleLocation(farId, 1, farTiploc, "LO", { departure: "0900" });

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0006/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.positionScoped).toBe(true);
        expect(body.matchStatus).toBe("matched");
        expect(body.matchBasis).toBe("stp_precedence");
        // Only the near schedule was ever a candidate — the far one, despite sharing the
        // headcode, calls nowhere this berth's SMART data says is plausible.
        expect(body.candidateSchedules).toHaveLength(1);
        expect(body.effective.scheduleId).toBe(String(nearId));
      } finally {
        await app.close();
      }
    });

    it("is ambiguous when two position-scoped candidates share the headcode and neither is activated", async () => {
      const area = uniqueArea();
      const tiploc = `TP${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(tiploc, "Shared Loc", stanox);
      await seedSmartBerthStep(area, "0007", stanox);

      await seedOccupiedBerth(area, "0007", "7A16");
      const idA = await seedSchedule("7A16", "P");
      // No calling time seeded at all — the Milestone 35 station_berth_timetable tier has
      // nothing to disambiguate by, so this proves the plain STP-tie case still falls back to
      // an honest ambiguous stp_precedence result rather than picking one.
      await seedScheduleLocation(idA, 1, tiploc, "LO");
      const idB = await seedSchedule("7A16", "P");
      await seedScheduleLocation(idB, 1, tiploc, "LO");
      void idA;
      void idB;

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0007/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.positionScoped).toBe(true);
        expect(body.matchStatus).toBe("ambiguous");
        expect(body.matchBasis).toBe("stp_precedence");
        expect(body.effective).toBeNull();
        expect(body.candidateSchedules).toHaveLength(2);
      } finally {
        await app.close();
      }
    });

    it("prefers a TRUST activation over STP precedence among position-scoped candidates", async () => {
      const area = uniqueArea();
      const tiploc = `TA${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(tiploc, "Activated Loc", stanox);
      await seedSmartBerthStep(area, "0008", stanox);

      await seedOccupiedBerth(area, "0008", "8A16");
      await seedSchedule("8A16", "P"); // unactivated sibling — would otherwise tie on STP.
      const activatedId = await seedSchedule("8A16", "P");
      await seedScheduleLocation(activatedId, 1, tiploc, "LO", { departure: "0900" });
      const trustId = await seedActivation(activatedId, "8A16");
      void trustId;

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0008/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.positionScoped).toBe(true);
        expect(body.matchStatus).toBe("matched");
        expect(body.matchBasis).toBe("trust_activation");
        // The unactivated sibling never had a schedule location at this TIPLOC, so it was
        // never a position-scoped candidate in the first place — only the activated one.
        expect(body.candidateSchedules).toHaveLength(1);
        expect(body.effective.scheduleId).toBe(String(activatedId));
      } finally {
        await app.close();
      }
    });

    it("stays unmatched when the position-scoped search comes back empty, rather than falling back nationwide", async () => {
      const area = uniqueArea();
      const nearTiploc = `EM${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const elsewhereTiploc = `EL${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(nearTiploc, "Empty Near Loc", stanox);
      await seedSmartBerthStep(area, "0009", stanox);

      await seedOccupiedBerth(area, "0009", "9A16");
      // This schedule shares the headcode but calls nowhere near berth 0009's SMART STANOX —
      // if the fallback wrongly triggered on an empty scoped result, this would be (wrongly)
      // matched instead.
      const elsewhereId = await seedSchedule("9A16", "P");
      await seedScheduleLocation(elsewhereId, 1, elsewhereTiploc, "LO", { departure: "0900" });

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0009/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.positionScoped).toBe(true);
        expect(body.matchStatus).toBe("unmatched");
        expect(body.matchBasis).toBeNull();
        expect(body.candidateSchedules).toEqual([]);
      } finally {
        await app.close();
      }
    });
  });

  describe("station_berth_timetable tier (Milestone 35)", () => {
    it("matches the candidate scheduled hours in the future over one scheduled soon — the early-interpose case", async () => {
      const area = uniqueArea();
      const tiploc = `ST${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(tiploc, "Station Loc", stanox);
      await seedSmartBerthStep(area, "0010", stanox);

      await seedOccupiedBerth(area, "0010", "1X10");
      // Both same STP precedence (P), so STP alone is ambiguous between them.
      const dueSoon = await seedSchedule("1X10", "P");
      await seedScheduleLocation(dueSoon, 1, tiploc, "LO", {
        departure: londonHHMMOffsetFromNow(30),
      });
      const dueLater = await seedSchedule("1X10", "P");
      await seedScheduleLocation(dueLater, 1, tiploc, "LO", {
        departure: londonHHMMOffsetFromNow(5 * 60), // interposed hours early — still the real match
      });

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0010/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("matched");
        expect(body.matchBasis).toBe("station_berth_timetable");
        expect(body.effective.scheduleId).toBe(String(dueSoon));
      } finally {
        await app.close();
      }
    });

    it("still matches a candidate whose scheduled time is nominally in the past, when it's the closest — running late, not excluded", async () => {
      const area = uniqueArea();
      const tiploc = `LT${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(tiploc, "Late Loc", stanox);
      await seedSmartBerthStep(area, "0011", stanox);

      await seedOccupiedBerth(area, "0011", "2X11");
      const runningLate = await seedSchedule("2X11", "P");
      await seedScheduleLocation(runningLate, 1, tiploc, "LO", {
        departure: londonHHMMOffsetFromNow(-15), // nominally 15 min ago, actually still here
      });
      const muchLaterToday = await seedSchedule("2X11", "P");
      await seedScheduleLocation(muchLaterToday, 1, tiploc, "LO", {
        departure: londonHHMMOffsetFromNow(10 * 60),
      });

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0011/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("matched");
        expect(body.matchBasis).toBe("station_berth_timetable");
        expect(body.effective.scheduleId).toBe(String(runningLate));
      } finally {
        await app.close();
      }
    });

    it("stays ambiguous when neither STP nor timing can separate two same-headcode candidates", async () => {
      const area = uniqueArea();
      const tiploc = `TB${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(tiploc, "Tied Loc", stanox);
      await seedSmartBerthStep(area, "0012", stanox);

      await seedOccupiedBerth(area, "0012", "3X12");
      const a = await seedSchedule("3X12", "P");
      await seedScheduleLocation(a, 1, tiploc, "LO", { departure: londonHHMMOffsetFromNow(-5) });
      const b = await seedSchedule("3X12", "P");
      await seedScheduleLocation(b, 1, tiploc, "LO", { departure: londonHHMMOffsetFromNow(5) });
      void a;
      void b;

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0012/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("ambiguous");
        expect(body.matchBasis).toBe("station_berth_timetable");
        expect(body.effective).toBeNull();
      } finally {
        await app.close();
      }
    });
  });

  describe("traffic-day boundary (docs/adr/0008)", () => {
    // Real incident this fixes (2026-09-14): PX 0052, headcode 5F05, train UID W33229, departed
    // 23:28 the previous night, its schedule dated only that one day — went `unmatched` the
    // instant the London calendar rolled over past midnight, even though it was still genuinely
    // running. These fixtures pin the schedule to *yesterday's* date explicitly so the test is
    // deterministic regardless of what time of day it actually runs, rather than needing to wait
    // for real midnight.
    it("still matches a schedule dated only yesterday, not unmatched the instant the calendar rolls over", async () => {
      const area = uniqueArea();
      const yesterday = londonYesterdayDateString();
      await seedOccupiedBerth(area, "0020", "5F05");
      const scheduleId = await seedScheduleForDateRange("5F05", "P", yesterday, yesterday);

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0020/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("matched");
        expect(body.effective.scheduleId).toBe(String(scheduleId));
      } finally {
        await app.close();
      }
    });

    it("still counts a TRUST activation created before London midnight for a schedule dated only yesterday", async () => {
      const area = uniqueArea();
      const yesterday = londonYesterdayDateString();
      await seedOccupiedBerth(area, "0021", "6F06");
      // Two same-precedence candidates, both dated only yesterday — would be ambiguous by STP
      // alone; only one has an activation from last night, which must still count today.
      await seedScheduleForDateRange("6F06", "P", yesterday, yesterday);
      const activatedId = await seedScheduleForDateRange("6F06", "P", yesterday, yesterday);
      // 22:00 UTC on yesterday's date is always within *yesterday's* London calendar day
      // (23:00 BST or 22:00 GMT, either way still before midnight) — unlike a fixed "N hours
      // ago" offset, which drifts onto today's calendar date depending on what wall-clock time
      // this test happens to run at (ADR 0008 addendum: ambiguous-tier regression, 2026-09-15,
      // once the activation check became date-scoped rather than "anywhere in the window").
      const lastNight = new Date(`${yesterday}T22:00:00Z`);
      const trustId = await seedActivationAt(activatedId, lastNight);

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0021/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("matched");
        expect(body.matchBasis).toBe("headcode_only");
        expect(body.effective.scheduleId).toBe(String(activatedId));
        expect(body.effective.activation).toMatchObject({ trustId });
      } finally {
        await app.close();
      }
    });

    it("keys unit allocation by the match's actual traffic day, not hardcoded today, for a yesterday-dated schedule", async () => {
      const area = uniqueArea();
      const yesterday = londonYesterdayDateString();
      await seedOccupiedBerth(area, "0022", "7F07");
      const scheduleId = await seedScheduleForDateRange("7F07", "P", yesterday, yesterday);
      const cifTrainUid = `U${scheduleId}`;
      await seedTrainAllocation(cifTrainUid, yesterday, "390050", 1, "one two");

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0022/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("matched");
        expect(body.unitAllocation).toEqual([
          {
            unitNo: "390050",
            position: 1,
            fleetId: "465/0",
            vehicles: ["one", "two"],
            reportedAt: expect.any(String),
          },
        ]);
      } finally {
        await app.close();
      }
    });

    it("prefers today's own instance over yesterday's when a schedule covers both", async () => {
      // The common, non-overnight case must keep behaving exactly as before: given a schedule
      // that genuinely runs both today and yesterday, the match should resolve against today.
      const area = uniqueArea();
      await seedOccupiedBerth(area, "0023", "8F08");
      const scheduleId = await seedSchedule("8F08", "P"); // covers now ± 30 days, i.e. both dates
      const cifTrainUid = `U${scheduleId}`;
      const today = londonTodayDateString();
      await seedTrainAllocation(cifTrainUid, today, "390100", 1, "abc");

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0023/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("matched");
        expect(body.unitAllocation).toEqual([
          {
            unitNo: "390100",
            position: 1,
            fleetId: "465/0",
            vehicles: ["abc"],
            reportedAt: expect.any(String),
          },
        ]);
      } finally {
        await app.close();
      }
    });

    it("does not let a same-headcode sibling's stale prior-day activation cause a false ambiguous result — the PX 0107 / 1Y61 regression (addendum)", async () => {
      // Real incident (2026-09-15): both G89843 (activated ~08:25 this morning, for today's
      // ~10:52 working) and G89845 (last activated the evening before, for ITS OWN prior-day
      // working — not due again until tonight) share headcode 1Y61 and both call at the same
      // position-scoped berth every day. Widening the TRUST activation query to also fetch
      // yesterday's rows (needed for the overnight-train case above) meant G89845's stale
      // prior-day row started counting as "activated" for today's tier too, wrongly reporting
      // `ambiguous` instead of matching G89843 cleanly.
      const area = uniqueArea();
      const tiploc = `PY${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(tiploc, "Prior Day Loc", stanox);
      await seedSmartBerthStep(area, "0024", stanox);

      await seedOccupiedBerth(area, "0024", "1Y99");
      const activatedTodayId = await seedSchedule("1Y99", "P");
      await seedScheduleLocation(activatedTodayId, 1, tiploc, "LO", { departure: "0900" });
      await seedActivation(activatedTodayId, "1Y99"); // created = now(), i.e. today

      const activatedYesterdayId = await seedSchedule("1Y99", "P");
      await seedScheduleLocation(activatedYesterdayId, 1, tiploc, "LO", { departure: "2000" });
      const yesterdayNoon = new Date(`${londonYesterdayDateString()}T12:00:00Z`);
      await seedActivationAt(activatedYesterdayId, yesterdayNoon);

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0024/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("matched");
        expect(body.matchBasis).toBe("trust_activation");
        expect(body.effective.scheduleId).toBe(String(activatedTodayId));
      } finally {
        await app.close();
      }
    });
  });

  describe("public/anonymous access (owner request 2026-09-13)", () => {
    it("404s NO_PUBLIC_DETAIL for an anonymous request when unmatched — no popup at all", async () => {
      const area = uniqueArea();
      await seedOccupiedBerth(area, "0013", "4X13"); // no schedule seeded at all
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0013/current-run`,
          // no auth headers — anonymous
        });
        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe("NO_PUBLIC_DETAIL");
      } finally {
        await app.close();
      }
    });

    it("404s NO_PUBLIC_DETAIL for an anonymous request when ambiguous", async () => {
      const area = uniqueArea();
      await seedOccupiedBerth(area, "0014", "5X14");
      await seedSchedule("5X14", "P");
      await seedSchedule("5X14", "P");
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0014/current-run`,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe("NO_PUBLIC_DETAIL");
      } finally {
        await app.close();
      }
    });

    it("returns a reduced public response for an unscoped (headcode_only) match, when the unscoped search found only one running candidate", async () => {
      // Owner decision (2026-09-15): headcode_only is weak because the headcode *could* collide
      // with an unrelated train elsewhere — but when the unscoped search found exactly one
      // running candidate, that collision risk is provably zero, so it's solid enough to show
      // publicly (matchBasis still reports headcode_only — it genuinely was found by headcode
      // alone — this only affects public visibility).
      const area = uniqueArea();
      await seedOccupiedBerth(area, "0015", "6X15");
      const scheduleId = await seedSchedule("6X15", "P"); // no SMART data seeded — unscoped match
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0015/current-run`,
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("matched");
        expect(body.effective.scheduleId).toBeUndefined(); // reduced view — internal id withheld
        expect(body.matchBasis).toBeUndefined();
        void scheduleId;
      } finally {
        await app.close();
      }
    });

    it("still 404s NO_PUBLIC_DETAIL for an anonymous request when the unscoped search found more than one running candidate", async () => {
      // The genuine collision risk `headcode_only` is weak about — two same-headcode, same-day
      // candidates nationwide with no position data to tell them apart — must stay hidden from
      // anonymous visitors even though the resolver itself may still confidently pick one via
      // STP precedence (rule 5: never assume a headcode uniquely identifies a run).
      const area = uniqueArea();
      await seedOccupiedBerth(area, "0027", "7X27");
      await seedSchedule("7X27", "P");
      await seedSchedule("7X27", "O"); // Overlay beats Permanent outright — still resolves cleanly
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0027/current-run`,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe("NO_PUBLIC_DETAIL");
      } finally {
        await app.close();
      }
    });

    it("returns a reduced public response when two candidate ROWS share one train's identity (Permanent + Overlay), not two different trains", async () => {
      // The unscoped search's candidate count must be counted by distinct cif_train_uid, not raw
      // schedule rows — a single physical train routinely has both a Permanent and an Overlay row
      // simultaneously satisfying today's date/bitmask before STP precedence even runs. Counting
      // rows would wrongly treat this as "two candidates" and hide a perfectly safe match.
      const area = uniqueArea();
      await seedOccupiedBerth(area, "0028", "8X28");
      const trainUid = `U${Date.now()}`;
      await seedScheduleForTrainUid("8X28", "P", trainUid);
      const overlayId = await seedScheduleForTrainUid("8X28", "O", trainUid); // same train, wins STP
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0028/current-run`,
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("matched");
        void overlayId;
      } finally {
        await app.close();
      }
    });

    it("returns a reduced public response when a TRUST activation cleanly picks one of several nationwide candidates, even though more than one train shares the headcode", async () => {
      // Real report (2026-09-15): PX 0188, headcode 1C55 — two genuinely different real trains
      // (G89047 and a separate Portsmouth-Horsham service) both scheduled under this headcode
      // today, with no SMART position data to tell them apart, but only G89047 had a live TRUST
      // activation. TRUST activation isn't inferred from the headcode text — it's created by
      // Network Rail's own systems already linked to one specific schedule — and the case where
      // *two* real trains both get activated is already caught as ambiguous one tier up in
      // resolveRunMatch (never a silent pick, CLAUDE.md rule 7), so a *clean* activation win here
      // is solid even amid multiple nationwide candidates.
      const area = uniqueArea();
      await seedOccupiedBerth(area, "0029", "1C55");
      await seedSchedule("1C55", "P"); // a different, unrelated train sharing the headcode
      const activatedId = await seedSchedule("1C55", "P");
      const trustId = await seedActivation(activatedId, "1C55");
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0029/current-run`,
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("matched");
        void trustId;
      } finally {
        await app.close();
      }
    });

    it("still 404s when more than one train_uid shares the headcode and STP precedence alone (no activation) breaks the tie", async () => {
      // The residual risk that must stay hidden: an Overlay beating a Permanent across two
      // DIFFERENT trains isn't real identity verification — it's meaningful only within one
      // train's own schedule variants — so without position data or a genuine activation, this
      // stays weak. (Distinct from the Permanent+Overlay-same-train case above.)
      const area = uniqueArea();
      await seedOccupiedBerth(area, "0030", "9X30");
      const suffix = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
      await seedScheduleForTrainUid("9X30", "P", `A${suffix}`);
      await seedScheduleForTrainUid("9X30", "O", `B${suffix}`); // different train, wins STP
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0030/current-run`,
        });
        expect(response.statusCode).toBe(404);
        expect(response.json().error.code).toBe("NO_PUBLIC_DETAIL");
      } finally {
        await app.close();
      }
    });

    it("returns a reduced, departure-board-style response for an anonymous request on a solid (position-scoped) match", async () => {
      const area = uniqueArea();
      const tiploc = `PB${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(tiploc, "Public Loc", stanox);
      await seedSmartBerthStep(area, "0016", stanox);

      await seedOccupiedBerth(area, "0016", "7X16");
      const scheduleId = await seedSchedule("7X16", "P");
      await seedScheduleLocation(scheduleId, 1, tiploc, "LO", { departure: "0900" });

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0016/current-run`,
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("matched");
        expect(body.headcode).toBe("7X16");
        expect(body.effective).toMatchObject({
          originTiploc: tiploc,
          originName: "Public Loc",
        });
        // Never shown to anonymous visitors — internal identifiers and resolver mechanics.
        expect(body.matchBasis).toBeUndefined();
        expect(body.positionScoped).toBeUndefined();
        expect(body.candidateSchedules).toBeUndefined();
        expect(body.effective.scheduleId).toBeUndefined();
        expect(body.effective.trainUid).toBeUndefined();
        expect(body.effective.activation).toBeUndefined();
        expect(body.effective.latestMovement).toBeUndefined();
        // Owner request (2026-09-14): no `note` for anonymous visitors either — its "matched by
        // TRUST activation/STP precedence" language is resolver-internal, backend-only.
        expect(body.note).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it("includes unit allocation for both anonymous and authenticated requests, ordered by formation position", async () => {
      const area = uniqueArea();
      const tiploc = `UA${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(tiploc, "Unit Alloc Loc", stanox);
      await seedSmartBerthStep(area, "0017", stanox);

      await seedOccupiedBerth(area, "0017", "8X17");
      const scheduleId = await seedSchedule("8X17", "P");
      await seedScheduleLocation(scheduleId, 1, tiploc, "LO", { departure: "0900" });
      const cifTrainUid = `U${scheduleId}`;
      const today = londonTodayDateString();
      await seedTrainAllocation(cifTrainUid, today, "465029", 1, "64787 72084 72085 64837");
      await seedTrainAllocation(cifTrainUid, today, "465004", 2, "64762 72034 72035 64812");

      const app = await buildApp();
      try {
        const anonResponse = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0017/current-run`,
        });
        expect(anonResponse.statusCode).toBe(200);
        const anonBody = anonResponse.json();
        expect(anonBody.unitAllocation).toEqual([
          {
            unitNo: "465029",
            position: 1,
            fleetId: "465/0",
            vehicles: ["64787", "72084", "72085", "64837"],
            reportedAt: expect.any(String),
          },
          {
            unitNo: "465004",
            position: 2,
            fleetId: "465/0",
            vehicles: ["64762", "72034", "72035", "64812"],
            reportedAt: expect.any(String),
          },
        ]);

        const authResponse = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0017/current-run`,
          headers: await authHeaders(),
        });
        expect(authResponse.statusCode).toBe(200);
        expect(authResponse.json().unitAllocation).toEqual(anonBody.unitAllocation);
      } finally {
        await app.close();
      }
    });

    it("shows only the most recently reported unit per position when control reallocates it, not every historical report", async () => {
      // garner's train_allocation is an append-only log of allocation *reports*, not a mutable
      // "current formation" table — a position reallocated by control produces a new row each
      // time, not an update to the old one (real production example, 2026-09-14: 1P09/W34091's
      // position 1 was reallocated 6 times through the day; the popup showed all 6 units as if
      // simultaneously part of the formation).
      const area = uniqueArea();
      const tiploc = `RA${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(tiploc, "Realloc Loc", stanox);
      await seedSmartBerthStep(area, "0019", stanox);

      await seedOccupiedBerth(area, "0019", "1P19");
      const scheduleId = await seedSchedule("1P19", "P");
      await seedScheduleLocation(scheduleId, 1, tiploc, "LO", { departure: "0900" });
      const cifTrainUid = `U${scheduleId}`;
      const today = londonTodayDateString();
      const base = Date.now();
      // Deliberately out of chronological insert order — the fix must sort by `reported`, not by
      // insertion/row order, to pick the actual latest one.
      await seedTrainAllocation(
        cifTrainUid,
        today,
        "390107",
        1,
        "one",
        new Date(base - 60_000 * 60),
      );
      await seedTrainAllocation(cifTrainUid, today, "390050", 1, "four", new Date(base));
      await seedTrainAllocation(
        cifTrainUid,
        today,
        "390009",
        1,
        "two",
        new Date(base - 60_000 * 30),
      );
      // A second position stays independent — only position 1 was reallocated.
      await seedTrainAllocation(cifTrainUid, today, "390200", 2, "second", new Date(base));

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0019/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().unitAllocation).toEqual([
          {
            unitNo: "390050",
            position: 1,
            fleetId: "465/0",
            vehicles: ["four"],
            reportedAt: expect.any(String),
          },
          {
            unitNo: "390200",
            position: 2,
            fleetId: "465/0",
            vehicles: ["second"],
            reportedAt: expect.any(String),
          },
        ]);
      } finally {
        await app.close();
      }
    });

    it("unitAllocation is an empty array, not null, when nothing is allocated for a matched train", async () => {
      const area = uniqueArea();
      await seedOccupiedBerth(area, "0018", "9X18");
      await seedSchedule("9X18", "P");
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0018/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().unitAllocation).toEqual([]);
      } finally {
        await app.close();
      }
    });
  });

  describe("movement-progress refinement (2026-09-15): excluding a demonstrably already-passed candidate", () => {
    it("excludes an activated candidate whose own TRUST movements already show it past this berth's calling point — the PX 0237 / 1M11 real case", async () => {
      // Real report: W33973 activated this morning; a same-headcode Caledonian Sleeper working
      // (C04561) activated the evening before was also genuinely within the probed window, but
      // its own TRUST movement history already showed it well past this exact berth, terminated
      // hours earlier. Without the movement filter this reports ambiguous.
      const area = uniqueArea();
      const tiploc = `MV${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(tiploc, "Movement Test Loc", stanox);
      await seedSmartBerthStep(area, "0031", stanox);

      await seedOccupiedBerth(area, "0031", "1X31");

      // Still-running candidate: activated, calls here, no movement evidence of having passed.
      const stillRunningId = await seedSchedule("1X31", "P");
      await seedScheduleLocation(stillRunningId, 1, tiploc, "LO", { departure: "0900" });
      await seedActivation(stillRunningId, "1X31");

      // Already-gone candidate: also activated, also calls here (earlier in its own route), but
      // its own TRUST movements already show it well beyond this point.
      const alreadyGoneId = await seedSchedule("1X31", "P");
      await seedScheduleLocation(alreadyGoneId, 1, tiploc, "LO", { departure: "0900" });
      const downstreamTiploc = `DN${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const downstreamStanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(downstreamTiploc, "Downstream Loc", downstreamStanox);
      await seedScheduleLocation(alreadyGoneId, 2, downstreamTiploc, "LT", { arrival: "1200" });
      const alreadyGoneTrustId = await seedActivation(alreadyGoneId, "1X31");
      await seedMovement(alreadyGoneTrustId, downstreamStanox, 0x01, 0);

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0031/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("matched");
        expect(body.matchBasis).toBe("trust_activation");
        expect(body.effective.scheduleId).toBe(String(stillRunningId));
      } finally {
        await app.close();
      }
    });

    it("stays ambiguous when neither activated candidate has confirmed movement evidence of having passed this berth", async () => {
      const area = uniqueArea();
      const tiploc = `MW${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(tiploc, "No Movement Loc", stanox);
      await seedSmartBerthStep(area, "0032", stanox);

      await seedOccupiedBerth(area, "0032", "1X32");
      const idA = await seedSchedule("1X32", "P");
      await seedScheduleLocation(idA, 1, tiploc, "LO", { departure: "0900" });
      await seedActivation(idA, "1X32");
      const idB = await seedSchedule("1X32", "P");
      await seedScheduleLocation(idB, 1, tiploc, "LO", { departure: "0900" });
      await seedActivation(idB, "1X32");

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0032/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("ambiguous");
        expect(body.matchBasis).toBe("trust_activation");
      } finally {
        await app.close();
      }
    });
  });

  describe("TRUST change events reflected as the run's effective state (docs/adr/0009)", () => {
    it("shows a Change of Origin's location as the new origin, alongside what it used to be", async () => {
      const area = uniqueArea();
      const originalOriginTiploc = `OO${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const newOriginTiploc = `NO${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const newOriginStanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(originalOriginTiploc, "Original Origin");
      await seedLocationReference(newOriginTiploc, "Revised Origin", newOriginStanox);

      await seedOccupiedBerth(area, "0100", "1A01");
      const scheduleId = await seedSchedule("1A01", "P");
      await seedScheduleLocation(scheduleId, 1, originalOriginTiploc, "LO", { departure: "0900" });
      const trustId = await seedActivation(scheduleId, "1A01");
      await seedChangeOrigin(trustId, newOriginStanox);

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0100/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.effective.originTiploc).toBe(newOriginTiploc);
        expect(body.effective.originName).toBe("Revised Origin");
        expect(body.effective.originChange).toMatchObject({
          previousTiploc: originalOriginTiploc,
          previousName: "Original Origin",
        });
      } finally {
        await app.close();
      }
    });

    it("shows a part-cancellation's location as the new destination, but not once it's reinstated", async () => {
      const area = uniqueArea();
      const originalDestTiploc = `OD${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const newDestTiploc = `ND${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const newDestStanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(originalDestTiploc, "Original Dest");
      await seedLocationReference(newDestTiploc, "Revised Dest", newDestStanox);

      await seedOccupiedBerth(area, "0101", "1A02");
      const scheduleId = await seedSchedule("1A02", "P");
      await seedScheduleLocation(scheduleId, 1, originalDestTiploc, "LT", { arrival: "1000" });
      const trustId = await seedActivation(scheduleId, "1A02");
      await seedCancellation(trustId, newDestStanox, 0);

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0101/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.effective.destinationTiploc).toBe(newDestTiploc);
        expect(body.effective.destinationName).toBe("Revised Dest");
        expect(body.effective.destinationChange).toMatchObject({
          previousTiploc: originalDestTiploc,
          previousName: "Original Dest",
        });

        // Reinstated: the destination reverts to the schedule's own, unrevised one.
        await seedCancellation(trustId, newDestStanox, 1);
        const afterReinstate = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0101/current-run`,
          headers: await authHeaders(),
        });
        const afterBody = afterReinstate.json();
        expect(afterBody.effective.destinationTiploc).toBe(originalDestTiploc);
        expect(afterBody.effective.destinationChange).toBeNull();
      } finally {
        await app.close();
      }
    });

    it("shows a Change of Identity's new TRUST id, and still finds movements reported under it", async () => {
      const area = uniqueArea();
      await seedOccupiedBerth(area, "0102", "1A03");
      const scheduleId = await seedSchedule("1A03", "P");
      const trustId = await seedActivation(scheduleId, "1A03");
      const newTrustId = `T${randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
      await seedChangeId(trustId, newTrustId);
      // Reported under the *new* identity only — proves the movement lookup follows the chain
      // rather than staying pinned to the activation's original trust_id.
      const movedStanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedMovement(newTrustId, movedStanox, 0x01, 0);

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0102/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.effective.activation.trustId).toBe(trustId);
        expect(body.effective.identityChange).toMatchObject({
          previousTrustId: trustId,
          newTrustId,
        });
        expect(body.effective.latestMovement).toMatchObject({ trustId: newTrustId });
      } finally {
        await app.close();
      }
    });

    it("replaces a revised calling point with its Change of Location target, in place, not struck through (only openrail's own detail page strikes it through)", async () => {
      const area = uniqueArea();
      const originalTiploc = `OL${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const originalStanox = randomUUID().replace(/-/g, "").slice(0, 5);
      const newTiploc = `NL${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      const newStanox = randomUUID().replace(/-/g, "").slice(0, 5);
      await seedLocationReference(originalTiploc, "Original Call", originalStanox);
      await seedLocationReference(newTiploc, "Revised Call", newStanox);

      await seedOccupiedBerth(area, "0103", "1A04");
      const scheduleId = await seedSchedule("1A04", "P");
      await seedScheduleLocation(scheduleId, 1, originalTiploc, "LI", { arrival: "1000" });
      const trustId = await seedActivation(scheduleId, "1A04");
      await seedChangeLocation(trustId, originalStanox, newStanox);

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0103/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        const locations = body.effective.locations as Array<{
          tiploc: string;
          locationName: string | null;
        }>;
        expect(locations).toHaveLength(1);
        expect(locations[0]).toMatchObject({ tiploc: newTiploc, locationName: "Revised Call" });
      } finally {
        await app.close();
      }
    });
  });

  describe("a Change of Identity can change the run's own headcode, not just its TRUST id (docs/adr/0010)", () => {
    it("finds the correct schedule via the identity chain when the plain headcode search would miss it — the real 6C02→0C02 incident", async () => {
      const area = uniqueArea();
      // The schedule is (and stays) booked under its *original* headcode — garner never
      // retroactively updates cif_schedules.signalling_id.
      const correctId = await seedSchedule("6C02", "P");
      // "426C02C417": 2-digit start hour "42" + headcode "6C02" + 2-char TOC "C4" + day-of-month
      // "17" - the exact real trust_id from the reported incident.
      await seedActivationWithTrustId(correctId, "426C02C417");
      // The Change of Identity: new headcode 0C02, same start-hour/TOC/day-of-month digits as the
      // real example.
      await seedChangeId("426C02C417", "420C02C417");

      // The TD berth itself now shows the *new* headcode 0C02, exactly as the signaller would
      // interpose it post-rename - a plain queryCandidateSchedules(headcode="0C02") search would
      // never find `correctId` (booked as 6C02) at all.
      await seedOccupiedBerth(area, "0200", "0C02");

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0200/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("matched");
        expect(body.matchBasis).toBe("trust_activation");
        expect(body.effective.scheduleId).toBe(String(correctId));
      } finally {
        await app.close();
      }
    });

    it("stays ambiguous rather than silently matching a different, unrelated train that genuinely carries the new headcode — the reported false-match scenario", async () => {
      const area = uniqueArea();
      const correctId = await seedSchedule("6C02", "P");
      await seedActivationWithTrustId(correctId, "436C02C517");
      await seedChangeId("436C02C517", "430C02C517");

      // A completely different, real train that genuinely carries headcode 0C02 elsewhere on the
      // network today, coincidentally also activated - the exact ambiguity this fix must still
      // honestly surface (CLAUDE.md rule 7), not resolve by guessing.
      const coincidentalId = await seedSchedule("0C02", "P");
      await seedActivation(coincidentalId, "0C02");

      await seedOccupiedBerth(area, "0201", "0C02");

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0201/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.matchStatus).toBe("ambiguous");
      } finally {
        await app.close();
      }
    });

    it("surfaces the decoded headcode change on the resolved run once matched", async () => {
      const area = uniqueArea();
      const correctId = await seedSchedule("6C02", "P");
      await seedActivationWithTrustId(correctId, "446C02C617");
      await seedChangeId("446C02C617", "440C02C617");
      await seedOccupiedBerth(area, "0202", "0C02");

      const app = await buildApp();
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/v1/td/areas/${area}/berths/0202/current-run`,
          headers: await authHeaders(),
        });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.effective.identityChange).toMatchObject({
          previousTrustId: "446C02C617",
          newTrustId: "440C02C617",
          previousHeadcode: "6C02",
          newHeadcode: "0C02",
        });
      } finally {
        await app.close();
      }
    });
  });
});
