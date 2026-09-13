import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { runProjectRunLineage } from "./projector.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const AREA_A = `L${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const AREA_B = `M${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const rawEventIds: string[] = [];
const scheduleIds: string[] = [];

const T = (min: number): Date => new Date(Date.parse("2026-06-01T10:00:00.000Z") + min * 60_000);

/** Insert a raw_feed_event + matching td_berth_event, same pattern as
 * repairOpenOccupancies.integration.test.ts. */
async function tdEvent(
  area: string,
  eventAt: Date,
  messageType: "CA" | "CB" | "CC",
  fromBerth: string | null,
  toBerth: string | null,
): Promise<{ id: string; normalizedAt: Date }> {
  const archive = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const frame = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', now(), $1, $2) returning id`,
    [randomUUID(), archive.rows[0]!.id],
  );
  const ev = await pool.query<{
    id: string;
    normalized_event_at_utc: Date;
    ingestion_sequence: string;
  }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', $2, 'C', $3, '{}', $4, $4, $5, 'parsed', 1)
     returning id, normalized_event_at_utc, ingestion_sequence`,
    [frame.rows[0]!.id, messageType, area, eventAt, randomUUID()],
  );
  const row = ev.rows[0]!;
  rawEventIds.push(row.id);
  await pool.query(
    `insert into td_berth_event (raw_event_id, raw_event_normalized_at_utc, td_area, message_type,
        from_berth, to_berth, description, event_at, ingestion_sequence, normalization_version)
     values ($1, $2, $3, $4, $5, $6, 'RUN1', $2, $7, 1)`,
    [
      row.id,
      row.normalized_event_at_utc,
      area,
      messageType,
      fromBerth,
      toBerth,
      row.ingestion_sequence,
    ],
  );
  return { id: row.id, normalizedAt: row.normalized_event_at_utc };
}

async function insertOccupancy(params: {
  area: string;
  berth: string;
  enteredAt: Date;
  leftAt: Date | null;
  entryReason: string;
  exitReason: string | null;
  entryEvent: { id: string; normalizedAt: Date };
  exitEvent?: { id: string; normalizedAt: Date };
}): Promise<{ id: string; enteredAt: Date }> {
  const result = await pool.query<{ id: string }>(
    `insert into berth_occupancy (
       projection_version, td_area, berth_code, description, entered_at, left_at,
       entry_event_id, entry_event_normalized_at_utc, entry_reason,
       exit_event_id, exit_event_normalized_at_utc, exit_reason
     ) values ($1, $2, $3, 'RUN1', $4, $5, $6, $7, $8, $9, $10, $11)
     returning id`,
    [
      TD_PROJECTION_VERSION,
      params.area,
      params.berth,
      params.enteredAt,
      params.leftAt,
      params.entryEvent.id,
      params.entryEvent.normalizedAt,
      params.entryReason,
      params.exitEvent?.id ?? null,
      params.exitEvent?.normalizedAt ?? null,
      params.exitReason,
    ],
  );
  return { id: result.rows[0]!.id, enteredAt: params.enteredAt };
}

let nextScheduleId = Date.now();

async function insertMinimalSchedule(cifTrainUid: string): Promise<string> {
  const id = nextScheduleId++;
  await pool.query(
    `insert into cif_schedules (
       id, created, cif_stp_indicator, cif_train_uid, runs_mo, runs_tu, runs_we, runs_th,
       runs_fr, runs_sa, runs_su, schedule_start_date, schedule_end_date
     ) values ($1, now(), 'P', $2, true, true, true, true, true, true, true, '2026-01-01', '2026-12-31')`,
    [id, cifTrainUid],
  );
  scheduleIds.push(String(id));
  return String(id);
}

async function insertTrainRun(params: {
  cifScheduleId: string | null;
  cifTrainUid: string;
  matchBasis: string;
  matchConfidence: "solid" | "weak";
  establishedTdArea: string;
  establishedBerth: string;
}): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into train_run (
       cif_schedule_id, cif_train_uid, traffic_day, match_basis, match_confidence,
       established_td_area, established_berth
     ) values ($1, $2, '2026-06-01', $3, $4, $5, $6)
     returning id`,
    [
      params.cifScheduleId,
      params.cifTrainUid,
      params.matchBasis,
      params.matchConfidence,
      params.establishedTdArea,
      params.establishedBerth,
    ],
  );
  return result.rows[0]!.id;
}

async function insertRunLink(
  occupancy: { id: string; enteredAt: Date },
  trainRunId: string,
  linkBasis: string,
): Promise<void> {
  await pool.query(
    `insert into berth_occupancy_run_link (berth_occupancy_id, occupancy_entered_at, train_run_id, link_basis)
     values ($1, $2, $3, $4)`,
    [occupancy.id, occupancy.enteredAt, trainRunId, linkBasis],
  );
}

