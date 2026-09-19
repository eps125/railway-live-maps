import type { Pool, PoolClient } from "pg";
import {
  getOrCreateProjectionDefinition,
  ensureCheckpoint,
  getCheckpoint,
  advanceCheckpoint,
  resetCheckpoint,
} from "@railway/database";
import {
  decodeTrustMovementFlags,
  decideVirtualBerthStep,
  decideTdReentryHandoff,
  headcodeFromTrustId,
  VIRTUAL_BERTH_PROJECTION_NAME,
  VIRTUAL_BERTH_PROJECTION_VERSION,
  VIRTUAL_BERTH_TD_REENTRY_PROJECTION_NAME,
  VIRTUAL_BERTH_TD_REENTRY_PROJECTION_VERSION,
} from "@railway/domain";
import type { LiveDeltaMessage } from "@railway/protocol";

/**
 * `project-virtual-berths` (docs/adr/0012): steps virtual (GPS-fed) berth occupancy from TRUST
 * movement reports, mirroring `apps/worker/src/runLineage/projector.ts`'s checkpointed-batch
 * shape but reading `trust_movement` directly (already the garner mirror — nothing left to
 * parse) instead of `td_berth_event`.
 *
 * Checkpointed on `trust_movement.id` (RLM's own monotonic insert order — same reasoning
 * migration 0031's own comment gives for preferring `id` over `created`/`reported`: no garner
 * clock-skew concern, simpler, and just as sufficient), independent of every other checkpoint in
 * the system. Every row this daemon sees advances the checkpoint, whether or not it turns out to
 * be GPS-sourced or bound to a published virtual berth — those are just this pass's filters, not
 * a reason to re-visit the row later.
 *
 * Bounded per the Milestone 15 standing rule (every projector query carries an explicit bounded
 * range or reads a rollup): the per-row `loc_stanox` lookup against `map_binding_index` uses
 * `map_binding_index_virtual_berth_lookup_idx` (migration 0035), and a GPS report at a STANOX no
 * published map currently binds as a virtual berth is skipped outright — there is no "nationwide
 * virtual berth" concept independent of an authored binding (unlike TD, where the wire data
 * itself enumerates real physical berths regardless of any map; here the map binding *is* the
 * definition of a virtual berth, so scoping to bound STANOXes is correct, not a rule-17
 * violation).
 */
export const VIRTUAL_BERTH_CODE_VERSION = "virtual-berth-v1";

const DEFAULT_BATCH_SIZE = 500;

/** Structural subset of ioredis's `Redis` — just `publish`, matching the exact pattern
 * `apps/worker/src/mapProjector/projector.ts`'s own `RedisPublisher` uses. Optional everywhere
 * it's threaded through: nothing here requires Redis, this is purely the low-latency path. */
export interface RedisPublisher {
  publish(channel: string, message: string): Promise<number>;
}

interface TrustMovementRow {
  id: string;
  trust_id: string;
  loc_stanox: string | null;
  actual_timestamp: Date | null;
  created: Date;
  flags: number | null;
}

export interface VirtualBerthProjectorSummary {
  batches: number;
  processedRows: number;
  gpsRows: number;
  boundRows: number;
  opened: number;
  stepped: number;
  terminated: number;
  publishedDeltas: number;
}

const EMPTY_SUMMARY: VirtualBerthProjectorSummary = {
  batches: 0,
  processedRows: 0,
  gpsRows: 0,
  boundRows: 0,
  opened: 0,
  stepped: 0,
  terminated: 0,
  publishedDeltas: 0,
};

/** docs/adr/0012 gap closure: publishes a virtual-berth delta to every currently-published map
 * version's `railway:live:{slug}` channel that binds this STANOX — the same channel/shape
 * `apps/worker/src/mapProjector/projector.ts` (TD) already publishes to, so one WS subscriber
 * layer (`apps/api/src/live/redisDeltaSource.ts`) serves both with no changes of its own. Draws
 * `sequence` from the shared `live_delta_sequence` Postgres sequence — see that file's own
 * comment on why a locally-derived counter (e.g. `trust_movement.id`) would be unsafe here. */
