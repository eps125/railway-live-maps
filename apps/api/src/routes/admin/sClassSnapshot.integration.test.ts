import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_S_STATE_PROJECTION_VERSION } from "@railway/domain";
import { registerSClassAdminRoutes } from "./sClass.js";

/** Milestone 65: the map viewer's S-Class mini explorer snapshot (integration). */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
// A two-character area (the routes enforce it) no real area uses, distinct from the other S-Class
// integration tests' "9x" areas so parallel files can't collide.
const AREA = `8${"ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]}`;
const rawIds: string[] = [];
// One fixed "now" for every fixture row and query.
const NOW = Date.now();
const minutesAgo = (m: number): Date => new Date(NOW - m * 60_000);

async function rawSEvent(at: Date): Promise<{ id: string; ingestion_sequence: string }> {
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
     ) values ($1, 0, 'TD', 'SF_MSG', 'S', $2, '{}', $3, $3, $4, 'parsed', 1)
     returning id, ingestion_sequence::text`,
    [frame.rows[0]!.id, AREA, at, randomUUID()],
  );
  rawIds.push(ev.rows[0]!.id);
  return ev.rows[0]!;
}

/** A decoded SF statement of one byte, as `project-td` writes it. */
async function byteStated(address: string, value: number, at: Date): Promise<void> {
  const raw = await rawSEvent(at);
  await pool.query(
    `insert into td_s_event (
       raw_event_id, raw_event_normalized_at_utc, td_area, message_type, address, raw_value,
       decoded_bitset, event_at, ingestion_sequence, normalization_version, decode_status,
       decode_version
     ) values ($1, $2, $3, 'SF', $4, 'xx', $5, $2, $6, 1, 'decoded', 1)`,
    [
      raw.id,
      at,
      AREA,
      address,
      JSON.stringify({ bytes: { [address]: value } }),
      raw.ingestion_sequence,
    ],
  );
}

async function bitChange(address: string, bit: number, next: boolean, at: Date): Promise<void> {
  const raw = await rawSEvent(at);
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
      !next,
      next,
      at,
      raw.id,
      raw.ingestion_sequence,
    ],
  );
}

/** A byte's row in `td_s_current_state`. A `null` value is a byte the area has mentioned but that
 * never decoded — the projector writes exactly that (`raw_only`, no value); a decoded row always
 * comes with its decoded `td_s_event`. */
async function currentByte(address: string, value: number | null, at: Date): Promise<void> {
  const raw = await rawSEvent(at);
  await pool.query(
    `insert into td_s_current_state (projection_version, td_area, address, raw_value, byte_value,
       decoded_bitset, event_at, source_event_id, source_event_normalized_at_utc,
       source_ingestion_sequence, decode_status, source_kind)
     values ($1, $2, $3, 'xx', $4, '[]', $5, $6, $5, $7, $8, 'update')`,
    [
      TD_S_STATE_PROJECTION_VERSION,
      AREA,
      address,
      value,
      at,
      raw.id,
      raw.ingestion_sequence,
      value === null ? "raw_only" : "decoded",
    ],
  );
}

// Byte 03: 0x04 from 10 minutes ago, 0x00 from 1 minute ago (bit 2 cleared then). Bit 2 also
// changed 30 minutes ago, outside a 2-minute window. Byte 05 is known to the area but has no
// decoded statement at all, so its value is unknown rather than guessed.
beforeAll(async () => {
  await currentByte("03", 0x00, minutesAgo(1));
  await currentByte("05", null, minutesAgo(1));
  await byteStated("03", 0x04, minutesAgo(10));
  await byteStated("03", 0x00, minutesAgo(1));
  await bitChange("03", 2, true, minutesAgo(30));
  await bitChange("03", 2, false, minutesAgo(1));
  await pool.query(
    `insert into s_class_definition (td_area, address, bit, kind, label, source, updated_by)
     values ($1, '03', 2, 'signal', 'S3003', 'observed', 'test')`,
    [AREA],
  );
});

afterAll(async () => {
  await pool.query("delete from s_class_definition where td_area = $1", [AREA]);
  await pool.query("delete from td_s_bit_transition where td_area = $1", [AREA]);
  await pool.query("delete from td_s_event where td_area = $1", [AREA]);
  await pool.query("delete from td_s_current_state where td_area = $1", [AREA]);
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

const at = (m: number): string => encodeURIComponent(minutesAgo(m).toISOString());

describe("S-Class mini explorer snapshot (integration)", () => {
  it("gives each byte as it was at the time asked, and the changes just before it", async () => {
    const app = await buildApp();
    try {
      const now = (
        await app.inject({
          url: `/api/v1/admin/s-class/areas/${AREA}/snapshot?at=${at(0)}&windowSeconds=120`,
        })
      ).json();
      expect(now.bytes).toEqual([
        { address: "03", value: 0 },
        { address: "05", value: null },
      ]);
      expect(now.changes).toEqual([
        {
          address: "03",
          bit: 2,
          previousValue: true,
          newValue: false,
          eventAt: minutesAgo(1).toISOString(),
        },
      ]);
      expect(now.definitions).toEqual([expect.objectContaining({ bit: 2, label: "S3003" })]);

      // Five minutes ago (playback): byte 03 was still 0x04, and nothing changed in the 2 minutes
      // before then.
      const earlier = (
        await app.inject({
          url: `/api/v1/admin/s-class/areas/${AREA}/snapshot?at=${at(5)}&windowSeconds=120`,
        })
      ).json();
      expect(earlier.bytes[0]).toEqual({ address: "03", value: 4 });
      expect(earlier.changes).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("rejects a bad area, time or window", async () => {
    const app = await buildApp();
    try {
      for (const url of [
        "/api/v1/admin/s-class/areas/PXX/snapshot",
        `/api/v1/admin/s-class/areas/${AREA}/snapshot?at=yesterday`,
        `/api/v1/admin/s-class/areas/${AREA}/snapshot?windowSeconds=0`,
        `/api/v1/admin/s-class/areas/${AREA}/snapshot?windowSeconds=7200`,
      ]) {
        expect((await app.inject({ url })).statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });
});