async function linkFor(occupancy: { id: string; enteredAt: Date }) {
  const r = await pool.query<{ train_run_id: string; link_basis: string }>(
    `select train_run_id, link_basis from berth_occupancy_run_link
     where berth_occupancy_id = $1 and occupancy_entered_at = $2`,
    [occupancy.id, occupancy.enteredAt],
  );
  return r.rows[0] ?? null;
}

afterAll(async () => {
  await pool.query(
    "delete from berth_occupancy_run_link where train_run_id in (select id from train_run where established_td_area = any($1::text[]))",
    [[AREA_A, AREA_B]],
  );
  await pool.query("delete from train_run where established_td_area = any($1::text[])", [
    [AREA_A, AREA_B],
  ]);
  await pool.query(
    "delete from td_area_boundary where area_a = any($1::text[]) or area_b = any($1::text[])",
    [[AREA_A, AREA_B]],
  );
  await pool.query("delete from berth_occupancy where td_area = any($1::text[])", [
    [AREA_A, AREA_B],
  ]);
  await pool.query("delete from td_berth_event where td_area = any($1::text[])", [
    [AREA_A, AREA_B],
  ]);
  if (rawEventIds.length > 0) {
    await pool.query("delete from raw_feed_event where id = any($1::bigint[])", [rawEventIds]);
  }
  if (scheduleIds.length > 0) {
    await pool.query("delete from cif_schedules where id = any($1::bigint[])", [scheduleIds]);
  }
  await pool.end();
});

