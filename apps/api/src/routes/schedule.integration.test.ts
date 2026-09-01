import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerScheduleRoutes } from "./schedule.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

let nextScheduleId = Date.now();
function newScheduleId(): number {
  return nextScheduleId++;
}

function uniqueTrainUid(): string {
  return `T${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
}

interface InsertScheduleInput {
  id: number;
  trainUid: string;
  scheduleStartDate: string;
  scheduleEndDate: string;
  stpIndicator: "C" | "N" | "O" | "P";
  daysRunsBitmask?: string;
}

/** Inserts a garner-shaped `cif_schedules` row (migration 0024). `days_runs_bitmask` is a
 * generated column, so we set the seven `runs_*` booleans from the requested bitmask. */
async function insertSchedule(input: InsertScheduleInput): Promise<void> {
  const mask = input.daysRunsBitmask ?? "1111111";
  const runs = Array.from({ length: 7 }, (_, i) => mask.charAt(i) === "1");
  await pool.query(
    `insert into cif_schedules (
       id, created, cif_stp_indicator, cif_train_uid,
       runs_mo, runs_tu, runs_we, runs_th, runs_fr, runs_sa, runs_su,
       schedule_start_date, schedule_end_date, atoc_code, cif_power_type
     ) values ($1, now(), $2, $3, $4,$5,$6,$7,$8,$9,$10, $11, $12, 'NT', 'EMU')`,
    [
      input.id,
      input.stpIndicator,
      input.trainUid,
      runs[0],
      runs[1],
      runs[2],
      runs[3],
      runs[4],
      runs[5],
      runs[6],
      input.scheduleStartDate,
      input.scheduleEndDate,
    ],
  );
}

async function insertLocation(
  scheduleId: number,
  seqNo: number,
  tiploc: string,
  recordIdentity: string,
): Promise<void> {
  await pool.query(
    `insert into cif_schedule_locations (cif_schedule_id, seq_no, record_identity, tiploc_code)
     values ($1,$2,$3,$4)`,
    [scheduleId, seqNo, recordIdentity, tiploc],
  );
}

describe("schedule routes (integration)", () => {
  const createdTrainUids: string[] = [];

  afterAll(async () => {
    if (createdTrainUids.length > 0) {
      await pool.query("delete from cif_schedules where cif_train_uid = any($1::text[])", [
        createdTrainUids,
      ]);
    }
    await pool.end();
  });

  it("GET /api/v1/schedule/:trainUid resolves a single matching Permanent schedule with its locations", async () => {
    const trainUid = uniqueTrainUid();
    createdTrainUids.push(trainUid);
    const scheduleId = newScheduleId();
    await insertSchedule({
      id: scheduleId,
      trainUid,
      scheduleStartDate: "2026-01-01",
      scheduleEndDate: "2026-12-31",
      stpIndicator: "P",
    });
    await insertLocation(scheduleId, 1, "PRST", "LO");
    await insertLocation(scheduleId, 2, "LANCSTR", "LT");

    const app = Fastify();
    await registerScheduleRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/schedule/${trainUid}?date=2026-08-10`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outcome).toBe("matched");
    expect(body.schedule).toMatchObject({ trainUid, stpIndicator: "P", source: "GARNER" });
    expect(body.locations).toEqual([
      expect.objectContaining({ seqNo: 1, tiploc: "PRST", locationType: "origin" }),
      expect.objectContaining({ seqNo: 2, tiploc: "LANCSTR", locationType: "destination" }),
    ]);
  });

  it("an Overlay beats the Permanent schedule it overlays on the service date it covers", async () => {
    const trainUid = uniqueTrainUid();
    createdTrainUids.push(trainUid);
    await insertSchedule({
      id: newScheduleId(),
      trainUid,
      scheduleStartDate: "2026-01-01",
      scheduleEndDate: "2026-12-31",
      stpIndicator: "P",
    });
    await insertSchedule({
      id: newScheduleId(),
      trainUid,
      scheduleStartDate: "2026-08-10",
      scheduleEndDate: "2026-08-10",
      stpIndicator: "O",
    });

    const app = Fastify();
    await registerScheduleRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/schedule/${trainUid}?date=2026-08-10`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().schedule).toMatchObject({ stpIndicator: "O" });
  });

  it("reports ambiguous rather than arbitrarily picking between two same-precedence candidates", async () => {
    const trainUid = uniqueTrainUid();
    createdTrainUids.push(trainUid);
    await insertSchedule({
      id: newScheduleId(),
      trainUid,
      scheduleStartDate: "2026-01-01",
      scheduleEndDate: "2026-12-31",
      stpIndicator: "P",
    });
    await insertSchedule({
      id: newScheduleId(),
      trainUid,
      scheduleStartDate: "2026-01-01",
      scheduleEndDate: "2026-12-31",
      stpIndicator: "P",
    });

    const app = Fastify();
    await registerScheduleRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/schedule/${trainUid}?date=2026-08-10`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outcome).toBe("ambiguous");
    expect(body.candidates).toHaveLength(2);
  });

  it("returns unmatched (404) when no candidate's date range covers the service date", async () => {
    const trainUid = uniqueTrainUid();
    createdTrainUids.push(trainUid);
    await insertSchedule({
      id: newScheduleId(),
      trainUid,
      scheduleStartDate: "2020-01-01",
      scheduleEndDate: "2020-12-31",
      stpIndicator: "P",
    });

    const app = Fastify();
    await registerScheduleRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/schedule/${trainUid}?date=2026-08-10`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ outcome: "unmatched" });
  });

  it("returns 404 with SCHEDULE_NOT_FOUND when the train_uid has never been seen at all", async () => {
    const app = Fastify();
    await registerScheduleRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/schedule/NEVERSEEN?date=2026-08-10`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("SCHEDULE_NOT_FOUND");
  });

  it("rejects a missing or malformed date query param", async () => {
    const app = Fastify();
    await registerScheduleRoutes(app, { pool });

    const missing = await app.inject({ method: "GET", url: "/api/v1/schedule/ANY" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("INVALID_DATE");

    const malformed = await app.inject({
      method: "GET",
      url: "/api/v1/schedule/ANY?date=10-08-2026",
    });
    expect(malformed.statusCode).toBe(400);
  });
});
