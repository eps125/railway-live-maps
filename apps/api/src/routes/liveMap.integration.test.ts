import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import { LIVE_PROTOCOL_VERSION, type LiveWsMessage } from "@railway/protocol";
import { registerLiveMapRoutes } from "./liveMap.js";
import { createPollingDeltaSource } from "../live/pollingDeltaSource.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

function uniqueSlug(): string {
  return `test-live-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Publishes a minimal map document (mirrors apps/worker's publishMap.integration.test.ts
 * fixture) directly via SQL, bypassing the worker CLI (this suite lives in apps/api, which
 * doesn't depend on apps/worker) — computes the same berthBindingIndex shape by hand since
 * there's only ever one berth binding needed here. */
async function publishMinimalMap(
  slug: string,
  elementId: string,
  tdArea: string,
  berth: string,
): Promise<{ mapVersionId: string }> {
  const bundle = {
    schemaVersion: 1,
    mapId: slug,
    mapName: slug,
    canvas: { width: 10, height: 10, gridSize: 1 },
    timezone: "Europe/London",
    layers: [],
    elementsById: { [elementId]: { id: elementId, type: "berth" } },
    berthBindingIndex: { [`${tdArea}|${berth}`]: elementId },
    sBitBindingIndex: {},
    boundingBox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    topologyAdjacency: {},
    continuationLinks: [],
  };

  const mapResult = await pool.query<{ id: string }>(
    `insert into map (slug, name) values ($1, $2) returning id`,
    [slug, slug],
  );
  const mapId = mapResult.rows[0]!.id;

  const versionResult = await pool.query<{ id: string }>(
    `insert into map_version (
       map_id, version_number, canonical_document, compiled_runtime_bundle,
       effective_from, published_by, schema_version, checksum
     ) values ($1, 1, $2, $3, now(), 'test', 1, 'test-checksum')
     returning id`,
    [mapId, JSON.stringify({}), JSON.stringify(bundle)],
  );
  const mapVersionId = versionResult.rows[0]!.id;

  await pool.query(
    `insert into map_binding_index (map_version_id, element_id, binding_type, td_area, berth)
     values ($1, $2, 'td_berth', $3, $4)`,
    [mapVersionId, elementId, tdArea, berth],
  );

  return { mapVersionId };
}

/** Drives a real berth_current_state change through the full FK chain
 * (raw_archive_object -> feed_frame -> raw_feed_event -> berth_current_state), the same
 * shape apps/worker's td projector writes, so this test exercises a realistic row rather
 * than a shortcut that skips the schema's real constraints. Returns the raw_feed_event's real
 * ingestion_sequence so the test can assert on it directly. */
async function setBerthCurrentState(
  tdArea: string,
  berth: string,
  description: string | null,
): Promise<number> {
  const archiveResult = await pool.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, 'test-bucket', $2, 1, 'broker-frame') returning id`,
    [`test/${randomUUID()}`, randomUUID()],
  );
  const archiveObjectId = archiveResult.rows[0]!.id;

  const frameResult = await pool.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, received_at, body_hash, archive_object_id)
     values ('TD', '/topic/TD_ALL_SIG_AREA', now(), $1, $2) returning id`,
    [randomUUID(), archiveObjectId],
  );
  const frameId = frameResult.rows[0]!.id;

  const now = new Date();
  const eventResult = await pool.query<{ id: string; ingestion_sequence: string }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       normalized_event_at_utc, received_at_utc, semantic_hash, parse_status, parse_version
     ) values ($1, 0, 'TD', 'CA', 'C', $2, '{}', $3, $3, $4, 'parsed', 1)
     returning id, ingestion_sequence`,
    [frameId, tdArea, now, randomUUID()],
  );
  const eventId = eventResult.rows[0]!.id;
  const ingestionSequence = Number(eventResult.rows[0]!.ingestion_sequence);

  await pool.query(
    `insert into berth_current_state (
       projection_version, td_area, berth_code, description, occupancy_entered_at, event_at,
       source_event_id, source_event_normalized_at_utc, source_ingestion_sequence
     ) values ($1, $2, $3, $4, $5, $6, $7, $6, $8)
     on conflict (projection_version, td_area, berth_code) do update set
       description = excluded.description,
       occupancy_entered_at = excluded.occupancy_entered_at,
       event_at = excluded.event_at,
       source_event_id = excluded.source_event_id,
       source_event_normalized_at_utc = excluded.source_event_normalized_at_utc,
       source_ingestion_sequence = excluded.source_ingestion_sequence`,
    [
      TD_PROJECTION_VERSION,
      tdArea,
      berth,
      description,
      description ? now : null,
      now,
      eventId,
      ingestionSequence,
    ],
  );

  return ingestionSequence;
}

function nextMessage(ws: {
  on: (event: string, cb: (data: unknown) => void) => void;
}): Promise<LiveWsMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for a WS message")), 5000);
    ws.on("message", (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse((data as Buffer).toString()) as LiveWsMessage);
    });
  });
}

describe("GET /api/v1/maps/:slug/live (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("sends a snapshot matching the protocol shape, then berth.updated deltas with non-decreasing sequence", async () => {
    const slug = uniqueSlug();
    const tdArea = `Z${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    const berth = "0001";
    await publishMinimalMap(slug, "berth-a", tdArea, berth);

    const app = Fastify();
    await app.register(fastifyWebsocket);
    const deltaSource = createPollingDeltaSource(pool, 100);
    await registerLiveMapRoutes(app, {
      pool,
      deltaSource,
      heartbeatIntervalMs: 60_000,
      versionCheckIntervalMs: 100,
    });
    await app.ready();

    const ws = await app.injectWS(`/api/v1/maps/${slug}/live`);
    try {
      const snapshot = await nextMessage(ws);
      expect(snapshot).toEqual({
        type: "snapshot",
        protocolVersion: LIVE_PROTOCOL_VERSION,
        sequence: 0,
        state: {
          mode: "live",
          quality: { status: "unknown", gaps: [] },
          berths: { "berth-a": { description: null, enteredAt: null, runSummary: null } },
          signals: {},
        },
      });

      const seq1 = await setBerthCurrentState(tdArea, berth, "1A23");
      const delta1 = await nextMessage(ws);
      expect(delta1.type).toBe("berth.updated");
      if (delta1.type !== "berth.updated") throw new Error("expected berth.updated");
      expect(delta1.elementId).toBe("berth-a");
      expect(delta1.description).toBe("1A23");
      expect(delta1.sequence).toBeGreaterThanOrEqual(seq1);

      const seq2 = await setBerthCurrentState(tdArea, berth, "1A24");
      const delta2 = await nextMessage(ws);
      expect(delta2.type).toBe("berth.updated");
      if (delta2.type !== "berth.updated") throw new Error("expected berth.updated");
      expect(delta2.description).toBe("1A24");
      expect(delta2.sequence).toBeGreaterThan(delta1.sequence);
      expect(seq2).toBeGreaterThan(seq1);
    } finally {
      ws.terminate();
      await app.close();
    }
  });
});
