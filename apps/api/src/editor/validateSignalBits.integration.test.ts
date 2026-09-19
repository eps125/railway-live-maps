import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_S_STATE_PROJECTION_VERSION } from "@railway/domain";
import { MapDocumentSchema } from "@railway/map-schema";
import { validateDraftInContext } from "./validateWithContext.js";

/** Milestone 36c: the editor warns when a bound signal bit hasn't been seen changing. */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const AREA = `8${"ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.floor(Math.random() * 24)]}`;
let rawId: string;

beforeAll(async () => {
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
  const raw = await pool.query<{ id: string; ingestion_sequence: string }>(
    `insert into raw_feed_event (frame_id, child_index, feed_name, event_type, message_class,
       td_area, raw_event_json, normalized_event_at_utc, received_at_utc, semantic_hash,
       parse_status, parse_version)
     values ($1, 0, 'TD', 'SF_MSG', 'S', $2, '{}', now(), now(), $3, 'parsed', 1)
     returning id, ingestion_sequence::text`,
    [frame.rows[0]!.id, AREA, randomUUID()],
  );
  rawId = raw.rows[0]!.id;
  // Bit 03:2 changed an hour ago; bit 03:5 has only a first-sight row (no previous value).
  for (const [bit, previous] of [
    [2, false],
    [5, null],
  ] as const) {
    await pool.query(
      `insert into td_s_bit_transition (projection_version, td_area, address, bit_index,
         previous_value, new_value, event_at, source_event_id, source_event_normalized_at_utc,
         source_kind, source_ingestion_sequence)
       select $1, $2, '03', $3, $4, true, now() - interval '1 hour', id, normalized_event_at_utc,
              'update', ingestion_sequence
         from raw_feed_event where id = $5`,
      [TD_S_STATE_PROJECTION_VERSION, AREA, bit, previous, rawId],
    );
  }
});

afterAll(async () => {
  await pool.query("delete from td_s_bit_transition where td_area = $1", [AREA]);
  await pool.query("delete from raw_feed_event where id = $1", [rawId]);
  await pool.end();
});

function docWithSignalBits(bits: number[]) {
  return MapDocumentSchema.parse({
    schemaVersion: 1,
    map: {
      id: "sig-validate",
      name: "Signal validate",
      canvas: { width: 100, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l1", name: "Signals", order: 0 }],
    elements: bits.map((bit) => ({ id: `s${bit}`, layerId: "l1", type: "signal", x: 0, y: 0 })),
    topology: { nodes: [], edges: [] },
    bindings: bits.map((bit) => ({
      id: `b${bit}`,
      elementId: `s${bit}`,
      type: "tdSBit",
      tdArea: AREA,
      address: "3",
      bit,
      activeMeans: "off",
    })),
    editorMetadata: {},
  });
}

describe("validateDraftInContext — S-Class signal bits (integration)", () => {
  it("warns only for bound bits not seen changing in the last 7 days", async () => {
    const result = await validateDraftInContext(pool, docWithSignalBits([2, 5]));
    const signalWarnings = result.warnings.filter((w) => w.code === "signal_bit_never_changed");
    // 03:2 changed (and "3" is canonicalised to "03"); 03:5 was only ever first-seen.
    expect(signalWarnings).toEqual([expect.objectContaining({ bindingId: "b5", elementId: "s5" })]);
    expect(result.valid).toBe(true);
  });
});
