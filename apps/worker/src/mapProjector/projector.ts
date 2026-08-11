import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  getOrCreateProjectionDefinition,
  ensureCheckpoint,
  getCheckpoint,
  advanceCheckpoint,
} from "@railway/database";
import {
  MAP_DELTA_PROJECTION_NAME,
  MAP_DELTA_PROJECTION_VERSION,
  TD_PROJECTION_VERSION,
  extractMovementReport,
  runningIndicationText,
} from "@railway/domain";
import {
  berthChangesForEvent,
  buildDeltaMessages,
  buildRunResolutionDeltaMessages,
  type MapBinding,
} from "./deltaBuilder.js";

export { MAP_DELTA_PROJECTION_NAME, MAP_DELTA_PROJECTION_VERSION };

const DEFAULT_BATCH_SIZE = 500;
/** How far back publishResolutionDeltas looks for recently-decided resolutions, every
 * invocation. Deliberately not checkpointed (unlike the td_berth_event scan above): resolver
 * rows are upserted in place (`on conflict (occupancy_id) do update`), so a monotonic
 * id/sequence checkpoint would miss a *re*-decision of an already-seen occupancy — exactly the
 * continuity/retry-driven corrections this exists to broadcast. A generous time window re-scanned
 * every ~1s loop cycle (deploy/docker-compose.portainer.yml's map-deltas service) costs some
 * redundant republishing instead, which is fine: this whole layer is already an at-least-once,
 * idempotent-to-the-client broadcast (see runProjectMapDeltas's own doc comment). */
const RESOLUTION_LOOKBACK_MS = 10_000;

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

  await publishResolutionDeltas(pool, redis, summary, BigInt(lastSequence));

  return summary;
}

interface ResolutionChangeRow {
  td_area: string;
  berth_code: string;
  status: "matched" | "ambiguous" | "unmatched";
  selected_train_run_id: string | null;
  decided_at: Date;
}

/**
 * Publishes run.resolution.updated for every resolution decided in the last
 * RESOLUTION_LOOKBACK_MS that's still the *current* occupancy of its berth — a resolution for an
 * occupancy the train has already stepped away from is stale and skipped (the berth.cleared/
 * berth.updated that already fired for the next step supersedes it). See RESOLUTION_LOOKBACK_MS's
 * doc comment for why this scans by time instead of a checkpoint.
 *
 * `sequence` starts from the td_berth_event scan's own final sequence (already >= anything this
 * process has published this invocation) and increments per message, so these interleave safely
 * with berth.updated/cleared on the same Redis channel without ever going backwards — a decrease
 * would make the client think it missed something and force a reconnect (docs/API_CONTRACT.md
 * §2), which a merely-out-of-order-feeling resolution update must never trigger.
 */
async function publishResolutionDeltas(
  pool: Pool,
  redis: RedisPublisher,
  summary: ProjectMapDeltasSummary,
  startingSequence: bigint,
): Promise<void> {
  const cutoff = new Date(Date.now() - RESOLUTION_LOOKBACK_MS);
  const changed = await pool.query<ResolutionChangeRow>(
    `select bo.td_area, bo.berth_code, brr.status, brr.selected_train_run_id, brr.decided_at
     from berth_run_resolution brr
     join berth_occupancy bo on bo.id = brr.occupancy_id
     join berth_current_state bcs
       on bcs.td_area = bo.td_area and bcs.berth_code = bo.berth_code
       and bcs.projection_version = $1 and bcs.occupancy_id = brr.occupancy_id
     where brr.decided_at > $2`,
    [TD_PROJECTION_VERSION, cutoff],
  );
  if (changed.rows.length === 0) return;

  const runIds = [
    ...new Set(
      changed.rows
        .map((row) => row.selected_train_run_id)
        .filter((id): id is string => id !== null),
    ),
  ];
  const reportByRunId = new Map<string, ReturnType<typeof extractMovementReport>>();
  if (runIds.length > 0) {
    const events = await pool.query<{ train_run_id: string; raw_event_json: unknown }>(
      `select distinct on (train_run_id) train_run_id, raw_event_json
       from train_run_event
       where train_run_id = any($1::uuid[]) and trust_message_type = 'movement'
       order by train_run_id, event_at desc`,
      [runIds],
    );
    for (const row of events.rows) {
      reportByRunId.set(row.train_run_id, extractMovementReport(row.raw_event_json));
    }
  }

  let sequence = startingSequence;
  for (const row of changed.rows) {
    const bindingsResult = await pool.query<MapBinding>(
      `select m.slug as "mapSlug", mbi.element_id as "elementId"
       from map_binding_index mbi
       join map_version mv on mv.id = mbi.map_version_id
       join map m on m.id = mv.map_id
       where mbi.binding_type = 'td_berth' and mbi.td_area = $1 and mbi.berth = $2
         and mv.effective_to is null`,
      [row.td_area, row.berth_code],
    );
    if (bindingsResult.rows.length === 0) continue;

    const report = row.selected_train_run_id
      ? reportByRunId.get(row.selected_train_run_id)
      : undefined;
    sequence += 1n;
    const messages = buildRunResolutionDeltaMessages(
      row.decided_at.toISOString(),
      {
        status: row.status,
        text: report ? runningIndicationText(report) : null,
        trainRunId: row.selected_train_run_id,
      },
      bindingsResult.rows,
      Number(sequence),
    );
    for (const { mapSlug, message } of messages) {
      await redis.publish(`railway:live:${mapSlug}`, JSON.stringify(message));
      summary.publishedDeltas += 1;
    }
  }
}