describe("run-lineage projector (integration)", () => {
  it("inherits a step-chain link across a clean CA step, capped at the source's confidence", async () => {
    const berthA = "0001";
    const berthB = "0002";
    const openA = await tdEvent(AREA_A, T(0), "CC", null, berthA);
    const occA = await insertOccupancy({
      area: AREA_A,
      berth: berthA,
      enteredAt: T(0),
      leftAt: null,
      entryReason: "cc_interpose",
      exitReason: null,
      entryEvent: openA,
    });
    const runId = await insertTrainRun({
      cifScheduleId: null,
      cifTrainUid: "TEST01",
      matchBasis: "headcode_only",
      matchConfidence: "weak",
      establishedTdArea: AREA_A,
      establishedBerth: berthA,
    });
    await insertRunLink(occA, runId, "resolved");

    const step = await tdEvent(AREA_A, T(5), "CA", berthA, berthB);
    await pool.query(
      `update berth_occupancy set left_at = $1, exit_reason = 'stepped_out', exit_event_id = $2, exit_event_normalized_at_utc = $3
       where id = $4`,
      [step.normalizedAt, step.id, step.normalizedAt, occA.id],
    );
    const occB = await insertOccupancy({
      area: AREA_A,
      berth: berthB,
      enteredAt: step.normalizedAt,
      leftAt: null,
      entryReason: "ca_step",
      exitReason: null,
      entryEvent: step,
    });

    await runProjectRunLineage(pool, { batchSize: 50 });

    const link = await linkFor(occB);
    expect(link).toEqual({ train_run_id: runId, link_basis: "step_chain" });

    const run = await pool.query<{ match_confidence: string }>(
      `select match_confidence from train_run where id = $1`,
      [runId],
    );
    expect(run.rows[0]!.match_confidence).toBe("weak"); // never upgraded
  });

  it("does not propagate when the source occupancy was never linked", async () => {
    const berthA = "0011";
    const berthB = "0012";
    const openA = await tdEvent(AREA_A, T(10), "CC", null, berthA);
    const occA = await insertOccupancy({
      area: AREA_A,
      berth: berthA,
      enteredAt: T(10),
      leftAt: null,
      entryReason: "cc_interpose",
      exitReason: null,
      entryEvent: openA,
    });
    const step = await tdEvent(AREA_A, T(15), "CA", berthA, berthB);
    await pool.query(
      `update berth_occupancy set left_at = $1, exit_reason = 'stepped_out', exit_event_id = $2, exit_event_normalized_at_utc = $3
       where id = $4`,
      [step.normalizedAt, step.id, step.normalizedAt, occA.id],
    );
    const occB = await insertOccupancy({
      area: AREA_A,
      berth: berthB,
      enteredAt: step.normalizedAt,
      leftAt: null,
      entryReason: "ca_step",
      exitReason: null,
      entryEvent: step,
    });

    await runProjectRunLineage(pool, { batchSize: 50 });

    expect(await linkFor(occB)).toBeNull();
  });

  it("boundary-correlates across a curated crossing when TRUST movement continuity corroborates", async () => {
    const berthA = "0021";
    const berthB = "0031";
    const openA = await tdEvent(AREA_A, T(20), "CC", null, berthA);
    const occA = await insertOccupancy({
      area: AREA_A,
      berth: berthA,
      enteredAt: T(20),
      leftAt: null,
      entryReason: "cc_interpose",
      exitReason: null,
      entryEvent: openA,
    });
    const scheduleId = await insertMinimalSchedule("BOUND1");
    const trustId = `TST${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    await pool.query(
      `insert into trust_activation (trust_id, created, cif_schedule_id) values ($1, now(), $2)`,
      [trustId, scheduleId],
    );
    await pool.query(
      `insert into trust_movement (trust_id, created, actual_timestamp) values ($1, now(), $2)`,
      [trustId, T(26)],
    );
    const runId = await insertTrainRun({
      cifScheduleId: scheduleId,
      cifTrainUid: "BOUND1",
      matchBasis: "trust_activation",
      matchConfidence: "solid",
      establishedTdArea: AREA_A,
      establishedBerth: berthA,
    });
    await insertRunLink(occA, runId, "resolved");

    await pool.query(
      `insert into td_area_boundary (area_a, berth_a, area_b, berth_b, created_by)
       values ($1, $2, $3, $4, 'test')`,
      [AREA_A, berthA, AREA_B, berthB],
    );

    const cancel = await tdEvent(AREA_A, T(25), "CB", berthA, null);
    await pool.query(
      `update berth_occupancy set left_at = $1, exit_reason = 'cancelled', exit_event_id = $2, exit_event_normalized_at_utc = $3
       where id = $4`,
      [cancel.normalizedAt, cancel.id, cancel.normalizedAt, occA.id],
    );

    const interpose = await tdEvent(AREA_B, T(26), "CC", null, berthB);
    const occB = await insertOccupancy({
      area: AREA_B,
      berth: berthB,
      enteredAt: T(26),
      leftAt: null,
      entryReason: "cc_interpose",
      exitReason: null,
      entryEvent: interpose,
    });

    await runProjectRunLineage(pool, { batchSize: 50 });

    const link = await linkFor(occB);
    expect(link).toEqual({ train_run_id: runId, link_basis: "boundary_correlated" });
  });

  it("stays ambiguous (no link) when more than one unclaimed candidate is plausible on the far side", async () => {
    const berthA = "0041";
    const berthB = "0051";
    const openA = await tdEvent(AREA_A, T(40), "CC", null, berthA);
    const occA = await insertOccupancy({
      area: AREA_A,
      berth: berthA,
      enteredAt: T(40),
      leftAt: null,
      entryReason: "cc_interpose",
      exitReason: null,
      entryEvent: openA,
    });
    const scheduleId = await insertMinimalSchedule("BOUND2");
    const runId = await insertTrainRun({
      cifScheduleId: scheduleId,
      cifTrainUid: "BOUND2",
      matchBasis: "trust_activation",
      matchConfidence: "solid",
      establishedTdArea: AREA_A,
      establishedBerth: berthA,
    });
    await insertRunLink(occA, runId, "resolved");
    await pool.query(
      `insert into td_area_boundary (area_a, berth_a, area_b, berth_b, created_by)
       values ($1, $2, $3, $4, 'test')`,
      [AREA_A, berthA, AREA_B, berthB],
    );

    const cancel = await tdEvent(AREA_A, T(45), "CB", berthA, null);
    await pool.query(
      `update berth_occupancy set left_at = $1, exit_reason = 'cancelled', exit_event_id = $2, exit_event_normalized_at_utc = $3
       where id = $4`,
      [cancel.normalizedAt, cancel.id, cancel.normalizedAt, occA.id],
    );

    // Two candidates appear on the paired berth within the window — genuinely ambiguous.
    const interpose1 = await tdEvent(AREA_B, T(46), "CC", null, berthB);
    const occB1 = await insertOccupancy({
      area: AREA_B,
      berth: berthB,
      enteredAt: T(46),
      leftAt: T(47),
      entryReason: "cc_interpose",
      exitReason: "overwritten_by_interpose",
      entryEvent: interpose1,
    });
    const interpose2 = await tdEvent(AREA_B, T(47), "CC", null, berthB);
    await insertOccupancy({
      area: AREA_B,
      berth: berthB,
      enteredAt: T(47),
      leftAt: null,
      entryReason: "cc_interpose",
      exitReason: null,
      entryEvent: interpose2,
    });

    await runProjectRunLineage(pool, { batchSize: 50 });

    expect(await linkFor(occB1)).toBeNull();
  });
});
