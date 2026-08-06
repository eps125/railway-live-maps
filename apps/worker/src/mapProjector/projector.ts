import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  getOrCreateProjectionDefinition,
  ensureCheckpoint,
  getCheckpoint,
  advanceCheckpoint,
} from "@railway/database";
import { MAP_DELTA_PROJECTION_NAME, MAP_DELTA_PROJECTION_VERSION } from "@railway/domain";
import { berthChangesForEvent, buildDeltaMessages, type MapBinding } from "./deltaBuilder.js";

export { MAP_DELTA_PROJECTION_NAME, MAP_DELTA_PROJECTION_VERSION };

const DEFAULT_BATCH_SIZE = 500;

/** Structural subset of ioredis's `Redis` — just `publish`, so this module (and its tests)
 * don't need a real Redis client, matching the `Queryable` pattern `@railway/database` uses
 * for Postgres. */
export interface RedisPublisher {
  publish(channel: string, message: string): Promise<number>;
}

export interface ProjectMapDeltasOptions {
  batchSize?: number;
}

export interface ProjectMapDeltasSummary {
  batches: number;
  processedEvents: number;
  publishedDeltas: number;
}

interface TdBerthEventRow {
  id: string;
  ingestion_sequence: string;
  td_area: string;
  message_type: "CA" | "CB" | "CC";
  from_berth: string | null;
  to_berth: string | null;
  description: string | null;
  event_at: Date;
}

function computeConfigHash(): string {
  return createHash("sha256")
    .update(`map-delta-projection-v${MAP_DELTA_PROJECTION_VERSION}`)
    .digest("hex");
}

/**
 * Milestone 6's optional low-latency delta fan-out (docs/ARCHITECTURE.md §6's "map projector").
 * Reads `td_berth_event` — already-normalized TD output, itself checkpointed and idempotent
 * from the `td-berth-and-s-class` projection — strictly in `ingestion_sequence` order, and for
 * every changed berth, publishes a delta to `railway:live:{slug}` on Redis for every currently
 * published map version that binds it (a berth may appear on more than one map).
 *
 * Unlike the TD projector, this writes nothing durable to Postgres: its "output" is an ephemeral
 * broadcast, and `apps/api`'s WS layer always has a fresh DB-backed snapshot to fall back on
 * (via `resync.required` or simply reconnecting), so an occasional duplicate or dropped publish
 * after a crash between "publish" and "advance checkpoint" is an acceptable at-least-once
 * trade-off — never a source-of-truth correctness problem the way it would be for the TD
 * projector's own tables.
 */
export async function runProjectMapDeltas(
  pool: Pool,
  redis: RedisPublisher,
  options: ProjectMapDeltasOptions = {},
): Promise<ProjectMapDeltasSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const projectionDefinitionId = await getOrCreateProjectionDefinition(
    pool,
    MAP_DELTA_PROJECTION_NAME,
    MAP_DELTA_PROJECTION_VERSION,
    computeConfigHash(),
  );
  await ensureCheckpoint(pool, projectionDefinitionId);
  const checkpoint = await getCheckpoint(pool, projectionDefinitionId);
  let lastSequence = checkpoint?.lastIngestionSequence ?? "0";

  const summary: ProjectMapDeltasSummary = { batches: 0, processedEvents: 0, publishedDeltas: 0 };

  for (;;) {
    const result = await pool.query<TdBerthEventRow>(
      `select id, ingestion_sequence, td_area, message_type, from_berth, to_berth, description, event_at
       from td_berth_event
       where ingestion_sequence > $1
       order by ingestion_sequence
       limit $2`,
      [lastSequence, batchSize],
    );
    if (result.rows.length === 0) break;
    summary.batches += 1;

    for (const row of result.rows) {
      summary.processedEvents += 1;
      const changes = berthChangesForEvent({
        messageType: row.message_type,
        tdArea: row.td_area,
        fromBerth: row.from_berth,
        toBerth: row.to_berth,
        description: row.description ?? "",
        eventAt: row.event_at.toISOString(),
      });

      for (const change of changes) {
        const bindingsResult = await pool.query<MapBinding>(
          `select m.slug as "mapSlug", mbi.element_id as "elementId"
           from map_binding_index mbi
           join map_version mv on mv.id = mbi.map_version_id
           join map m on m.id = mv.map_id
           where mbi.binding_type = 'td_berth' and mbi.td_area = $1 and mbi.berth = $2
             and mv.effective_to is null`,
          [change.tdArea, change.berth],
        );
        if (bindingsResult.rows.length === 0) continue;

        const messages = buildDeltaMessages(
          change,
          bindingsResult.rows,
          Number(row.ingestion_sequence),
        );
        for (const { mapSlug, message } of messages) {
          await redis.publish(`railway:live:${mapSlug}`, JSON.stringify(message));
          summary.publishedDeltas += 1;
        }
      }

      lastSequence = row.ingestion_sequence;
    }

    await advanceCheckpoint(pool, projectionDefinitionId, lastSequence);
  }

  return summary;
}
