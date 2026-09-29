import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { createPool } from "./pool.js";
import {
  findMapDelaysAt,
  findOpenBerthsForTrustIds,
  projectTrustDelayBands,
} from "./delayBands.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const createdOccupancyIds: string[] = [];
const createdScheduleIds: number[] = [];
const createdTrustIds: string[] = [];
const createdTrainRunIds: string[] = [];
const createdAreas: string[] = [];

afterAll(async () => {
  if (createdAreas.length > 0) {
    await pool.query("delete from berth_current_state where td_area = any($1::text[])", [
      createdAreas,
    ]);
  }
  if (createdOccupancyIds.length > 0) {
    await pool.query("delete from berth_occupancy where id = any($1::bigint[])", [
      createdOccupancyIds,
    ]);
  }
  if (createdTrainRunIds.length > 0) {
    await pool.query("delete from train_run where id = any($1::bigint[])", [createdTrainRunIds]);
  }
  if (createdScheduleIds.length > 0) {
    await pool.query("delete from cif_schedules where id = any($1::bigint[])", [
      createdScheduleIds,
    ]);
  }
  if (createdTrustIds.length > 0) {
    for (const table of [
      "trust_delay_band_change",
      "trust_changeid",
      "trust_movement",
      "trust_activation",
    ]) {
      await pool.query(`delete from ${table} where trust_id = any($1::text[])`, [createdTrustIds]);
    }
  }
  await pool.end();
});

const LATE = 2 << 3;
const ON_TIME = 1 << 3;
const OFF_ROUTE = 3 << 3;
const MINUTE = 60_000;

