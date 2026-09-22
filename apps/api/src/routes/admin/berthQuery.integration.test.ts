import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { registerBerthQueryRoutes } from "./berthQuery.js";
import { recordObservedBerthEvent } from "../../testSupport/tdEvents.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueArea(prefix: string): string {
  return `${prefix}${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`.slice(0, 8);
}

async function buildApp() {
  const app = Fastify();
  await registerBerthQueryRoutes(app, { pool });
  await app.ready();
  return app;
}

describe("admin berth query route (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("returns matching td_berth_event rows in time order, scoped to the requested areas and headcode", async () => {
    const app = await buildApp();
    const area = uniqueArea("Q");
    const otherArea = uniqueArea("R");
    const headcode = `H${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;

    // Two steps for the target headcode in the target area, one in a different area (excluded),
    // and one for a different headcode in the target area (also excluded).
    await recordObservedBerthEvent(pool, area, null, "0001", headcode);
    await recordObservedBerthEvent(pool, area, "0001", "0002", headcode);
    await recordObservedBerthEvent(pool, otherArea, null, "0099", headcode);
    await recordObservedBerthEvent(pool, area, null, "0003", "OTHERHC");

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/admin/berths/query?tdAreas=${area}&headcode=${headcode}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.events).toHaveLength(2);
    expect(body.events.every((e: { tdArea: string }) => e.tdArea === area)).toBe(true);
    expect(body.events.every((e: { description: string }) => e.description === headcode)).toBe(
      true,
    );
    // ascending event_at order
    expect(new Date(body.events[0].eventAt).getTime()).toBeLessThanOrEqual(
      new Date(body.events[1].eventAt).getTime(),
    );
    // recordObservedBerthEvent's messageType rule: fromBerth+toBerth -> CA, toBerth only -> CC,
    // fromBerth only -> CB (see apps/api/src/testSupport/tdEvents.ts).
    expect(body.events[0]).toMatchObject({ toBerth: "0001", messageType: "CC" });
    expect(body.events[1]).toMatchObject({ fromBerth: "0001", toBerth: "0002", messageType: "CA" });

    await app.close();
  });

  it("supports multiple TD areas via a comma-separated list", async () => {
    const app = await buildApp();
    const areaA = uniqueArea("S");
    const areaB = uniqueArea("T");
    const headcode = `H${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;

    await recordObservedBerthEvent(pool, areaA, null, "0011", headcode);
    await recordObservedBerthEvent(pool, areaB, null, "0022", headcode);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/admin/berths/query?tdAreas=${areaA},${areaB}&headcode=${headcode}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().events).toHaveLength(2);

    await app.close();
  });

  it("rejects a missing tdAreas with 400", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/berths/query?headcode=1A23",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("rejects a missing headcode with 400", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/berths/query?tdAreas=PX",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    await app.close();
  });

  it("rejects a time range beyond the permitted limit with 400", async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/berths/query?tdAreas=PX&headcode=1A23&from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_TIME_RANGE");
    await app.close();
  });

  it("lists the newest steps between a pair of berths, newest first (owner request 2026-09-22)", async () => {
    const app = await buildApp();
    // A real-looking two-character area; the berth codes are unique, so nothing else matches.
    const code = randomUUID().replace(/-/g, "").slice(0, 3).toUpperCase();
    const from = `F${code}`;
    const to = `T${code}`;
    await recordObservedBerthEvent(pool, "WZ", from, to, "1A01");
    await recordObservedBerthEvent(pool, "WZ", to, from, "1A02"); // the other way: excluded
    await recordObservedBerthEvent(pool, "WZ", from, to, "1A03");
    await recordObservedBerthEvent(pool, "WZ", null, to, "1A04"); // an interpose: excluded

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/admin/berths/steps?tdArea=wz&fromBerth=${from.toLowerCase()}&toBerth=${to}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ tdArea: "WZ", fromBerth: from, toBerth: to });
    expect(body.steps.map((s: { description: string }) => s.description)).toEqual(["1A03", "1A01"]);

    const limited = await app.inject({
      method: "GET",
      url: `/api/v1/admin/berths/steps?tdArea=WZ&fromBerth=${from}&toBerth=${to}&limit=1`,
    });
    expect(limited.json().steps).toHaveLength(1);
    await app.close();
  });

  it("rejects a berth-pair search without a two-character area or both berths", async () => {
    const app = await buildApp();
    for (const url of [
      "/api/v1/admin/berths/steps?tdArea=PXX&fromBerth=0001&toBerth=0002",
      "/api/v1/admin/berths/steps?tdArea=PX&fromBerth=0001",
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(400);
    }
    // An unrecognised look-back falls back to the default rather than failing.
    const fallback = await app.inject({
      method: "GET",
      url: "/api/v1/admin/berths/steps?tdArea=PX&fromBerth=0001&toBerth=0002&days=9999",
    });
    expect(fallback.json().days).toBe(7);
    await app.close();
  });
});
