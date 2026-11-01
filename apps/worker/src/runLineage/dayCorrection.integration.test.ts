import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool, londonToday, previousCalendarDate } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { createDayCorrectionCooldown, sweepDayMismatchedLinks } from "./dayCorrection.js";

/**
 * ADR 0008 amendment (2026-10-31): an open occupancy linked to yesterday's run, whose schedule
 * has now been activated for today, is moved to today's run — and only that one. Real "now"
 * (the sweep resolves against the London date), like freshResolution.integration.test.ts.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const AREA = `D${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const created = {
  rawEvents: [] as string[],
  schedules: [] as number[],
  maps: [] as string[],
  tiplocs: [] as string[],
  smartSteps: [] as string[],
  trustIds: [] as string[],
};
const T = (minutesAgo: number): Date => new Date(Date.now() - minutesAgo * 60_000);
let nextScheduleId = Date.now();

async function rawEvent(at: Date) {
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
     ) values ($1, 0, 'TD', 'CC', 'C', $2, '{}', $3, $3, $4, 'parsed', 1)
     returning id, normalized_event_at_utc, ingestion_sequence`,
    [frame.rows[0]!.id, AREA, at, randomUUID()],
  );
  created.rawEvents.push(ev.rows[0]!.id);
  return ev.rows[0]!;
}

/** A train standing in `berth` (open occupancy + berth current state) at a SMART-covered
 * location on its daily schedule, linked to a run on `runDay`, with an activation today. */
async function standingTrain(params: { berth: string; headcode: string; runDay: string }) {
  const tiploc = `DC${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
  const stanox = randomUUID().replace(/-/g, "").slice(0, 5);
  await pool.query(
    `insert into location_reference (tiploc, name, stanox, raw_source_json) values ($1, 'Day correction test', $2, '{}')`,
    [tiploc, stanox],
  );
  created.tiplocs.push(tiploc);
  const step = await pool.query<{ id: string }>(
    `insert into smart_berth_step (td_area, from_berth, to_berth, stanox, event_type, raw_source_json)
     values ($1, $2, $3, $4, 'A', '{}') returning id`,
    [AREA, params.berth, `${params.berth}X`, stanox],
  );
  created.smartSteps.push(step.rows[0]!.id);

  const scheduleId = nextScheduleId++;
  const uid = `DC${String(scheduleId).slice(-4)}`;
  await pool.query(
    `insert into cif_schedules (
       id, created, cif_stp_indicator, cif_train_uid, signalling_id, runs_mo, runs_tu, runs_we,
       runs_th, runs_fr, runs_sa, runs_su, schedule_start_date, schedule_end_date
     ) values ($1, now(), 'P', $2, $3, true, true, true, true, true, true, true, '2026-01-01', '2027-12-31')`,
    [scheduleId, uid, params.headcode],
  );
  created.schedules.push(scheduleId);
  await pool.query(
    `insert into cif_schedule_locations (cif_schedule_id, seq_no, record_identity, tiploc_code)
     values ($1, 1, 'LO', $2)`,
    [scheduleId, tiploc],
  );

  const enteredAt = T(10);
  const event = await rawEvent(enteredAt);
  const occupancyId = (
    await pool.query<{ id: string }>(
      `insert into berth_occupancy (
         projection_version, td_area, berth_code, description, entered_at, left_at,
         entry_event_id, entry_event_normalized_at_utc, entry_reason
       ) values ($1, $2, $3, $4, $5, null, $6, $7, 'cc_interpose') returning id`,
      [
        TD_PROJECTION_VERSION,
        AREA,
        params.berth,
        params.headcode,
        enteredAt,
        event.id,
        event.normalized_event_at_utc,
      ],
    )
  ).rows[0]!.id;
  await pool.query(
    `insert into berth_current_state (
       projection_version, td_area, berth_code, description, occupancy_id, occupancy_entered_at,
       event_at, source_event_id, source_event_normalized_at_utc, source_ingestion_sequence
     ) values ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9)`,
    [
      TD_PROJECTION_VERSION,
      AREA,
      params.berth,
      params.headcode,
      occupancyId,
      enteredAt,
      event.id,
      event.normalized_event_at_utc,
      event.ingestion_sequence,
    ],
  );

  const runId = (
    await pool.query<{ id: string }>(
      `insert into train_run (
         cif_schedule_id, cif_train_uid, traffic_day, match_basis, match_confidence,
         established_td_area, established_berth
       ) values ($1, $2, $3::date, 'trust_activation', 'solid', $4, $5) returning id`,
      [scheduleId, uid, params.runDay, AREA, params.berth],
    )
  ).rows[0]!.id;
  await pool.query(
    `insert into berth_occupancy_run_link (berth_occupancy_id, occupancy_entered_at, train_run_id, link_basis)
     values ($1, $2, $3, 'resolved')`,
    [occupancyId, enteredAt, runId],
  );

  // Today's activation: the TRUST ID ends in today's day of the month.
  const trustId = `99${params.headcode}M${londonToday(new Date()).slice(8, 10)}`;
  await pool.query(
    `insert into trust_activation (trust_id, created, cif_schedule_id) values ($1, $2, $3)`,
    [trustId, T(5), scheduleId],
  );
  created.trustIds.push(trustId);

  return { occupancy: { id: occupancyId, enteredAt }, runId, scheduleId };
}

async function linkedRun(occupancy: { id: string; enteredAt: Date }) {
  const { rows } = await pool.query<{ id: string; traffic_day: string; superseded_by: string }>(
    `select r.id::text as id, r.traffic_day::text as traffic_day, r.superseded_by::text as superseded_by
       from berth_occupancy_run_link l join train_run r on r.id = l.train_run_id
      where l.berth_occupancy_id = $1 and l.occupancy_entered_at = $2`,
    [occupancy.id, occupancy.enteredAt],
  );
  return rows[0] ?? null;
}

async function publishMap(berth: string) {
  const map = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, 'Day correction test map') returning id`,
    [`test-map-${randomUUID()}`],
  );
  created.maps.push(map.rows[0]!.id);
  const version = await pool.query<{ id: string }>(
    `insert into map_version (
       map_id, version_number, canonical_document, compiled_runtime_bundle, effective_from,
       schema_version, checksum
     ) values ($1, 1, '{}', '{}', now(), 1, 'test') returning id`,
    [map.rows[0]!.id],
  );
  await pool.query(
    `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, berth)
     values ($1, 'test-element', 'td_berth', $2, $3)`,
    [version.rows[0]!.id, AREA, berth],
  );
}

