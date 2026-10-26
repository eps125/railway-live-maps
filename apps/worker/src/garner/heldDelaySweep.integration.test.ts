import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool, findMapDelaysAt, findOpenBerthsForTrustIds } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { HeldDelaySweep, type ReplayState } from "./heldDelaySweep.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const MINUTE = 60_000;
const DEPARTURE_LATE = 1 | (2 << 3);
const created = {
  areas: [] as string[],
  occupancies: [] as string[],
  runs: [] as string[],
  schedules: [] as number[],
  trustIds: [] as string[],
  tiplocs: [] as string[],
};

afterAll(async () => {
  await pool.query("delete from estimated_delay_band_change where trust_id = any($1::text[])", [
    created.trustIds,
  ]);
  await pool.query("delete from trust_delay_band_change where trust_id = any($1::text[])", [
    created.trustIds,
  ]);
  await pool.query("delete from trust_movement where trust_id = any($1::text[])", [
    created.trustIds,
  ]);
  await pool.query("delete from trust_activation where trust_id = any($1::text[])", [
    created.trustIds,
  ]);
  await pool.query("delete from berth_current_state where td_area = any($1::text[])", [
    created.areas,
  ]);
  await pool.query("delete from berth_occupancy where id = any($1::bigint[])", [
    created.occupancies,
  ]);
  await pool.query("delete from train_run where id = any($1::bigint[])", [created.runs]);
  await pool.query("delete from cif_schedules where id = any($1::bigint[])", [created.schedules]);
  await pool.query("delete from location_reference where tiploc = any($1::text[])", [
    created.tiplocs,
  ]);
  await pool.end();
});

/** The database clock, not this machine's: in production the worker and Postgres share a host,
 * but a test runner can be a second or two apart, and `findOpenBerthsForTrustIds` reads `now()`. */
async function dbNow(): Promise<Date> {
  const { rows } = await pool.query<{ now: Date }>("select now() - interval '1 second' as now");
  return rows[0]!.now;
}

