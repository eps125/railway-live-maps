import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { registerTdRoutes } from "./td.js";

type QueryHandler = (text: string, values?: unknown[]) => { rows: unknown[] };

function fakePool(handler: QueryHandler): Pool {
  return {
    query: async (text: string, values?: unknown[]) => handler(text, values),
  } as unknown as Pool;
}

describe("td routes", () => {
  it("GET /api/v1/td/areas merges area summaries with last heartbeat", async () => {
    const pool = fakePool((text) => {
      if (text.includes("from raw_feed_event")) {
        return {
          rows: [
            {
              td_area: "ZZ",
              first_event_at: new Date("2026-08-01T00:00:00Z"),
              last_event_at: new Date("2026-08-04T00:00:00Z"),
              c_class_count: "10",
              s_class_count: "2",
            },
          ],
        };
      }
      if (text.includes("from td_heartbeat")) {
        return { rows: [{ td_area: "ZZ", last_heartbeat_at: new Date("2026-08-04T00:05:00Z") }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const app = Fastify();
    await registerTdRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: "/api/v1/td/areas" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      areas: [
        {
          tdArea: "ZZ",
          firstEventAt: "2026-08-01T00:00:00.000Z",
          lastEventAt: "2026-08-04T00:00:00.000Z",
          cClassCount: 10,
          sClassCount: 2,
          lastHeartbeatAt: "2026-08-04T00:05:00.000Z",
        },
      ],
    });
  });

  it("GET /api/v1/berths/:tdArea/:berth/history maps occupancy rows", async () => {
    const pool = fakePool((text) => {
      if (text.includes("from berth_occupancy")) {
        return {
          rows: [
            {
              id: "1",
              entered_at: new Date("2026-08-04T12:00:00Z"),
              left_at: new Date("2026-08-04T12:05:00Z"),
              description: "2A16",
              entry_reason: "ca_step",
              exit_reason: "stepped_out",
              resolution_status: "unmatched",
              anomaly_flags: [],
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const app = Fastify();
    await registerTdRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: "/api/v1/berths/ZZ/0101/history" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      intervals: [
        {
          enteredAt: "2026-08-04T12:00:00.000Z",
          leftAt: "2026-08-04T12:05:00.000Z",
          durationMs: 5 * 60 * 1000,
          description: "2A16",
          entryReason: "ca_step",
          exitReason: "stepped_out",
          resolutionStatus: "unmatched",
          anomalyFlags: [],
        },
      ],
      nextCursor: null,
    });
  });

  it("GET /api/v1/berths/:tdArea/:berth/history rejects an out-of-range window", async () => {
    const pool = fakePool(() => ({ rows: [] }));
    const app = Fastify();
    await registerTdRoutes(app, { pool });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/berths/ZZ/0101/history?from=2026-01-01T00:00:00Z&to=2026-08-01T00:00:00Z",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_TIME_RANGE");
  });

  it("GET /api/v1/td/areas/:area/berths paginates via nextCursor when the page is full", async () => {
    const pool = fakePool((text) => {
      if (text.includes("from (")) {
        return {
          rows: [
            {
              berth_code: "0001",
              first_observed_at: new Date("2026-08-01T00:00:00Z"),
              last_observed_at: new Date("2026-08-01T00:00:00Z"),
              event_count: "3",
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const app = Fastify();
    await registerTdRoutes(app, { pool });

    const response = await app.inject({ method: "GET", url: "/api/v1/td/areas/ZZ/berths?limit=1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      berths: [
        {
          berthCode: "0001",
          firstObservedAt: "2026-08-01T00:00:00.000Z",
          lastObservedAt: "2026-08-01T00:00:00.000Z",
          eventCount: 3,
        },
      ],
      nextCursor: "0001",
    });
  });
});