afterAll(async () => {
  await pool.query("delete from run_link_day_correction where td_area = $1", [AREA]);
  await pool.query("delete from berth_current_state where td_area = $1", [AREA]);
  await pool.query(
    "delete from berth_occupancy_run_link where train_run_id in (select id from train_run where established_td_area = $1)",
    [AREA],
  );
  await pool.query(
    "delete from berth_occupancy_run_link where berth_occupancy_id in (select id from berth_occupancy where td_area = $1)",
    [AREA],
  );
  await pool.query("delete from train_run where cif_schedule_id = any($1::bigint[])", [
    created.schedules,
  ]);
  await pool.query("delete from berth_occupancy where td_area = $1", [AREA]);
  await pool.query("delete from trust_activation where trust_id = any($1::text[])", [
    created.trustIds,
  ]);
  await pool.query("delete from smart_berth_step where id = any($1::bigint[])", [
    created.smartSteps,
  ]);
  await pool.query("delete from location_reference where tiploc = any($1::text[])", [
    created.tiplocs,
  ]);
  await pool.query(
    "delete from map_binding_index where map_version_id in (select id from map_version where map_id = any($1::bigint[]))",
    [created.maps],
  );
  await pool.query("delete from map_version where map_id = any($1::bigint[])", [created.maps]);
  await pool.query("delete from map where id = any($1::bigint[])", [created.maps]);
  await pool.query("delete from cif_schedule_locations where cif_schedule_id = any($1::bigint[])", [
    created.schedules,
  ]);
  await pool.query("delete from cif_schedules where id = any($1::bigint[])", [created.schedules]);
  await pool.query("delete from raw_feed_event where id = any($1::bigint[])", [created.rawEvents]);
  await pool.end();
});

describe("sweepDayMismatchedLinks (integration)", () => {
  it("moves a link from yesterday's run to today's once today's activation exists, and records it", async () => {
    await publishMap("9990");
    const today = londonToday(new Date());
    const yesterday = previousCalendarDate(today);
    const train = await standingTrain({ berth: "0105", headcode: "5D01", runDay: yesterday });
    // Linked correctly already: today's run, today's activation.
    const control = await standingTrain({ berth: "0107", headcode: "5D02", runDay: today });

    await sweepDayMismatchedLinks(pool, "mapped", createDayCorrectionCooldown());

    const moved = await linkedRun(train.occupancy);
    expect(moved?.traffic_day).toBe(today);
    expect(moved?.id).not.toBe(train.runId);
    // The old run is a real train on its own day: never superseded.
    const old = await pool.query<{ superseded_by: string | null }>(
      "select superseded_by::text as superseded_by from train_run where id = $1",
      [train.runId],
    );
    expect(old.rows[0]?.superseded_by).toBeNull();

    const audit = await pool.query<{
      old_train_run_id: string;
      new_train_run_id: string;
      old_traffic_day: string;
      new_traffic_day: string;
      new_run_created: boolean;
    }>(
      `select old_train_run_id::text, new_train_run_id::text, old_traffic_day::text,
              new_traffic_day::text, new_run_created
         from run_link_day_correction where td_area = $1 and berth_occupancy_id = $2`,
      [AREA, train.occupancy.id],
    );
    expect(audit.rows).toEqual([
      {
        old_train_run_id: train.runId,
        new_train_run_id: moved!.id,
        old_traffic_day: yesterday,
        new_traffic_day: today,
        new_run_created: true,
      },
    ]);

    expect((await linkedRun(control.occupancy))?.id).toBe(control.runId);
    const controlAudit = await pool.query(
      "select 1 from run_link_day_correction where berth_occupancy_id = $1",
      [control.occupancy.id],
    );
    expect(controlAudit.rowCount).toBe(0);
  });

  it("does nothing more once corrected: the link is no longer mismatched", async () => {
    const cooldown = createDayCorrectionCooldown();
    await sweepDayMismatchedLinks(pool, "mapped", cooldown);
    const audit = await pool.query("select 1 from run_link_day_correction where td_area = $1", [
      AREA,
    ]);
    expect(audit.rowCount).toBe(1);
  });
});
