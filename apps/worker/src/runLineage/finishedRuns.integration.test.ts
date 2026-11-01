import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool, resolveFreshRunMatch } from "@railway/database";

/**
 * ADR 0008 amendment (2026-11-01): an activated run wins only if it hasn't finished; a run that
 * finished counts only if it finished at this berth's location, and only when nothing else fits.
 * Modelled on the owner's report at Carlisle (CL 0302 2C38, CL 0305 1J70 at 00:20 on Sunday
 * 1 November): Saturday's Mon–Sat run, activated and finished at its destination, beat Sunday's
 * Sunday-only schedule, not yet activated. Fixed `today`/`asOf`, so independent of the real date.
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const AREA = `K${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
const suffix = randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase();
const ORIGIN = { tiploc: `FO${suffix}`, stanox: `8${suffix.slice(0, 4)}` };
const DEST = { tiploc: `FD${suffix}`, stanox: `9${suffix.slice(0, 4)}` };
const created = { schedules: [] as number[], smartSteps: [] as string[], trustIds: [] as string[] };
let nextScheduleId = Date.now();

// Sunday 1 November 2026, 00:20 GMT.
const TODAY = "2026-11-01";
const AT = new Date("2026-11-01T00:20:00Z");
const NOW_MINUTES = 20;

async function smartBerth(berth: string, stanox: string): Promise<void> {
  const result = await pool.query<{ id: string }>(
    `insert into smart_berth_step (td_area, from_berth, to_berth, stanox, event_type, raw_source_json)
     values ($1, $2, $3, $4, 'A', '{}') returning id`,
    [AREA, berth, `${berth}X`, stanox],
  );
  created.smartSteps.push(result.rows[0]!.id);
}

/** A schedule from ORIGIN (dep) to DEST (arr), running Mon–Sat or Sundays only. */
async function schedule(headcode: string, days: "mon-sat" | "sun", dep: string): Promise<number> {
  const id = nextScheduleId++;
  const sun = days === "sun";
  await pool.query(
    `insert into cif_schedules (
       id, created, cif_stp_indicator, cif_train_uid, signalling_id, runs_mo, runs_tu, runs_we,
       runs_th, runs_fr, runs_sa, runs_su, schedule_start_date, schedule_end_date
     ) values ($1, now(), 'P', $2, $3, $4, $4, $4, $4, $4, $4, $5, '2026-05-17', '2026-12-12')`,
    [id, `F${String(id).slice(-5)}`, headcode, !sun, sun],
  );
  await pool.query(
    `insert into cif_schedule_locations (cif_schedule_id, seq_no, record_identity, tiploc_code, departure)
     values ($1, 1, 'LO', $2, $3)`,
    [id, ORIGIN.tiploc, dep],
  );
  await pool.query(
    `insert into cif_schedule_locations (cif_schedule_id, seq_no, record_identity, tiploc_code, arrival)
     values ($1, 2, 'LT', $2, '0730')`,
    [id, DEST.tiploc],
  );
  created.schedules.push(id);
  return id;
}

/** Saturday's run of `scheduleId`: activated 04:50, terminated at DEST at 07:31. */
async function saturdayRunFinished(scheduleId: number, headcode: string): Promise<void> {
  const trustId = `99${headcode}M${suffix.slice(0, 1)}31`;
  await pool.query(
    `insert into trust_activation (trust_id, created, cif_schedule_id) values ($1, $2, $3)`,
    [trustId, new Date("2026-10-31T04:50:00Z"), scheduleId],
  );
  // Arrival at destination (kind 3) + terminated (bit 6).
  await pool.query(
    `insert into trust_movement (trust_id, created, loc_stanox, actual_timestamp, flags)
     values ($1, $2, $3, $2, $4)`,
    [trustId, new Date("2026-10-31T07:31:00Z"), DEST.stanox, 3 | (1 << 3) | 0x40],
  );
  created.trustIds.push(trustId);
}

afterAll(async () => {
  await pool.query("delete from trust_movement where trust_id = any($1::text[])", [
    created.trustIds,
  ]);
  await pool.query("delete from trust_activation where trust_id = any($1::text[])", [
    created.trustIds,
  ]);
  await pool.query("delete from smart_berth_step where id = any($1::bigint[])", [
    created.smartSteps,
  ]);
  await pool.query("delete from location_reference where tiploc = any($1::text[])", [
    [ORIGIN.tiploc, DEST.tiploc],
  ]);
  await pool.query("delete from cif_schedule_locations where cif_schedule_id = any($1::bigint[])", [
    created.schedules,
  ]);
  await pool.query("delete from cif_schedules where id = any($1::bigint[])", [created.schedules]);
  await pool.end();
});

describe("resolveFreshRunMatch — finished runs (integration)", () => {
  it("prefers today's not-yet-activated run over yesterday's activated, finished one — Carlisle 2C38", async () => {
    for (const place of [ORIGIN, DEST]) {
      await pool.query(
        `insert into location_reference (tiploc, name, stanox, raw_source_json) values ($1, 'Finished runs test', $2, '{}')`,
        [place.tiploc, place.stanox],
      );
    }
    await smartBerth("0302", ORIGIN.stanox);
    await smartBerth("0399", DEST.stanox);

    const saturday = await schedule("2F38", "mon-sat", "0552");
    const sunday = await schedule("2F38", "sun", "0800");
    await saturdayRunFinished(saturday, "2F38");

    const result = await resolveFreshRunMatch(pool, {
      tdArea: AREA,
      berth: "0302",
      headcode: "2F38",
      today: TODAY,
      nowMinutes: NOW_MINUTES,
      asOf: AT,
    });
    expect(result.matchStatus).toBe("matched");
    expect(result.effectiveRow?.id).toBe(String(sunday));
    expect(result.trafficDay).toBe(TODAY);
  });

  it("leaves a train unmatched rather than show a run that finished somewhere else", async () => {
    const saturday = await schedule("2F39", "mon-sat", "0600");
    await saturdayRunFinished(saturday, "2F39");

    const result = await resolveFreshRunMatch(pool, {
      tdArea: AREA,
      berth: "0302", // at the origin; Saturday's run ended at DEST
      headcode: "2F39",
      today: TODAY,
      nowMinutes: NOW_MINUTES,
      asOf: AT,
    });
    expect(result.matchStatus).toBe("unmatched");
  });

  it("keeps the run that finished here when nothing else fits — the train standing where it arrived", async () => {
    const saturday = await schedule("2F40", "mon-sat", "0610");
    await saturdayRunFinished(saturday, "2F40");

    const result = await resolveFreshRunMatch(pool, {
      tdArea: AREA,
      berth: "0399", // at DEST, where Saturday's run terminated
      headcode: "2F40",
      today: TODAY,
      nowMinutes: NOW_MINUTES,
      asOf: AT,
    });
    expect(result.matchStatus).toBe("matched");
    expect(result.effectiveRow?.id).toBe(String(saturday));
    expect(result.trafficDay).toBe("2026-10-31");
  });

  it("still prefers today's run over a run that finished here — the 5Z01 rule", async () => {
    const saturday = await schedule("2F41", "mon-sat", "0620");
    const sunday = await schedule("2F41", "sun", "0900");
    await saturdayRunFinished(saturday, "2F41");

    const result = await resolveFreshRunMatch(pool, {
      tdArea: AREA,
      berth: "0399",
      headcode: "2F41",
      today: TODAY,
      nowMinutes: NOW_MINUTES,
      asOf: AT,
    });
    expect(result.matchStatus).toBe("matched");
    expect(result.effectiveRow?.id).toBe(String(sunday));
  });
});