function uniqueArea(): string {
  const area = `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
  createdAreas.push(area);
  return area;
}

function newTrustId(): string {
  const id = `T${randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`;
  createdTrustIds.push(id);
  return id;
}

function londonTodayDateString(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

/** Runs the projection until it has caught up with everything mirrored so far. */
async function catchUp(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const result = await projectTrustDelayBands(pool, { batchSize: 10_000 });
    if (result.movementsRead === 0) return;
  }
  throw new Error("delay band projection did not catch up");
}

async function bandHistory(trustId: string): Promise<Array<{ band: string; minutesAgo: number }>> {
  const rows = await pool.query<{ band: string; effective_at: Date }>(
    `select band, effective_at from trust_delay_band_change where trust_id = $1
     order by effective_at, id`,
    [trustId],
  );
  return rows.rows.map((row) => ({
    band: row.band,
    minutesAgo: Math.round((Date.now() - row.effective_at.getTime()) / MINUTE),
  }));
}

async function seedMovement(trustId: string, at: Date, minutes: number, flags: number) {
  await pool.query(
    `insert into trust_movement (trust_id, created, loc_stanox, actual_timestamp, timetable_variation, flags)
     values ($1, $2, $3, $2, $4, $5)`,
    [trustId, at, String(10000 + Math.floor(Math.random() * 89999)), minutes, flags],
  );
}

async function seedOccupancy(
  tdArea: string,
  berth: string,
  description: string,
  enteredAt: Date,
  leftAt: Date | null,
): Promise<{ id: string; enteredAt: Date }> {
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
  const event = (
    await pool.query<{ id: string; normalized_event_at_utc: Date; ingestion_sequence: string }>(
      `insert into raw_feed_event (
         frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
         normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
       ) values ($1, 0, 'TD', 'CC', 'C', $2, '{}', $3, $3, $4, 'parsed', 1)
       returning id, normalized_event_at_utc, ingestion_sequence`,
      [frame.rows[0]!.id, tdArea, enteredAt, randomUUID()],
    )
  ).rows[0]!;
  const occupancy = await pool.query<{ id: string }>(
    `insert into berth_occupancy (
       projection_version, td_area, berth_code, description, entered_at, left_at,
       entry_event_id, entry_event_normalized_at_utc, entry_reason
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'cc_interpose') returning id`,
    [
      TD_PROJECTION_VERSION,
      tdArea,
      berth,
      description,
      enteredAt,
      leftAt,
      event.id,
      event.normalized_event_at_utc,
    ],
  );
  const id = occupancy.rows[0]!.id;
  createdOccupancyIds.push(id);
  // An open occupancy is what the berth shows now — the push lookup starts from here.
  if (leftAt === null) {
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
        id,
        enteredAt,
        event.id,
        event.normalized_event_at_utc,
        event.ingestion_sequence,
      ],
    );
  }
  return { id, enteredAt };
}

let nextScheduleId = Date.now();

/** A schedule, a run matched to it and linked to `occupancy`, and the run's TRUST activation. */
async function seedLinkedRun(
  occupancy: { id: string; enteredAt: Date },
  tdArea: string,
  berth: string,
  confidence: "solid" | "weak",
  activatedAt: Date,
): Promise<{ trustId: string; runKey: string }> {
  const scheduleId = nextScheduleId++;
  createdScheduleIds.push(scheduleId);
  await pool.query(
    `insert into cif_schedules (
       id, created, cif_stp_indicator, cif_train_uid,
       runs_mo, runs_tu, runs_we, runs_th, runs_fr, runs_sa, runs_su,
       schedule_start_date, schedule_end_date, signalling_id, atoc_code
     ) values ($1, now(), 'P', $2, true,true,true,true,true,true,true,
       (now() - interval '30 days')::date, (now() + interval '30 days')::date, '9Z99', 'NT')`,
    [scheduleId, `U${scheduleId}`],
  );
  const run = await pool.query<{ id: string }>(
    `insert into train_run (
       cif_schedule_id, cif_train_uid, traffic_day, match_basis, match_confidence,
       established_td_area, established_berth
     ) values ($1, $2, $3::date, 'headcode_only', $4, $5, $6) returning id::text as id`,
    [scheduleId, `U${scheduleId}`, londonTodayDateString(), confidence, tdArea, berth],
  );
  const runKey = run.rows[0]!.id;
  createdTrainRunIds.push(runKey);
  await pool.query(
    `insert into berth_occupancy_run_link (
       berth_occupancy_id, occupancy_entered_at, train_run_id, link_basis
     ) values ($1, $2, $3, 'resolved')`,
    [occupancy.id, occupancy.enteredAt, runKey],
  );
  const trustId = newTrustId();
  await pool.query(
    `insert into trust_activation (trust_id, created, cif_schedule_id, deduced) values ($1, $2, $3, 0)`,
    [trustId, activatedAt, scheduleId],
  );
  return { trustId, runKey };
}

describe("trust delay bands (Milestone 82, integration)", () => {
  it("records a change only when a report moves the train into a different band", async () => {
    const now = Date.now();
    const trustId = newTrustId();
    await seedMovement(trustId, new Date(now - 60 * MINUTE), 3, LATE); // on time
    await seedMovement(trustId, new Date(now - 50 * MINUTE), 5, LATE); // still on time
    await seedMovement(trustId, new Date(now - 40 * MINUTE), 18, LATE); // minor
    await seedMovement(trustId, new Date(now - 30 * MINUTE), 22, LATE); // still minor
    await seedMovement(trustId, new Date(now - 20 * MINUTE), 65, LATE); // severe
    await seedMovement(trustId, new Date(now - 15 * MINUTE), 0, ON_TIME); // back to on time
    await seedMovement(trustId, new Date(now - 10 * MINUTE), 40, OFF_ROUTE); // no information
    await catchUp();

    expect(await bandHistory(trustId)).toEqual([
      { band: "on_time", minutesAgo: 60 },
      { band: "minor", minutesAgo: 40 },
      { band: "severe", minutesAgo: 20 },
      { band: "on_time", minutesAgo: 15 },
      { band: "none", minutesAgo: 10 },
    ]);

    // Re-running over the same reports records nothing more.
    await catchUp();
    expect(await bandHistory(trustId)).toHaveLength(5);
  });

  it("records reports made under a new id after a Change of Identity against the original", async () => {
    const now = Date.now();
    const trustId = newTrustId();
    const renamed = newTrustId();
    await pool.query(
      `insert into trust_changeid (trust_id, created, new_trust_id) values ($1, $2, $3)`,
      [trustId, new Date(now - 30 * MINUTE), renamed],
    );
    await seedMovement(trustId, new Date(now - 40 * MINUTE), 35, LATE);
    await seedMovement(renamed, new Date(now - 15 * MINUTE), 75, LATE);
    await catchUp();

    expect(await bandHistory(trustId)).toEqual([
      { band: "moderate", minutesAgo: 40 },
      { band: "severe", minutesAgo: 15 },
    ]);
    expect(await bandHistory(renamed)).toEqual([]);
  });

  it("colours a linked berth — weak matches too — with the band in force at `at`", async () => {
    const area = uniqueArea();
    const now = Date.now();
    // Occupied from 60 to 20 minutes ago; 20 late at -50, then 65 late at -25.
    const occupancy = await seedOccupancy(
      area,
      "0003",
      "1A03",
      new Date(now - 60 * MINUTE),
      new Date(now - 20 * MINUTE),
    );
    const { trustId, runKey } = await seedLinkedRun(
      occupancy,
      area,
      "0003",
      "weak",
      new Date(now - 90 * MINUTE),
    );
    await seedMovement(trustId, new Date(now - 50 * MINUTE), 20, LATE);
    await seedMovement(trustId, new Date(now - 25 * MINUTE), 65, LATE);
    await catchUp();

    const berths = [{ tdArea: area, berth: "0003" }];
    const at = async (minutesAgo: number) =>
      findMapDelaysAt(pool, berths, new Date(now - minutesAgo * MINUTE));
    expect(await at(40)).toEqual([
      {
        tdArea: area,
        berth: "0003",
        description: "1A03",
        runKey,
        matchConfidence: "weak",
        band: "minor",
      },
    ]);
    expect((await at(22)).map((row) => row.band)).toEqual(["severe"]);
    expect(await at(10)).toEqual([]); // the train had left the berth
  });

  it("colours an on-time train green, and leaves unlinked or off-route berths alone", async () => {
    const area = uniqueArea();
    const now = Date.now();
    const occupancy = await seedOccupancy(area, "0005", "1A05", new Date(now - 5 * MINUTE), null);
    const { trustId, runKey } = await seedLinkedRun(
      occupancy,
      area,
      "0005",
      "solid",
      new Date(now - 60 * MINUTE),
    );
    await seedOccupancy(area, "0006", "1A06", new Date(now - 5 * MINUTE), null); // no link
    await seedMovement(trustId, new Date(now - 3 * MINUTE), 14, LATE); // under 15: on time
    await catchUp();

    const berths = [
      { tdArea: area, berth: "0005" },
      { tdArea: area, berth: "0006" },
    ];
    const onTime = {
      tdArea: area,
      berth: "0005",
      description: "1A05",
      runKey,
      matchConfidence: "solid",
      band: "on_time",
    };
    expect(await findMapDelaysAt(pool, berths, new Date())).toEqual([onTime]);
    expect(await findOpenBerthsForTrustIds(pool, [trustId], berths)).toEqual([
      { trustId, ...onTime },
    ]);

    // An off-route report is no information: dropped from the map, but still pushed as `none`
    // so the colour is taken away.
    await seedMovement(trustId, new Date(now - 1 * MINUTE), 30, OFF_ROUTE);
    await catchUp();
    expect(await findMapDelaysAt(pool, berths, new Date())).toEqual([]);
    expect(await findOpenBerthsForTrustIds(pool, [trustId], berths)).toEqual([
      { trustId, ...onTime, band: "none" },
    ]);
  });
});
