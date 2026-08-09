import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  getOrCreateProjectionDefinition,
  ensureCheckpoint,
  getCheckpoint,
  advanceCheckpoint,
  resetCheckpoint,
} from "@railway/database";
import {
  applyCA,
  applyCB,
  applyCC,
  TD_NORMALIZATION_VERSION,
  TD_PROJECTION_NAME,
  TD_PROJECTION_VERSION,
  type OpenOccupancySnapshot,
  type BerthEffect,
} from "@railway/domain";

export { TD_PROJECTION_NAME, TD_PROJECTION_VERSION };

const DEFAULT_BATCH_SIZE = 500;

export interface ProjectTdOptions {
  batchSize?: number;
  /** Clears this projection version's output (including the td_berth_event/td_heartbeat/
   * td_s_event normalized mirrors, which aren't independently versioned) and reprocesses from
   * ingestion_sequence 0. */
  rebuild?: boolean;
}

export interface ProjectTdSummary {
  batches: number;
  processedEvents: number;
  projectedBerthEvents: number;
  heartbeats: number;
  sEvents: number;
  anomalies: number;
  /** True when this invocation did nothing because another runProjectTd was already in
   * progress (see the advisory lock note on runProjectTd below) — not an error, just "try
   * again next tick." */
  skippedLockContention: boolean;
}

const EMPTY_SUMMARY: ProjectTdSummary = {
  batches: 0,
  processedEvents: 0,
  projectedBerthEvents: 0,
  heartbeats: 0,
  sEvents: 0,
  anomalies: 0,
  skippedLockContention: false,
};

interface RawTdRow {
  id: string;
  normalized_event_at_utc: Date;
  ingestion_sequence: string;
  event_type: string;
  message_class: "C" | "S" | null;
  td_area: string;
  raw_event_json: Record<string, unknown>;
  parse_status: string;
}

function computeConfigHash(): string {
  return createHash("sha256")
    .update(`td-projection-v${TD_PROJECTION_VERSION}-norm-v${TD_NORMALIZATION_VERSION}`)
    .digest("hex");
}

/** Postgres advisory lock keys are signed 64-bit integers — any well-distributed 64 bits works,
 * so this just takes the first 8 bytes of a hash of a fixed name rather than picking an
 * arbitrary literal that'd be easy to accidentally collide with some other lock elsewhere. */
export function advisoryLockKey(name: string): bigint {
  return createHash("sha256").update(`td-projector-lock:${name}`).digest().readBigInt64BE(0);
}