async function publishVirtualBerthDelta(
  pool: Pool,
  redis: RedisPublisher,
  stanox: string,
  build: (elementId: string) => LiveDeltaMessage,
): Promise<number> {
  const bindings = await pool.query<{ mapSlug: string; elementId: string }>(
    `select m.slug as "mapSlug", mbi.element_id as "elementId"
     from map_binding_index mbi
     join map_version mv on mv.id = mbi.map_version_id
     join map m on m.id = mv.map_id
     where mbi.binding_type = 'virtual_berth' and mbi.stanox = $1 and mv.effective_to is null`,
    [stanox],
  );
  if (bindings.rows.length === 0) return 0;

  let published = 0;
  for (const { mapSlug, elementId } of bindings.rows) {
    const sequenceResult = await pool.query<{ seq: string }>(
      `select nextval('live_delta_sequence')::text as seq`,
    );
    const message = { ...build(elementId), sequence: Number(sequenceResult.rows[0]!.seq) };
    await redis.publish(`railway:live:${mapSlug}`, JSON.stringify(message));
    published += 1;
  }
  return published;
}

/** Whether any currently-published map version binds this STANOX as a virtual berth — see this
 * file's own doc comment for why that (not raw GPS presence) is the scope boundary. */
async function isVirtualBerthStanox(client: PoolClient, stanox: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `select exists(
       select 1 from map_binding_index
       where binding_type = 'virtual_berth' and stanox = $1
     ) as exists`,
    [stanox],
  );
  return rows[0]?.exists ?? false;
}

/** The STANOX this exact `trust_id` currently holds an open virtual-berth occupancy at, if any —
 * nationwide, not scoped to any one map, since the identity evidence (`trust_id`) is exact and
 * needs no chain/area scoping the way ADR 0007's TD step-chain inheritance does. */
async function findOpenStanoxForTrustId(
  client: PoolClient,
  trustId: string,
): Promise<{ stanox: string; enteredAt: Date } | null> {
  const { rows } = await client.query<{ stanox: string; entered_at: Date }>(
    `select stanox, entered_at from virtual_berth_occupancy
     where trust_id = $1 and left_at is null
     order by entered_at desc limit 1`,
    [trustId],
  );
  return rows[0] ? { stanox: rows[0].stanox, enteredAt: rows[0].entered_at } : null;
}

/** Display only (never a join key back — see `virtual_berth_occupancy.headcode`'s own migration
 * comment) — decoded straight from the `trust_id` itself (docs/adr/0010), no query needed. */
function headcodeFor(trustId: string): string | null {
  return headcodeFromTrustId(trustId);
}

/** One deferred Redis publish, queued during a batch's transaction and only actually sent after
 * that transaction commits — publishing state a transaction later rolls back would tell live
 * clients about a change that never really happened. */
interface PendingDelta {
  stanox: string;
  build: (elementId: string) => LiveDeltaMessage;
}

async function closeOccupancy(
  client: PoolClient,
  trustId: string,
  stanox: string,
  at: Date,
  movementId: string,
  reason: "stepped_to_virtual" | "terminated",
  pendingDeltas: PendingDelta[],
): Promise<void> {
  // At most one row can match: the stepping decision only ever calls this for the exact
  // (trust_id, stanox) pair `findOpenStanoxForTrustId` just found open, and this projector's own
  // invariant (enforced by that lookup) is one open occupancy per trust_id at a time.
  const result = await client.query(
    `update virtual_berth_occupancy
     set left_at = $3, exit_trust_movement_id = $4, exit_reason = $5
     where trust_id = $1 and stanox = $2 and left_at is null`,
    [trustId, stanox, at, movementId, reason],
  );
  if ((result.rowCount ?? 0) === 0) return; // redelivery — already applied, nothing to publish.
  await client.query(
    `update virtual_berth_current_state
     set trust_id = null, headcode = null, occupancy_id = null, occupancy_entered_at = null,
         event_at = $2, source_trust_movement_id = $3, updated_at = now()
     where stanox = $1 and trust_id is not distinct from $4`,
    [stanox, at, movementId, trustId],
  );
  pendingDeltas.push({
    stanox,
    build: (elementId) => ({
      type: "berth.cleared",
      sequence: 0, // overwritten with a real value from live_delta_sequence at publish time
      eventAt: at.toISOString(),
      elementId,
      stanox,
    }),
  });
}

