import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_S_STATE_PROJECTION_VERSION } from "@railway/domain";
import { registerSClassAdminRoutes } from "./sClass.js";

/** Milestone 64 / ADR 0016: suggesting route bits for a signal (integration). */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
// Real TD areas are two characters (the routes enforce it); "9x" isn't a real area code.
const AREA = `9${"ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]}`;
const rawIds: string[] = [];

async function rawEvent(at: Date, messageClass: "C" | "S", eventType: string) {
  const archive = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const frame = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', $2, $1, $3) returning id`,
    [randomUUID(), at, archive.rows[0]!.id],
  );
  const ev = await pool.query<{ id: string; ingestion_sequence: string }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', $2, $3, $4, '{}', $5, $5, $6, 'parsed', 1)
     returning id, ingestion_sequence::text`,
    [frame.rows[0]!.id, eventType, messageClass, AREA, at, randomUUID()],
  );
  rawIds.push(ev.rows[0]!.id);
  return ev.rows[0]!;
}

async function berthStep(from: string, to: string, at: Date): Promise<void> {
  const raw = await rawEvent(at, "C", "CA");
  await pool.query(
    `insert into td_berth_event (raw_event_id, raw_event_normalized_at_utc, td_area, message_type,
       from_berth, to_berth, description, event_at, ingestion_sequence, normalization_version)
     values ($1, $2, $3, 'CA', $4, $5, '1A23', $2, $6, 1)`,
    [raw.id, at, AREA, from, to, raw.ingestion_sequence],
  );
}

async function bitChange(
  address: string,
  bit: number,
  previous: boolean | null,
  next: boolean,
  at: Date,
): Promise<void> {
  const raw = await rawEvent(at, "S", "SF_MSG");
  await pool.query(
    `insert into td_s_bit_transition (projection_version, td_area, address, bit_index,
       previous_value, new_value, event_at, source_event_id, source_event_normalized_at_utc,
       source_kind, source_ingestion_sequence)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $7, 'update', $9)`,
    [
      TD_S_STATE_PROJECTION_VERSION,
      AREA,
      address,
      bit,
      previous,
      next,
      at,
      raw.id,
      raw.ingestion_sequence,
    ],
  );
}

// One fixed "now" for every fixture row: reading the clock per insert let the time the inserts
// themselves take leak into the measured lead and hold times.
const NOW = Date.now();
const minutesAgo = (m: number, plusSeconds = 0): Date =>
  new Date(NOW - m * 60_000 + plusSeconds * 1000);

// Signal 03:2 (a set bit means off) clears five times. Route A (0C:4) is set 60 s before each of
// the first three clears and released 90 s after, as a train steps 0100 -> 0102; route B (0C:5)
// is set 45 s before the last two and released 30 s after. Bit 04:0 toggles every two minutes
// regardless, so it is often "set before a clear" by chance but mostly isn't.
beforeAll(async () => {
  for (const m of [50, 40, 30, 20, 10]) {
    await bitChange("03", 2, false, true, minutesAgo(m));
    await bitChange("03", 2, true, false, minutesAgo(m, 150));
  }
  for (const m of [50, 40, 30]) {
    await bitChange("0C", 4, false, true, minutesAgo(m, -60));
    await bitChange("0C", 4, true, false, minutesAgo(m, 90));
    await berthStep("0100", "0102", minutesAgo(m, 91));
  }
  for (const m of [20, 10]) {
    await bitChange("0C", 5, false, true, minutesAgo(m, -45));
    await bitChange("0C", 5, true, false, minutesAgo(m, 30));
  }
  for (let m = 58; m > 2; m -= 2) {
    await bitChange("04", 0, m % 4 === 0, m % 4 !== 0, minutesAgo(m, 7));
  }
});

afterAll(async () => {
  await pool.query("delete from td_s_bit_transition where td_area = $1", [AREA]);
  await pool.query("delete from td_berth_event where td_area = $1", [AREA]);
  await pool.query("delete from raw_feed_event where id = any($1::bigint[])", [rawIds]);
  await pool.end();
});

async function buildApp() {
  const app = Fastify();
  app.decorateRequest("authSession", null);
  await registerSClassAdminRoutes(app, { pool });
  await app.ready();
  return app;
}

describe("route bits for a signal (integration)", () => {
  it("ranks the bits set before the signal clears, with lead and hold times", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        url: `/api/v1/admin/s-class/areas/${AREA}/bits/03/2/route-candidates?activeMeans=off`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.clears).toBe(5);
      expect(body.candidates[0]).toMatchObject({
        address: "0C",
        bit: 4,
        direction: "set",
        hits: 3,
        ofClears: 5,
        ofTransitions: 3,
      });
      expect(body.candidates[0].medianLeadSeconds).toBeCloseTo(60, 0);
      expect(body.candidates[0].medianHeldSeconds).toBeCloseTo(90, 0);
      expect(body.candidates[1]).toMatchObject({
        address: "0C",
        bit: 5,
        direction: "set",
        hits: 2,
        ofTransitions: 2,
      });
      expect(body.candidates[1].medianLeadSeconds).toBeCloseTo(45, 0);
      // The noisy bit may appear, but never ahead of the two real routes, and the signal's own
      // bit is never offered as a route for itself.
      const keys = body.candidates.map(
        (c: { address: string; bit: number }) => `${c.address}:${c.bit}`,
      );
      expect(keys.indexOf("04:0")).not.toBe(0);
      expect(keys).not.toContain("03:2");
    } finally {
      await app.close();
    }
  });

  it("reads clears the other way for a signal whose set bit means on", async () => {
    const app = await buildApp();
    try {
      const body = (
        await app.inject({
          url: `/api/v1/admin/s-class/areas/${AREA}/bits/03/2/route-candidates?activeMeans=on`,
        })
      ).json();
      // Now the 1 -> 0 changes count as clears, so the routes being *set* no longer lead them:
      // polarity is the author's statement, never guessed, and changes the answer.
      expect(body.clears).toBe(5);
      const setRoutes = body.candidates.filter(
        (c: { address: string; direction: string }) => c.address === "0C" && c.direction === "set",
      );
      expect(setRoutes).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("rejects an activeMeans that isn't on or off", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        url: `/api/v1/admin/s-class/areas/${AREA}/bits/03/2/route-candidates?activeMeans=set`,
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