async function clearProjectionRows(pool: Pool, projectionVersion: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Child-before-parent for the FKs into berth_occupancy: berth_current_state and
    // berth_run_resolution (Milestone 9's resolver) are pure derived state, safe to delete
    // outright; operator_berth_action (the manual berth-clear audit trail) is a permanent record
    // that must survive a rebuild, so its now-dangling occupancy reference is nulled out instead
    // of the row being deleted — without handling this first, the delete below fails with a
    // foreign key violation the instant any occupancy has ever been resolved or manually cleared,
    // which in practice is "always" in a real deployment.
    await client.query("delete from td_projection_anomaly where projection_version = $1", [
      projectionVersion,
    ]);
    await client.query("delete from berth_current_state where projection_version = $1", [
      projectionVersion,
    ]);
    await client.query(
      `delete from berth_run_resolution
       where occupancy_id in (select id from berth_occupancy where projection_version = $1)`,
      [projectionVersion],
    );
    await client.query(
      `update operator_berth_action set closed_occupancy_id = null, closed_occupancy_entered_at = null
       where closed_occupancy_id in (select id from berth_occupancy where projection_version = $1)`,
      [projectionVersion],
    );
    await client.query("delete from berth_occupancy where projection_version = $1", [
      projectionVersion,
    ]);
    await client.query("delete from td_s_current_state where projection_version = $1", [
      projectionVersion,
    ]);
    await client.query("delete from td_s_bit_transition where projection_version = $1", [
      projectionVersion,
    ]);
    // These three are plain 1:1 normalized mirrors of raw_feed_event with no projection_version
    // column of their own — they're cheap to regenerate and must be cleared too, otherwise their
    // (raw_event_id, event_at) idempotency guard would make every row look "already projected"
    // and rebuild would silently do nothing.
    await client.query("delete from td_berth_event");
    await client.query("delete from td_heartbeat");
    await client.query("delete from td_s_event");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function getOpenOccupancy(
  client: PoolClient,
  projectionVersion: number,
  tdArea: string,
  berthCode: string,
): Promise<OpenOccupancySnapshot | null> {
  const result = await client.query<{
    occupancy_id: string | null;
    occupancy_entered_at: Date | null;
    description: string | null;
  }>(
    `select occupancy_id, occupancy_entered_at, description
     from berth_current_state
     where projection_version = $1 and td_area = $2 and berth_code = $3`,
    [projectionVersion, tdArea, berthCode],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.occupancy_id === null ||
    row.occupancy_entered_at === null ||
    row.description === null
  ) {
    return null;
  }
  return {
    occupancyId: row.occupancy_id,
    description: row.description,
    enteredAt: row.occupancy_entered_at.toISOString(),
  };
}

interface EffectContext {
  projectionVersion: number;
  tdArea: string;
  fromBerth: string | undefined;
  toBerth: string | undefined;
  eventAt: Date;
  rawEventId: string;
  rawEventNormalizedAtUtc: Date;
  ingestionSequence: string;
}

async function applyEffects(
  client: PoolClient,
  effects: BerthEffect[],
  ctx: EffectContext,
): Promise<{ anomalies: number }> {
  let anomalies = 0;

  for (const effect of effects) {
    if (effect.kind === "closeOccupancy") {
      const berthCode = effect.berth === "from" ? ctx.fromBerth : ctx.toBerth;
      if (!berthCode) {
        throw new Error(`closeOccupancy effect is missing its ${effect.berth} berth code`);
      }
      await client.query(
        `update berth_occupancy
         set left_at = $2, exit_event_id = $3, exit_event_normalized_at_utc = $4, exit_reason = $5
         where id = $1`,
        [
          effect.occupancyId,
          ctx.eventAt,
          ctx.rawEventId,
          ctx.rawEventNormalizedAtUtc,
          effect.exitReason,
        ],
      );
      await client.query(
        `update berth_current_state
         set description = null, occupancy_id = null, occupancy_entered_at = null,
             event_at = $4, source_event_id = $5, source_event_normalized_at_utc = $6,
             source_ingestion_sequence = $7, updated_at = now()
         where projection_version = $1 and td_area = $2 and berth_code = $3`,
        [
          ctx.projectionVersion,
          ctx.tdArea,
          berthCode,
          ctx.eventAt,
          ctx.rawEventId,
          ctx.rawEventNormalizedAtUtc,
          ctx.ingestionSequence,
        ],
      );
    } else if (effect.kind === "openOccupancy") {
      const berthCode = ctx.toBerth;
      if (!berthCode) {
        throw new Error("openOccupancy effect is missing the to berth code");
      }
      const inserted = await client.query<{ id: string }>(
        `insert into berth_occupancy (
           projection_version, td_area, berth_code, description, entered_at,
           entry_event_id, entry_event_normalized_at_utc, entry_reason
         ) values ($1,$2,$3,$4,$5,$6,$7,$8)
         returning id`,
        [
          ctx.projectionVersion,
          ctx.tdArea,
          berthCode,
          effect.description,
          ctx.eventAt,
          ctx.rawEventId,
          ctx.rawEventNormalizedAtUtc,
          effect.entryReason,
        ],
      );
      const occupancyId = inserted.rows[0]?.id;
      if (!occupancyId) {
        throw new Error("Expected berth_occupancy insert to return an id");
      }
      await client.query(
        `insert into berth_current_state (
           projection_version, td_area, berth_code, description, occupancy_id, occupancy_entered_at,
           event_at, source_event_id, source_event_normalized_at_utc, source_ingestion_sequence
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         on conflict (projection_version, td_area, berth_code) do update
         set description = excluded.description, occupancy_id = excluded.occupancy_id,
             occupancy_entered_at = excluded.occupancy_entered_at, event_at = excluded.event_at,
             source_event_id = excluded.source_event_id,
             source_event_normalized_at_utc = excluded.source_event_normalized_at_utc,
             source_ingestion_sequence = excluded.source_ingestion_sequence, updated_at = now()`,
        [
          ctx.projectionVersion,
          ctx.tdArea,
          berthCode,
          effect.description,
          occupancyId,
          ctx.eventAt,
          ctx.eventAt,
          ctx.rawEventId,
          ctx.rawEventNormalizedAtUtc,
          ctx.ingestionSequence,
        ],
      );
    } else {
      anomalies += 1;
      const berthCode =
        effect.berth === "from"
          ? (ctx.fromBerth ?? null)
          : effect.berth === "to"
            ? (ctx.toBerth ?? null)
            : null;
      await client.query(
        `insert into td_projection_anomaly (
           projection_version, td_area, berth_code, raw_event_id, raw_event_normalized_at_utc,
           anomaly_code, details, event_at, ingestion_sequence
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          ctx.projectionVersion,
          ctx.tdArea,
          berthCode,
          ctx.rawEventId,
          ctx.rawEventNormalizedAtUtc,
          effect.anomalyCode,
          JSON.stringify(effect.details),
          ctx.eventAt,
          ctx.ingestionSequence,
        ],
      );
    }
  }

  return { anomalies };
}

function unwrapPayload(row: RawTdRow, wrapperKey: string): Record<string, unknown> | undefined {
  const value = row.raw_event_json[wrapperKey];
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

async function projectCClassRow(
  client: PoolClient,
  row: RawTdRow,
  summary: ProjectTdSummary,
): Promise<void> {
  if (row.event_type === "CT") {
    await client.query(
      `insert into td_heartbeat (raw_event_id, raw_event_normalized_at_utc, td_area, report_time, event_at, received_at)
       values ($1,$2,$3,$4,$5, now())
       on conflict (raw_event_id) do nothing`,
      [
        row.id,
        row.normalized_event_at_utc,
        row.td_area,
        row.normalized_event_at_utc,
        row.normalized_event_at_utc,
      ],
    );
    summary.heartbeats += 1;
    return;
  }

  if (row.event_type !== "CA" && row.event_type !== "CB" && row.event_type !== "CC") {
    // message_class 'C' rows are only ever CA/CB/CC/CT per packages/feed-parsers' classifier.
    return;
  }

  const payload = unwrapPayload(row, `${row.event_type}_MSG`);
  const description = String(payload?.descr);
  const fromBerth = row.event_type !== "CC" ? String(payload?.from) : undefined;
  const toBerth = row.event_type !== "CB" ? String(payload?.to) : undefined;

  const inserted = await client.query<{ id: string }>(
    `insert into td_berth_event (
       raw_event_id, raw_event_normalized_at_utc, td_area, message_type, from_berth, to_berth,
       description, event_at, ingestion_sequence, normalization_version
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (raw_event_id, event_at) do nothing
     returning id`,
    [
      row.id,
      row.normalized_event_at_utc,
      row.td_area,
      row.event_type,
      fromBerth ?? null,
      toBerth ?? null,
      description,
      row.normalized_event_at_utc,
      row.ingestion_sequence,
      TD_NORMALIZATION_VERSION,
    ],
  );
  // No returned row = this raw event was already projected in an earlier run — the effects were
  // already applied, so applying them again would double-count. This is what makes restart/replay
  // and broker/fixture redelivery safe.
  if (inserted.rows.length === 0) {
    return;
  }
  summary.projectedBerthEvents += 1;

  const ctx: EffectContext = {
    projectionVersion: TD_PROJECTION_VERSION,
    tdArea: row.td_area,
    fromBerth,
    toBerth,
    eventAt: row.normalized_event_at_utc,
    rawEventId: row.id,
    rawEventNormalizedAtUtc: row.normalized_event_at_utc,
    ingestionSequence: row.ingestion_sequence,
  };

  let effects: BerthEffect[];
  if (row.event_type === "CA") {
    const fromOpen = await getOpenOccupancy(client, ctx.projectionVersion, ctx.tdArea, fromBerth!);
    const toOpen = await getOpenOccupancy(client, ctx.projectionVersion, ctx.tdArea, toBerth!);
    effects = applyCA({
      fromBerth: fromBerth!,
      toBerth: toBerth!,
      description,
      fromOpen,
      toOpen,
    }).effects;
  } else if (row.event_type === "CB") {
    const fromOpen = await getOpenOccupancy(client, ctx.projectionVersion, ctx.tdArea, fromBerth!);
    effects = applyCB({ fromBerth: fromBerth!, description, fromOpen }).effects;
  } else {
    const toOpen = await getOpenOccupancy(client, ctx.projectionVersion, ctx.tdArea, toBerth!);
    effects = applyCC({ toBerth: toBerth!, description, toOpen }).effects;
  }

  const { anomalies } = await applyEffects(client, effects, ctx);
  summary.anomalies += anomalies;
}

async function projectSClassRow(
  client: PoolClient,
  row: RawTdRow,
  summary: ProjectTdSummary,
): Promise<void> {
  const payload = unwrapPayload(row, row.event_type);
  const address = typeof payload?.address === "string" ? payload.address : null;
  const rawValue =
    typeof payload?.data === "string" ? payload.data : payload ? JSON.stringify(payload) : null;
  // There's no verified S-Class bit-decode spec/fixture in this repo yet (see docs/DATA_MODEL.md
  // §5) — data is retained raw, never decoded/fabricated. When no `address` field is supplied,
  // the message type is used as a grouping key of last resort so current-state tracking still
  // functions per area — this never invents a value, it only picks a stable partition key.
  const currentStateKey = address ?? row.event_type;

  const inserted = await client.query<{ id: string }>(
    `insert into td_s_event (
       raw_event_id, raw_event_normalized_at_utc, td_area, message_type, address, raw_value,
       decoded_bitset, event_at, ingestion_sequence, normalization_version, decode_status
     ) values ($1,$2,$3,$4,$5,$6,null,$7,$8,$9,'raw_only')
     on conflict (raw_event_id, event_at) do nothing
     returning id`,
    [
      row.id,
      row.normalized_event_at_utc,
      row.td_area,
      row.event_type,
      address,
      rawValue,
      row.normalized_event_at_utc,
      row.ingestion_sequence,
      TD_NORMALIZATION_VERSION,
    ],
  );
  if (inserted.rows.length === 0) {
    return;
  }
  summary.sEvents += 1;

  const dataQualityState = "ok"; // genuinely known-at-write-time state; see td_s_current_state comment in the migration.

  await client.query(
    `insert into td_s_current_state (
       projection_version, td_area, address, raw_value, decoded_bitset, event_at,
       source_event_id, source_event_normalized_at_utc, source_ingestion_sequence, decode_status,
       data_quality_state
     ) values ($1,$2,$3,$4,null,$5,$6,$7,$8,'raw_only',$9)
     on conflict (projection_version, td_area, address) do update
     set raw_value = excluded.raw_value, event_at = excluded.event_at,
         source_event_id = excluded.source_event_id,
         source_event_normalized_at_utc = excluded.source_event_normalized_at_utc,
         source_ingestion_sequence = excluded.source_ingestion_sequence,
         data_quality_state = excluded.data_quality_state, updated_at = now()`,
    [
      TD_PROJECTION_VERSION,
      row.td_area,
      currentStateKey,
      rawValue,
      row.normalized_event_at_utc,
      row.id,
      row.normalized_event_at_utc,
      row.ingestion_sequence,
      dataQualityState,
    ],
  );
}

/**
 * Turns nationwide raw TD events into current-state/history projections
 * (docs/IMPLEMENTATION_PLAN.md Milestone 4). Processes strictly in `ingestion_sequence` order —
 * not `event_at` — which is what makes equal-timestamp events deterministic. Each batch commits
 * in one transaction together with its checkpoint advance, so a crash mid-run only ever loses an
 * uncommitted batch, never produces partial/duplicate projection state.
 *
 * Holds a Postgres advisory lock for its entire run (released even on error/crash — it's tied to
 * the session, not explicitly tracked state). `getCheckpoint`/`advanceCheckpoint` have no locking
 * of their own: two concurrent runs (the continuous `projector` service's loop racing a manual
 * `project-td` console command, for example) would both read the same checkpoint and both fetch
 * the same batch before either commits. Each event is individually idempotent
 * (`on conflict (raw_event_id, event_at) do nothing`), so no event is ever double-applied — but a
 * `closeOccupancy` effect is only emitted when the reducer sees a non-null `fromOpen` snapshot,
 * and two interleaved transactions can each read the *other's* not-yet-committed prior effect,
 * so one of them computes against stale state and silently emits no closing effect at all. That
 * leaves a berth showing occupied forever, with no error anywhere to indicate it happened. The
 * lock makes that interleaving impossible: a second concurrent invocation fails to acquire it and
 * returns immediately rather than racing.
 */
export async function runProjectTd(
  pool: Pool,
  options: ProjectTdOptions = {},
): Promise<ProjectTdSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const lockKey = advisoryLockKey(TD_PROJECTION_NAME);
  const lockClient = await pool.connect();
  try {
    const lockResult = await lockClient.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1) as locked",
      [lockKey],
    );
    if (!lockResult.rows[0]?.locked) {
      return { ...EMPTY_SUMMARY, skippedLockContention: true };
    }

    const definitionId = await getOrCreateProjectionDefinition(
      pool,
      TD_PROJECTION_NAME,
      TD_PROJECTION_VERSION,
      computeConfigHash(),
    );
    await ensureCheckpoint(pool, definitionId);

    if (options.rebuild) {
      await clearProjectionRows(pool, TD_PROJECTION_VERSION);
      await resetCheckpoint(pool, definitionId);
    }

    const summary: ProjectTdSummary = { ...EMPTY_SUMMARY };

    for (;;) {
      const checkpoint = await getCheckpoint(pool, definitionId);
      const lastSequence = checkpoint?.lastIngestionSequence ?? "0";

      const batch = await pool.query<RawTdRow>(
        `select id, normalized_event_at_utc, ingestion_sequence, event_type, message_class, td_area,
                raw_event_json, parse_status
         from raw_feed_event
         where feed_name = 'TD' and ingestion_sequence > $1
         order by ingestion_sequence
         limit $2`,
        [lastSequence, batchSize],
      );
      if (batch.rows.length === 0) {
        break;
      }
      summary.batches += 1;

      const client = await pool.connect();
      try {
        await client.query("begin");
        let maxSequence = BigInt(lastSequence);

        for (const row of batch.rows) {
          summary.processedEvents += 1;
          const rowSequence = BigInt(row.ingestion_sequence);
          if (rowSequence > maxSequence) {
            maxSequence = rowSequence;
          }

          if (row.parse_status !== "parsed") {
            continue;
          }
          if (row.message_class === "C") {
            await projectCClassRow(client, row, summary);
          } else if (row.message_class === "S") {
            await projectSClassRow(client, row, summary);
          }
        }

        await advanceCheckpoint(client, definitionId, maxSequence.toString());
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }

    return summary;
  } finally {
    await lockClient.query("select pg_advisory_unlock($1)", [lockKey]).catch(() => {});
    lockClient.release();
  }
}