async function openOccupancy(
  client: PoolClient,
  params: {
    stanox: string;
    trustId: string;
    headcode: string | null;
    at: Date;
    movementId: string;
    terminateImmediately: boolean;
  },
  pendingDeltas: PendingDelta[],
): Promise<void> {
  const { stanox, trustId, headcode, at, movementId, terminateImmediately } = params;
  const inserted = await client.query<{ id: string }>(
    `insert into virtual_berth_occupancy
       (projection_version, stanox, trust_id, headcode, entered_at, entry_trust_movement_id,
        left_at, exit_trust_movement_id, exit_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (entry_trust_movement_id, entered_at) do nothing
     returning id`,
    [
      VIRTUAL_BERTH_PROJECTION_VERSION,
      stanox,
      trustId,
      headcode,
      at,
      movementId,
      terminateImmediately ? at : null,
      terminateImmediately ? movementId : null,
      terminateImmediately ? "terminated" : null,
    ],
  );
  const occupancyId = inserted.rows[0]?.id;
  if (!occupancyId) return; // redelivery — already applied.

  await client.query(
    `insert into virtual_berth_current_state
       (projection_version, stanox, trust_id, headcode, occupancy_id, occupancy_entered_at,
        event_at, source_trust_movement_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (projection_version, stanox) do update set
       trust_id = excluded.trust_id,
       headcode = excluded.headcode,
       occupancy_id = excluded.occupancy_id,
       occupancy_entered_at = excluded.occupancy_entered_at,
       event_at = excluded.event_at,
       source_trust_movement_id = excluded.source_trust_movement_id,
       updated_at = now()
     where virtual_berth_current_state.event_at <= excluded.event_at`,
    [
      VIRTUAL_BERTH_PROJECTION_VERSION,
      stanox,
      terminateImmediately ? null : trustId,
      terminateImmediately ? null : headcode,
      terminateImmediately ? null : occupancyId,
      terminateImmediately ? null : at,
      at,
      movementId,
    ],
  );

  pendingDeltas.push({
    stanox,
    build: (elementId) =>
      terminateImmediately
        ? { type: "berth.cleared", sequence: 0, eventAt: at.toISOString(), elementId, stanox }
        : {
            type: "berth.updated",
            sequence: 0,
            eventAt: at.toISOString(),
            elementId,
            stanox,
            description: headcode ?? "",
            enteredAt: at.toISOString(),
          },
  });
}

async function processRow(
  client: PoolClient,
  row: TrustMovementRow,
  summary: VirtualBerthProjectorSummary,
  pendingDeltas: PendingDelta[],
): Promise<void> {
  if (!row.loc_stanox || !row.actual_timestamp) return;
  const flags = decodeTrustMovementFlags(row.flags);
  if (flags.originalDataSource !== "gps") return;
  summary.gpsRows += 1;

  const bound = await isVirtualBerthStanox(client, row.loc_stanox);
  if (!bound) return;
  summary.boundRows += 1;

  const existing = await findOpenStanoxForTrustId(client, row.trust_id);
  const decision = decideVirtualBerthStep({
    existingStanox: existing?.stanox ?? null,
    newStanox: row.loc_stanox,
    terminated: flags.terminated,
  });

  if (decision.closeExisting && existing) {
    await closeOccupancy(
      client,
      row.trust_id,
      existing.stanox,
      row.actual_timestamp,
      row.id,
      "stepped_to_virtual",
      pendingDeltas,
    );
    summary.stepped += 1;
  }
  if (decision.openNew) {
    const headcode = headcodeFor(row.trust_id);
    await openOccupancy(
      client,
      {
        stanox: row.loc_stanox,
        trustId: row.trust_id,
        headcode,
        at: row.actual_timestamp,
        movementId: row.id,
        terminateImmediately: decision.terminateNew,
      },
      pendingDeltas,
    );
    if (decision.terminateNew) summary.terminated += 1;
    else if (!decision.closeExisting && !existing) summary.opened += 1;
  }
}

/** Deletes this projection version's own output rows — the "clear" half of `--rebuild`, mirroring
 * `apps/worker/src/td/projector.ts`'s `clearProjectionRows`. `virtual_berth_current_state` first
 * (nothing FKs into it), then `virtual_berth_occupancy`. */
async function clearVirtualBerthProjectionRows(pool: Pool): Promise<void> {
  await pool.query(`delete from virtual_berth_current_state where projection_version = $1`, [
    VIRTUAL_BERTH_PROJECTION_VERSION,
  ]);
  await pool.query(`delete from virtual_berth_occupancy where projection_version = $1`, [
    VIRTUAL_BERTH_PROJECTION_VERSION,
  ]);
}

