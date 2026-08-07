import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { registerVstpRoutes } from "./vstp.js";

type QueryHandler = (text: string, values?: unknown[]) => { rows: unknown[] };

function fakePool(handler: QueryHandler): Pool {
  return {
    query: async (text: string, values?: unknown[]) => handler(text, values),
  } as unknown as Pool;
}

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "10",
    train_uid: "Z12345",
    schedule_start_date: "2026-08-07",
    schedule_end_date: "2026-08-07",
    stp_indicator: "N",
    days_runs_bitmask: "1111100",
    signalling_id: "1A23",
    operator_code: "GW",
    train_service_code: "12345600",
    train_category: "XX",
    train_status: "P",
    power_type: "EMU",
    origin_tiploc: "PADTON",
    destination_tiploc: "BRSTLTM",
    created_at: new Date("2026-08-07T12:00:00Z"),
    ...overrides,
  };
}

describe("vstp routes", () => {
  it("GET /api/v1/vstp/schedules lists VSTP-sourced schedules most-recent-first", async () => {
    const pool = fakePool((text, values) => {
      expect(text).toContain("source = 'VSTP'");
      expect(text).not.toContain("operator_code =");
      expect(values).toEqual([100]);
      return { rows: [row()] };
    });

    const app = Fastify();
    await registerVstpRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: "/api/v1/vstp/schedules" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      schedules: [
        {
          id: "10",
          trainUid: "Z12345",
          scheduleStartDate: "2026-08-07",
          scheduleEndDate: "2026-08-07",
          stpIndicator: "N",
          daysRunsBitmask: "1111100",
          signallingId: "1A23",
          operatorCode: "GW",
          trainServiceCode: "12345600",
          trainCategory: "XX",
          trainStatus: "P",
          powerType: "EMU",
          originTiploc: "PADTON",
          destinationTiploc: "BRSTLTM",
          createdAt: "2026-08-07T12:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
  });

  it("filters by atocCode when supplied", async () => {
    const pool = fakePool((text, values) => {
      expect(text).toContain("operator_code = $1");
      expect(values).toEqual(["GW", 100]);
      return { rows: [row({ operator_code: "GW" })] };
    });

    const app = Fastify();
    await registerVstpRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/vstp/schedules?atocCode=GW",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().schedules).toHaveLength(1);
  });

  it("paginates backward in time via before/nextCursor once a full page comes back", async () => {
    const pool = fakePool((text, values) => {
      if (!text.includes("id <")) {
        // First page: a full page (limit=1) comes back, so nextCursor should be set.
        expect(values).toEqual([1]);
        return { rows: [row({ id: "10" })] };
      }
      // Second page, following nextCursor via `before`.
      expect(text).toContain("id < $1");
      expect(values).toEqual(["10", 1]);
      return { rows: [row({ id: "9" })] };
    });

    const app = Fastify();
    await registerVstpRoutes(app, { pool });

    const first = await app.inject({ method: "GET", url: "/api/v1/vstp/schedules?limit=1" });
    expect(first.json().nextCursor).toBe("10");

    const second = await app.inject({
      method: "GET",
      url: "/api/v1/vstp/schedules?limit=1&before=10",
    });
    expect(second.json().schedules[0].id).toBe("9");
  });
});
