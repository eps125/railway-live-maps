import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { registerMaintenanceRoutes } from "./maintenance.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const createdJobIds: string[] = [];
const SEEN_AREA = "YW";

async function buildApp() {
  const app = Fastify();
  app.decorateRequest("authSession", null);
  await registerMaintenanceRoutes(app, { pool });
  await app.ready();
  return app;
}

/** A berth the TD projector has seen in `SEEN_AREA`, so the area counts as known. */
async function seedSeenArea(): Promise<void> {
  const archive = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test-bucket', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const frame = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', now(), $1, $2) returning id`,
    [randomUUID(), archive.rows[0]!.id],
  );
  const event = await pool.query<{ id: string; normalized_event_at_utc: Date }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', 'CA', 'C', $2, '{}', $4, $4, $3, 'parsed', 1)
     returning id, normalized_event_at_utc`,
    [frame.rows[0]!.id, SEEN_AREA, randomUUID(), new Date()],
  );
  await pool.query(
    `insert into berth_current_state (
       projection_version, td_area, berth_code, description, event_at, source_event_id,
       source_event_normalized_at_utc, source_ingestion_sequence
     ) values ($1, $2, '0001', null, now(), $3, $4, 0)
     on conflict do nothing`,
    [TD_PROJECTION_VERSION, SEEN_AREA, event.rows[0]!.id, event.rows[0]!.normalized_event_at_utc],
  );
}

beforeEach(async () => {
  await pool.query(
    `update maintenance_job set status = 'cancelled', finished_at = now()
      where status in ('queued', 'running')`,
  );
});

afterAll(async () => {
  await pool.query("delete from berth_current_state where td_area = $1", [SEEN_AREA]);
  if (createdJobIds.length > 0) {
    await pool.query("delete from maintenance_job where id = any($1::bigint[])", [createdJobIds]);
  }
  await pool.end();
});

describe("admin maintenance routes (integration)", () => {
  it("queues a berth-allowances job for a seen area, lists it, audits it and cancels it", async () => {
    await seedSeenArea();
    const app = await buildApp();
    try {
      const queued = await app.inject({
        method: "POST",
        url: "/api/v1/admin/maintenance/jobs",
        payload: { kind: "berth_allowances", tdAreas: [SEEN_AREA.toLowerCase()] },
      });
      expect(queued.statusCode).toBe(201);
      const job = queued.json();
      createdJobIds.push(job.id);
      expect(job).toMatchObject({
        kind: "berth_allowances",
        tdAreas: [SEEN_AREA],
        params: { windowDays: 14 },
        status: "queued",
      });

      const audited = await pool.query(
        `select 1 from admin_audit_log
          where action = 'maintenance.queue' and target_type = 'maintenance_job' and target_id = $1`,
        [job.id],
      );
      expect(audited.rowCount).toBe(1);

      const list = await app.inject({ method: "GET", url: "/api/v1/admin/maintenance/jobs" });
      expect(list.json().jobs.some((j: { id: string }) => j.id === job.id)).toBe(true);

      const cancel = await app.inject({
        method: "POST",
        url: `/api/v1/admin/maintenance/jobs/${job.id}/cancel`,
      });
      expect(cancel.statusCode).toBe(200);
      expect(cancel.json().status).toBe("cancelled");

      const again = await app.inject({
        method: "POST",
        url: `/api/v1/admin/maintenance/jobs/${job.id}/cancel`,
      });
      expect(again.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("refuses an area no berth has been seen in, and a backfill of an unmapped area", async () => {
    const app = await buildApp();
    try {
      const unknown = await app.inject({
        method: "POST",
        url: "/api/v1/admin/maintenance/jobs",
        payload: { kind: "berth_allowances", tdAreas: ["YV"] },
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().error.code).toBe("UNKNOWN_TD_AREA");

      const unmapped = await app.inject({
        method: "POST",
        url: "/api/v1/admin/maintenance/jobs",
        payload: {
          kind: "link_backfill",
          tdAreas: ["YV"],
          params: {
            from: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            to: new Date().toISOString(),
          },
        },
      });
      expect(unmapped.statusCode).toBe(400);
      expect(unmapped.json().error.code).toBe("AREA_NOT_MAPPED");

      const areas = await app.inject({ method: "GET", url: "/api/v1/admin/maintenance/areas" });
      expect(areas.statusCode).toBe(200);
      expect(Array.isArray(areas.json().areas)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