export async function runProjectVirtualBerths(
  pool: Pool,
  options: { batchSize?: number; rebuild?: boolean; redis?: RedisPublisher | undefined } = {},
): Promise<VirtualBerthProjectorSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const definitionId = await getOrCreateProjectionDefinition(
    pool,
    VIRTUAL_BERTH_PROJECTION_NAME,
    VIRTUAL_BERTH_PROJECTION_VERSION,
    VIRTUAL_BERTH_CODE_VERSION,
  );
  await ensureCheckpoint(pool, definitionId);

  if (options.rebuild) {
    await clearVirtualBerthProjectionRows(pool);
    await resetCheckpoint(pool, definitionId);
  }

  const summary: VirtualBerthProjectorSummary = { ...EMPTY_SUMMARY };

  for (;;) {
    const checkpoint = await getCheckpoint(pool, definitionId);
    const lastId = checkpoint?.lastIngestionSequence ?? "0";

    // `order by trust_movement.id`, never bare `order by id`: an ORDER BY name binds to the output
    // alias first, so it would sort by the `id::text` alias — lexicographic order ("10000000" <
    // "9999999") that jumps the checkpoint past unprocessed rows, and a seq-scan + sort of the
    // whole table instead of a primary-key range scan (timed out every tick in production).
    const batch = await pool.query<TrustMovementRow>(
      `select id::text as id, trust_id, loc_stanox, actual_timestamp, created, flags
       from trust_movement
       where id > $1
       order by trust_movement.id
       limit $2`,
      [lastId, batchSize],
    );
    if (batch.rows.length === 0) break;
    summary.batches += 1;
    summary.processedRows += batch.rows.length;

    const pendingDeltas: PendingDelta[] = [];
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const row of batch.rows) {
        await processRow(client, row, summary, pendingDeltas);
      }
      const maxId = batch.rows.reduce(
        (max, r) => (BigInt(r.id) > max ? BigInt(r.id) : max),
        BigInt(lastId),
      );
      await advanceCheckpoint(client, definitionId, maxId.toString());
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    // Only after a successful commit — see `PendingDelta`'s own doc comment.
    if (options.redis) {
      for (const { stanox, build } of pendingDeltas) {
        summary.publishedDeltas += await publishVirtualBerthDelta(
          pool,
          options.redis,
          stanox,
          build,
        );
      }
    }

    if (batch.rows.length < batchSize) break;
  }

  return summary;
}

// ---------------------------------------------------------------------------------------------
// TD-reentry hand-off (docs/adr/0012 gap closure, owner request 2026-09-19)
// ---------------------------------------------------------------------------------------------

export const VIRTUAL_BERTH_TD_REENTRY_CODE_VERSION = "virtual-berth-td-reentry-v1";
const TD_REENTRY_DEFAULT_BATCH_SIZE = 500;

/** How far back a virtual occupancy's `entered_at` may be and still plausibly be the same run
 * reappearing on TD — generous (a remote, uncovered section can take a real while to cross), but
 * bounded: it's what keeps the per-row headcode lookup an index seek against
 * `virtual_berth_occupancy_headcode_open_idx` rather than a scan, and it's the actual
 * corroboration signal alongside "exactly one candidate" (see `decideTdReentryHandoff`'s own doc
 * comment) — not just a performance bound. */
const TD_REENTRY_PLAUSIBLE_WINDOW_HOURS = 3;

interface TdBerthEventRow {
  ingestion_sequence: string;
  message_type: "CA" | "CC";
  description: string | null;
  event_at: Date;
}

export interface TdReentrySummary {
  batches: number;
  processedEvents: number;
  handoffs: number;
  publishedDeltas: number;
}

const EMPTY_TD_REENTRY_SUMMARY: TdReentrySummary = {
  batches: 0,
  processedEvents: 0,
  handoffs: 0,
  publishedDeltas: 0,
};

async function anyOpenVirtualOccupancy(pool: Pool): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `select exists(select 1 from virtual_berth_occupancy where left_at is null) as exists`,
  );
  return rows[0]?.exists ?? false;
}

/**
 * `project-virtual-berths-daemon`'s second pass (also runnable standalone/one-shot): watches
 * nationwide `td_berth_event` `CA`/`CC` rows for a headcode that corroborates exactly one
 * currently-open virtual berth occupancy, and closes it — the "train re-entered TD coverage"
 * hand-off docs/adr/0012 originally deferred. Its own checkpoint (`VIRTUAL_BERTH_TD_REENTRY_*`),
 * completely independent of the GPS-driven pass above, since it reads a different event stream
 * (`td_berth_event.ingestion_sequence`, not `trust_movement.id`).
 *
 * Deliberately conservative, mirroring ADR 0007's TD-area boundary corroboration principle
 * (never headcode alone, never guess when more than one candidate is plausible): a TD event only
 * triggers a hand-off when exactly one open virtual occupancy shares its headcode within the
 * plausible window; zero or more than one candidate leaves every occupancy untouched
 * (`decideTdReentryHandoff`). Does **not** establish any run-lineage link for the newly-opened TD
 * occupancy — only the virtual berth's own display is cleared, so a later click on the TD berth
 * still resolves identity exactly as ADR 0006/0007 already do, independent of this hand-off.
 */