const londonDate = (at: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(at);

/** A train standing in a berth with no SMART location since `enteredAt`, linked to a run whose
 * last TRUST report — a departure `minutesLate` late from the origin — came before it entered. */
async function seedHeldTrain(
  enteredAt: Date,
  reportAt: Date,
  minutesLate: number,
  leftAt: Date | null = null,
) {
  const tdArea = `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
  created.areas.push(tdArea);
  const berth = "0101";
  const description = "1Z99";

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
  const occupancyId = (
    await pool.query<{ id: string }>(
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
    )
  ).rows[0]!.id;
  created.occupancies.push(occupancyId);
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
      enteredAt,
      event.id,
      event.normalized_event_at_utc,
      event.ingestion_sequence,
    ],
  );

  const scheduleId = Date.now() + Math.floor(Math.random() * 1000);
  created.schedules.push(scheduleId);
  await pool.query(
    `insert into cif_schedules (
       id, created, cif_stp_indicator, cif_train_uid,
       runs_mo, runs_tu, runs_we, runs_th, runs_fr, runs_sa, runs_su,
       schedule_start_date, schedule_end_date, signalling_id, atoc_code
     ) values ($1, now(), 'P', $2, true,true,true,true,true,true,true,
       (now() - interval '30 days')::date, (now() + interval '30 days')::date, $3, 'NT')`,
    [scheduleId, `U${scheduleId}`, description],
  );
  const origin = `HO${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
  const originStanox = String(10000 + Math.floor(Math.random() * 89999));
  created.tiplocs.push(origin);
  await pool.query(
    `insert into location_reference (tiploc, name, stanox, raw_source_json) values ($1, 'Held origin', $2, '{}')`,
    [origin, originStanox],
  );
  await pool.query(
    `insert into cif_schedule_locations (cif_schedule_id, seq_no, record_identity, tiploc_code, departure)
     values ($1, 1, 'LO', $2, '0001')`,
    [scheduleId, origin],
  );

  const activatedAt = new Date(reportAt.getTime() - 30 * MINUTE);
  const run = await pool.query<{ id: string }>(
    `insert into train_run (
       cif_schedule_id, cif_train_uid, traffic_day, match_basis, match_confidence,
       established_td_area, established_berth
     ) values ($1, $2, $3::date, 'trust_activation', 'solid', $4, $5) returning id::text as id`,
    [scheduleId, `U${scheduleId}`, londonDate(activatedAt), tdArea, berth],
  );
  const runKey = run.rows[0]!.id;
  created.runs.push(runKey);
  await pool.query(
    `insert into berth_occupancy_run_link (berth_occupancy_id, occupancy_entered_at, train_run_id, link_basis)
     values ($1, $2, $3, 'resolved')`,
    [occupancyId, enteredAt, runKey],
  );
  const trustId = `T${randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`;
  created.trustIds.push(trustId);
  await pool.query(
    `insert into trust_activation (trust_id, created, cif_schedule_id, deduced) values ($1, $2, $3, 0)`,
    [trustId, activatedAt, scheduleId],
  );
  await pool.query(
    `insert into trust_movement (trust_id, created, loc_stanox, actual_timestamp, timetable_variation, flags)
     values ($1, $2, $3, $2, $4, $5)`,
    [trustId, reportAt, originStanox, minutesLate, DEPARTURE_LATE],
  );
  return { tdArea, berth, trustId, runKey, originStanox };
}

describe("held-train delay sweep (Milestone 97b, integration)", () => {
  it("estimates a held train, shows it as estimated, and gives way to TRUST's next report", async () => {
    const now = await dbNow();
    const train = await seedHeldTrain(
      new Date(now.getTime() - 40 * MINUTE),
      new Date(now.getTime() - 45 * MINUTE),
      5,
    );
    const berths = [{ tdArea: train.tdArea, berth: train.berth }];
    const sweep = new HeldDelaySweep();

    // 5 late + 40 minutes held − 3 (default berth allowance) = 42 late: moderate.
    const first = await sweep.run(pool, berths, now);
    expect(first).toMatchObject({ candidates: 1, activeEstimates: 1, changesRecorded: 1 });
    expect(first.changedTrustIds).toEqual([train.trustId]);
    const recorded = await pool.query(
      `select band, minutes_late, basis from estimated_delay_band_change where trust_id = $1`,
      [train.trustId],
    );
    expect(recorded.rows).toEqual([{ band: "moderate", minutes_late: 42, basis: "held_in_berth" }]);

    const shown = await findMapDelaysAt(pool, berths, now);
    expect(shown).toEqual([
      expect.objectContaining({ runKey: train.runKey, band: "moderate", estimated: true }),
    ]);
    const pushed = await findOpenBerthsForTrustIds(pool, [train.trustId], berths);
    expect(pushed[0]).toMatchObject({ band: "moderate", estimated: true });

    // Same band next tick: nothing recorded.
    const again = await sweep.run(pool, berths, new Date(now.getTime() + 20_000));
    expect(again.changesRecorded).toBe(0);

    // TRUST reports the train moving on (12 late): the estimate ends and the TRUST band shows.
    const reportedAt = new Date(now.getTime() + 30_000);
    await pool.query(
      `insert into trust_movement (trust_id, created, loc_stanox, actual_timestamp, timetable_variation, flags)
       values ($1, $2, '99999', $2, 12, $3)`,
      [train.trustId, reportedAt, DEPARTURE_LATE],
    );
    await pool.query(
      `insert into trust_delay_band_change (trust_id, band, effective_at, source_movement_id)
       values ($1, 'on_time', $2, $3)`,
      [train.trustId, reportedAt, Date.now() * 10 + Math.floor(Math.random() * 10)],
    );
    const later = new Date(now.getTime() + 40_000);
    const cleared = await sweep.run(pool, berths, later);
    expect(cleared).toMatchObject({ activeEstimates: 0, changesRecorded: 1 });
    const clearRow = await pool.query(
      `select band, clear_reason from estimated_delay_band_change where trust_id = $1
        order by id desc limit 1`,
      [train.trustId],
    );
    expect(clearRow.rows[0]).toEqual({ band: "cleared", clear_reason: "reported_since_entry" });
    expect(await findMapDelaysAt(pool, berths, later)).toEqual([
      expect.objectContaining({ band: "on_time", estimated: false }),
    ]);

    // Playback still shows the estimate for the moment it was in force.
    expect(await findMapDelaysAt(pool, berths, new Date(now.getTime() + 10_000))).toEqual([
      expect.objectContaining({ band: "moderate", estimated: true }),
    ]);
  });

  it("estimates nothing for a train that hasn't been held long enough", async () => {
    const now = await dbNow();
    const train = await seedHeldTrain(
      new Date(now.getTime() - 2 * MINUTE),
      new Date(now.getTime() - 3 * MINUTE),
      5,
    );
    const result = await new HeldDelaySweep().run(
      pool,
      [{ tdArea: train.tdArea, berth: train.berth }],
      now,
    );
    expect(result).toMatchObject({ candidates: 1, activeEstimates: 0, changesRecorded: 0 });
  });
});

describe("estimate backfill replay (Milestone 97d, integration)", () => {
  it("replays a past hold as it was known then, recorded as backfill, and playback shows it", async () => {
    const now = await dbNow();
    const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE);
    // Held 90-30 minutes ago after a report 5 late; TRUST reported again (12 late) 20 minutes ago.
    const train = await seedHeldTrain(at(90), at(95), 5, at(30));
    await pool.query(
      `insert into trust_movement (trust_id, created, loc_stanox, actual_timestamp, timetable_variation, flags)
       values ($1, $2, '99999', $2, 12, $3)`,
      [train.trustId, at(20), DEPARTURE_LATE],
    );
    const berths = [{ tdArea: train.tdArea, berth: train.berth }];
    const sweep = new HeldDelaySweep();
    const state: ReplayState = new Map();

    // 10 minutes in: 5 + 10 − 3 = 12 late, on time. 30 minutes in: 32 late, moderate — the later
    // 12-late report isn't known yet, so it doesn't end the estimate.
    await sweep.replayStep(pool, berths, at(80), state);
    await sweep.replayStep(pool, berths, at(60), state);
    expect(state.get(train.trustId)?.state).toMatchObject({ band: "moderate", minutesLate: 32 });
    await sweep.closeReplay(pool, state, at(50));

    const rows = await pool.query(
      `select band, minutes_late, clear_reason, source,
              round(extract(epoch from ($2::timestamptz - effective_at)) / 60) as minutes_ago
         from estimated_delay_band_change where trust_id = $1 order by effective_at, id`,
      [train.trustId, now],
    );
    expect(rows.rows).toEqual([
      {
        band: "on_time",
        minutes_late: 12,
        clear_reason: null,
        source: "backfill",
        minutes_ago: "80",
      },
      {
        band: "moderate",
        minutes_late: 32,
        clear_reason: null,
        source: "backfill",
        minutes_ago: "60",
      },
      {
        band: "cleared",
        minutes_late: null,
        clear_reason: "backfill_end",
        source: "backfill",
        minutes_ago: "50",
      },
    ]);
    expect(await findMapDelaysAt(pool, berths, at(55))).toEqual([
      expect.objectContaining({ band: "moderate", estimated: true }),
    ]);
  });
});
