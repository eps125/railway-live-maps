import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { repairRunLinks } from "./repairRunLinks.js";

/**
 * Overnight fix (2026-10-01, owner report: Caledonian Sleeper 1S25/1S26/1M11/1M16 never coloured
 * by delay). A sleeper running on consecutive nights was stored against the traffic day *after*
 * the one it was activated for, so no delay lookup found its activation. `--correct` replaces such
 * a link once TRUST confirms the right run, and moves the rest of the journey with it.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const AREA = `R${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const BERTH = "0304";
const NEXT_BERTH = "0306";
const HEADCODE = "1M11";
const STANOX = String(70000 + Math.floor(Math.random() * 9999));
const ORIGIN_TIPLOC = `O${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const BERTH_TIPLOC = `B${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const rawEventIds: string[] = [];
const scheduleIds: string[] = [];
const mapIds: string[] = [];
const smartBerthStepIds: string[] = [];

// March: London is on GMT, so these UTC instants are London wall-clock times too.
const ACTIVATED_AT = new Date("2026-03-11T23:20:00Z"); // Wednesday night, before the 23:40 departure
const ENTERED_AT = new Date("2026-03-12T00:35:00Z"); // 55 minutes after departure, Thursday's date
const NEXT_ENTERED_AT = new Date("2026-03-12T00:38:00Z");

async function tdEvent(eventAt: Date): Promise<{ id: string; normalizedAt: Date }> {
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
  const ev = await pool.query<{ id: string; normalized_event_at_utc: Date }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', 'CC', 'C', $2, '{}', $3, $3, $4, 'parsed', 1)
     returning id, normalized_event_at_utc`,
    [frame.rows[0]!.id, AREA, eventAt, randomUUID()],
  );
  const row = ev.rows[0]!;
  rawEventIds.push(row.id);
  return { id: row.id, normalizedAt: row.normalized_event_at_utc };
}

async function insertOccupancy(
  berth: string,
  enteredAt: Date,
  leftAt: Date,
): Promise<{ id: string; enteredAt: Date }> {
  const entry = await tdEvent(enteredAt);
  const result = await pool.query<{ id: string }>(
    `insert into berth_occupancy (
       projection_version, td_area, berth_code, description, entered_at, left_at,
       entry_event_id, entry_event_normalized_at_utc, entry_reason
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'cc_interpose')
     returning id`,
    [TD_PROJECTION_VERSION, AREA, berth, HEADCODE, enteredAt, leftAt, entry.id, entry.normalizedAt],
  );
  return { id: result.rows[0]!.id, enteredAt };
}

async function seedDailySleeperSchedule(): Promise<string> {
  const id = Date.now() + Math.floor(Math.random() * 1000);
  await pool.query(
    `insert into cif_schedules (
       id, created, cif_stp_indicator, cif_train_uid, signalling_id, runs_mo, runs_tu, runs_we,
       runs_th, runs_fr, runs_sa, runs_su, schedule_start_date, schedule_end_date
     ) values ($1, now(), 'P', $2, $3, true, true, true, true, true, true, true, '2026-01-01', '2026-12-31')`,
    [id, `S${String(id).slice(-5)}`, HEADCODE],
  );
  scheduleIds.push(String(id));
  await pool.query(
    `insert into cif_schedule_locations (cif_schedule_id, seq_no, record_identity, tiploc_code, public_departure)
     values ($1, 1, 'LO', $2, '2340'), ($1, 2, 'LI', $3, null)`,
    [id, ORIGIN_TIPLOC, BERTH_TIPLOC],
  );
  return String(id);
}

async function publishMinimalMap(): Promise<void> {
  const mapResult = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, 'Repair run links test map') returning id`,
    [`test-map-${randomUUID()}`],
  );
  const mapId = mapResult.rows[0]!.id;
  mapIds.push(mapId);
  const version = await pool.query<{ id: string }>(
    `insert into map_version (
       map_id, version_number, canonical_document, compiled_runtime_bundle, effective_from,
       schema_version, checksum
     ) values ($1, 1, '{}', '{}', now(), 1, 'test') returning id`,
    [mapId],
  );
  await pool.query(
    `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, berth)
     values ($1, 'test-element', 'td_berth', $2, $3)`,
    [version.rows[0]!.id, AREA, BERTH],
  );
}

async function linkFor(occupancy: { id: string; enteredAt: Date }) {
  const r = await pool.query<{
    train_run_id: string;
    link_basis: string;
    cif_schedule_id: string;
    traffic_day: string;
    match_basis: string;
  }>(
    `select l.train_run_id::text, l.link_basis, r.cif_schedule_id::text,
            to_char(r.traffic_day, 'YYYY-MM-DD') as traffic_day, r.match_basis
       from berth_occupancy_run_link l join train_run r on r.id = l.train_run_id
      where l.berth_occupancy_id = $1 and l.occupancy_entered_at = $2`,
    [occupancy.id, occupancy.enteredAt],
  );
  return r.rows[0] ?? null;
}

afterAll(async () => {
  await pool.query(
    "delete from berth_occupancy_run_link where train_run_id in (select id from train_run where established_td_area = $1)",
    [AREA],
  );
  await pool.query("delete from train_run where established_td_area = $1", [AREA]);
  await pool.query("delete from berth_occupancy where td_area = $1", [AREA]);
  await pool.query("delete from trust_activation where cif_schedule_id = any($1::bigint[])", [
    scheduleIds,
  ]);
  await pool.query("delete from smart_berth_step where id = any($1::bigint[])", [
    smartBerthStepIds,
  ]);
  await pool.query("delete from location_reference where tiploc = any($1::text[])", [
    [ORIGIN_TIPLOC, BERTH_TIPLOC],
  ]);
  await pool.query(
    "delete from map_binding_index where map_version_id in (select id from map_version where map_id = any($1::bigint[]))",
    [mapIds],
  );
  await pool.query("delete from map_version where map_id = any($1::bigint[])", [mapIds]);
  await pool.query("delete from map where id = any($1::bigint[])", [mapIds]);
  await pool.query("delete from raw_feed_event where id = any($1::bigint[])", [rawEventIds]);
  await pool.query("delete from cif_schedule_locations where cif_schedule_id = any($1::bigint[])", [
    scheduleIds,
  ]);
  await pool.query("delete from cif_schedules where id = any($1::bigint[])", [scheduleIds]);
  await pool.end();
});

describe("repair-run-links --correct (integration)", () => {
  it("moves a sleeper stored against the next day onto the run TRUST activated — 1M11 at Carlisle", async () => {
    await publishMinimalMap();
    const smart = await pool.query<{ id: string }>(
      `insert into smart_berth_step (td_area, from_berth, to_berth, stanox, event_type, raw_source_json)
       values ($1, $2, $3, $4, 'A', '{}') returning id`,
      [AREA, BERTH, NEXT_BERTH, STANOX],
    );
    smartBerthStepIds.push(smart.rows[0]!.id);
    await pool.query(
      `insert into location_reference (tiploc, name, stanox, raw_source_json)
       values ($1, 'Test origin', '99999', '{}'), ($2, 'Test berth station', $3, '{}')`,
      [ORIGIN_TIPLOC, BERTH_TIPLOC, STANOX],
    );
    const scheduleId = await seedDailySleeperSchedule();
    await pool.query(
      `insert into trust_activation (trust_id, created, cif_schedule_id, deduced) values ($1, $2, $3, 0)`,
      [`87${HEADCODE}${randomUUID().slice(0, 2).toUpperCase()}11`, ACTIVATED_AT, scheduleId],
    );

    const occupancy = await insertOccupancy(BERTH, ENTERED_AT, NEXT_ENTERED_AT);
    const next = await insertOccupancy(
      NEXT_BERTH,
      NEXT_ENTERED_AT,
      new Date("2026-03-12T00:41:00Z"),
    );
    // How it was stored before the fix: Thursday's run, which hadn't left Glasgow yet.
    const wrongRun = await pool.query<{ id: string }>(
      `insert into train_run (
         cif_schedule_id, cif_train_uid, traffic_day, match_basis, match_confidence,
         established_td_area, established_berth
       ) values ($1, $2, '2026-03-12', 'stp_precedence', 'solid', $3, $4) returning id`,
      [scheduleId, `S${scheduleId.slice(-5)}`, AREA, BERTH],
    );
    await pool.query(
      `insert into berth_occupancy_run_link (berth_occupancy_id, occupancy_entered_at, train_run_id, link_basis)
       values ($1, $2, $3, 'resolved'), ($4, $5, $3, 'step_chain')`,
      [occupancy.id, occupancy.enteredAt, wrongRun.rows[0]!.id, next.id, next.enteredAt],
    );

    const window = {
      from: new Date("2026-03-12T00:00:00Z"),
      to: new Date("2026-03-12T00:45:00Z"),
    };
    const dry = await repairRunLinks(pool, { ...window, dryRun: true, correct: true });
    expect(dry.wrongRun).toBe(1);
    expect(dry.corrected).toBe(1);
    expect((await linkFor(occupancy))!.traffic_day).toBe("2026-03-12");

    const summary = await repairRunLinks(pool, { ...window, dryRun: false, correct: true });
    expect(summary.corrected).toBe(1);
    expect(summary.repointed).toBe(1);

    const fixed = await linkFor(occupancy);
    expect(fixed).toMatchObject({
      cif_schedule_id: scheduleId,
      traffic_day: "2026-03-11",
      match_basis: "trust_activation",
    });
    const carried = await linkFor(next);
    expect(carried!.train_run_id).toBe(fixed!.train_run_id);
    expect(carried!.link_basis).toBe("step_chain");

    // Idempotent: once corrected, a second pass finds nothing wrong.
    const again = await repairRunLinks(pool, { ...window, dryRun: true, correct: true });
    expect(again.wrongRun).toBe(0);
  });
});