export async function runVirtualBerthTdReentryHandoff(
  pool: Pool,
  options: { batchSize?: number; rebuild?: boolean; redis?: RedisPublisher | undefined } = {},
): Promise<TdReentrySummary> {
  const batchSize = options.batchSize ?? TD_REENTRY_DEFAULT_BATCH_SIZE;
  const definitionId = await getOrCreateProjectionDefinition(
    pool,
    VIRTUAL_BERTH_TD_REENTRY_PROJECTION_NAME,
    VIRTUAL_BERTH_TD_REENTRY_PROJECTION_VERSION,
    VIRTUAL_BERTH_TD_REENTRY_CODE_VERSION,
  );
  await ensureCheckpoint(pool, definitionId);
  if (options.rebuild) {
    // No output rows of its own to clear — every write lands in virtual_berth_occupancy/
    // virtual_berth_current_state, which the GPS-driven pass's own --rebuild already clears.
    await resetCheckpoint(pool, definitionId);
  }

  const summary: TdReentrySummary = { ...EMPTY_TD_REENTRY_SUMMARY };

  for (;;) {
    const checkpoint = await getCheckpoint(pool, definitionId);
    const lastSequence = checkpoint?.lastIngestionSequence ?? "0";

    const batch = await pool.query<TdBerthEventRow>(
      `select ingestion_sequence, message_type, description, event_at
       from td_berth_event
       where ingestion_sequence > $1 and message_type in ('CA', 'CC') and description is not null
       order by ingestion_sequence
       limit $2`,
      [lastSequence, batchSize],
    );
    if (batch.rows.length === 0) break;
    summary.batches += 1;
    summary.processedEvents += batch.rows.length;

    const maxSequence = batch.rows.reduce(
      (max, r) => (BigInt(r.ingestion_sequence) > max ? BigInt(r.ingestion_sequence) : max),
      BigInt(lastSequence),
    );

    // Cheap short-circuit: skip every per-row headcode lookup when nothing is currently open —
    // the overwhelming common case, and the reason this whole pass stays bounded regardless of
    // nationwide TD volume (Milestone 15 standing rule).
    if (!(await anyOpenVirtualOccupancy(pool))) {
      await advanceCheckpoint(pool, definitionId, maxSequence.toString());
      if (batch.rows.length < batchSize) break;
      continue;
    }

    const pendingDeltas: PendingDelta[] = [];
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const row of batch.rows) {
        if (!row.description) continue;
        const notBefore = new Date(
          row.event_at.getTime() - TD_REENTRY_PLAUSIBLE_WINDOW_HOURS * 60 * 60 * 1000,
        );
        const { rows: candidates } = await client.query<{ id: string; stanox: string }>(
          `select id, stanox from virtual_berth_occupancy
           where headcode = $1 and left_at is null and entered_at >= $2`,
          [row.description, notBefore],
        );
        if (!decideTdReentryHandoff(candidates.length).handoff) continue;
        const candidate = candidates[0]!;

        const result = await client.query(
          `update virtual_berth_occupancy set left_at = $2, exit_reason = 'stepped_to_td'
           where id = $1 and left_at is null`,
          [candidate.id, row.event_at],
        );
        if ((result.rowCount ?? 0) === 0) continue; // redelivery/race — already closed.
        await client.query(
          `update virtual_berth_current_state
           set trust_id = null, headcode = null, occupancy_id = null, occupancy_entered_at = null,
               event_at = $2, updated_at = now()
           where stanox = $1 and occupancy_id = $3`,
          [candidate.stanox, row.event_at, candidate.id],
        );
        summary.handoffs += 1;
        const stanox = candidate.stanox;
        pendingDeltas.push({
          stanox,
          build: (elementId) => ({
            type: "berth.cleared",
            sequence: 0,
            eventAt: row.event_at.toISOString(),
            elementId,
            stanox,
          }),
        });
      }
      await advanceCheckpoint(client, definitionId, maxSequence.toString());
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    if (options.redis) {
      for (const { stanox, build } of pendingDeltas) {
        summary.publishedDeltas += await publishVirtualBerthDelta(
          pool,
          options.redis,
          stanox,
          build,
        );
      }
    }

    if (batch.rows.length < batchSize) break;
  }

  return summary;
}
