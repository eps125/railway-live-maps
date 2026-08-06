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

function uniqueTrainUid(): string {
  return `T${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

interface InsertScheduleInput {
  trainUid: string;
  scheduleStartDate: string;
  scheduleEndDate: string;
  stpIndicator: "C" | "N" | "O" | "P";
  daysRunsBitmask?: string;
  source?: "SCHEDULE" | "VSTP";
}

async function insertSchedule(input: InsertScheduleInput): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into schedule (
       train_uid, schedule_start_date, schedule_end_date, stp_indicator, days_runs_bitmask,
       origin_tiploc, destination_tiploc, source, raw_source_json
     ) values ($1,$2,$3,$4,$5,'PRST','LANCSTR',$6,'{}')
     returning id`,
    [
      input.trainUid,
      input.scheduleStartDate,
      input.scheduleEndDate,
      input.stpIndicator,
      input.daysRunsBitmask ?? "1111111",
      input.source ?? "SCHEDULE",
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Expected schedule insert to return an id");
  return id;
}

async function insertLocation(scheduleId: string, seqNo: number, tiploc: string): Promise<void> {
  await pool.query(
    `insert into schedule_location (schedule_id, seq_no, location_type, tiploc)
     values ($1,$2,$3,$4)`,
    [scheduleId, seqNo, seqNo === 1 ? "origin" : "destination", tiploc],
  );
}

describe("schedule routes (integration)", () => {
  const createdTrainUids: string[] = [];

  afterAll(async () => {
    if (createdTrainUids.length > 0) {
      await pool.query("delete from schedule where train_uid = any($1::text[])", [
        createdTrainUids,
      ]);
    }
    await pool.end();
  });

  it("GET /api/v1/schedule/:trainUid resolves a single matching Permanent schedule with its locations", async () => {
    const trainUid = uniqueTrainUid();
    createdTrainUids.push(trainUid);
    const scheduleId = await insertSchedule({
      trainUid,
      scheduleStartDate: "2026-01-01",
      scheduleEndDate: "2026-12-31",
      stpIndicator: "P",
    });
    await insertLocation(scheduleId, 1, "PRST");
    await insertLocation(scheduleId, 2, "LANCSTR");

    const app = Fastify();
    await registerScheduleRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/schedule/${trainUid}?date=2026-08-10`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.outcome).toBe("matched");
    expect(body.schedule).toMatchObject({ trainUid, stpIndicator: "P" });
    expect(body.locations).toEqual([
      expect.objectContaining({ seqNo: 1, tiploc: "PRST" }),
      expect.objectContaining({ seqNo: 2, tiploc: "LANCSTR" }),
    ]);
  });

  it("an Overlay beats the Permanent schedule it overlays on the service date it covers", async () => {
    const trainUid = uniqueTrainUid();
    createdTrainUids.push(trainUid);
    await insertSchedule({
      trainUid,
      scheduleStartDate: "2026-01-01",
      scheduleEndDate: "2026-12-31",
      stpIndicator: "P",
    });
    await insertSchedule({
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
      trainUid,
      scheduleStartDate: "2026-01-01",
      scheduleEndDate: "2026-12-31",
      stpIndicator: "P",
    });
    await insertSchedule({
      trainUid,
      scheduleStartDate: "2026-01-01",
      scheduleEndDate: "2026-12-31",
      stpIndicator: "P",
      source: "VSTP",
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
