import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { registerEditorBerthActionRoutes } from "./berthActions.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueArea(): string {
  return `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
}

/** Seeds a fully-linked open occupancy — raw_archive_object -> feed_frame -> raw_feed_event ->
 * berth_occupancy -> berth_current_state (with occupancy_id set), mirroring exactly what
 * apps/worker/src/td/projector.ts's `openOccupancy` effect writes — unlike the simpler
 * testSupport/tdEvents.ts helper, which never sets occupancy_id and so can't exercise the clear
 * endpoint's real "is this berth actually open" check. */
async function seedOpenOccupancy(
  tdArea: string,
  berth: string,
  description: string,
): Promise<{ occupancyId: string }> {
  const archiveResult = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test-bucket', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const frameResult = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', now(), $1, $2) returning id`,
    [randomUUID(), archiveResult.rows[0]!.id],
  );
  const now = new Date();
  const eventResult = await pool.query<{ id: string; ingestion_sequence: string }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', 'CC', 'C', $2, '{}', $3, $3, $4, 'parsed', 1)
     returning id, ingestion_sequence`,
    [frameResult.rows[0]!.id, tdArea, now, randomUUID()],
  );
  const eventId = eventResult.rows[0]!.id;
  const ingestionSequence = eventResult.rows[0]!.ingestion_sequence;

  const occupancyResult = await pool.query<{ id: string }>(
    `insert into berth_occupancy (
       projection_version, td_area, berth_code, description, entered_at,
       entry_event_id, entry_event_normalized_at_utc, entry_reason
     ) values ($1, $2, $3, $4, $5, $6, $5, 'cc_interpose')
     returning id`,
    [TD_PROJECTION_VERSION, tdArea, berth, description, now, eventId],
  );
  const occupancyId = occupancyResult.rows[0]!.id;

  await pool.query(
    `insert into berth_current_state (
       projection_version, td_area, berth_code, description, occupancy_id, occupancy_entered_at,
       event_at, source_event_id, source_event_normalized_at_utc, source_ingestion_sequence
     ) values ($1, $2, $3, $4, $5, $6, $6, $7, $6, $8)`,
    [
      TD_PROJECTION_VERSION,
      tdArea,
      berth,
      description,
      occupancyId,
      now,
      eventId,
      ingestionSequence,
    ],
  );

  return { occupancyId };
}

async function buildApp() {
  const app = Fastify();
  await registerEditorBerthActionRoutes(app, { pool });
  await app.ready();
  return app;
}

describe("POST /api/v1/editor/berths/:tdArea/:berth/clear (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("closes the open occupancy and clears berth_current_state", async () => {
    const area = uniqueArea();
    const { occupancyId } = await seedOpenOccupancy(area, "0512", "1A23");

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/editor/berths/${area}/0512/clear`,
        payload: { reason: "stuck after a feed gap" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        tdArea: area,
        berth: "0512",
        cleared: true,
        previousDescription: "1A23",
      });

      const state = await pool.query(
        `select description, occupancy_id from berth_current_state
         where projection_version = $1 and td_area = $2 and berth_code = $3`,
        [TD_PROJECTION_VERSION, area, "0512"],
      );
      expect(state.rows[0]).toMatchObject({ description: null, occupancy_id: null });

      const occupancy = await pool.query(
        `select left_at, exit_reason from berth_occupancy where id = $1`,
        [occupancyId],
      );
      expect(occupancy.rows[0].left_at).not.toBeNull();
      expect(occupancy.rows[0].exit_reason).toBe("manual_operator_clear");

      const audit = await pool.query(
        `select action_type, reason, closed_occupancy_id from operator_berth_action
         where td_area = $1 and berth_code = $2`,
        [area, "0512"],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({
        action_type: "clear",
        reason: "stuck after a feed gap",
        closed_occupancy_id: occupancyId,
      });
    } finally {
      await app.close();
    }
  });

  it("is idempotent — clearing an already-clear berth reports cleared: false and still records the attempt", async () => {
    const area = uniqueArea();
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/editor/berths/${area}/0999/clear`,
        payload: { reason: "double-checking" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ cleared: false, previousDescription: null });

      const audit = await pool.query(
        `select closed_occupancy_id from operator_berth_action where td_area = $1 and berth_code = $2`,
        [area, "0999"],
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].closed_occupancy_id).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("400s when reason is missing or blank", async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/editor/berths/${uniqueArea()}/0001/clear`,
        payload: { reason: "   " },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("VALIDATION_ERROR");
    } finally {
      await app.close();
    }
  });
});
