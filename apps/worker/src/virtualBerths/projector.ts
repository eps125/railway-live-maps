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
  headcodeFromTrustId,
  VIRTUAL_BERTH_PROJECTION_NAME,
  VIRTUAL_BERTH_PROJECTION_VERSION,
} from "@railway/domain";

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
}

const EMPTY_SUMMARY: VirtualBerthProjectorSummary = {
  batches: 0,
  processedRows: 0,
  gpsRows: 0,
  boundRows: 0,
  opened: 0,
  stepped: 0,
  terminated: 0,
};

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

async function closeOccupancy(
  client: PoolClient,
  trustId: string,
  stanox: string,
  at: Date,
  movementId: string,
  reason: "stepped_to_virtual" | "terminated",
): Promise<void> {
  // At most one row can match: the stepping decision only ever calls this for the exact
  // (trust_id, stanox) pair `findOpenStanoxForTrustId` just found open, and this projector's own
  // invariant (enforced by that lookup) is one open occupancy per trust_id at a time.
  await client.query(
    `update virtual_berth_occupancy
     set left_at = $3, exit_trust_movement_id = $4, exit_reason = $5
     where trust_id = $1 and stanox = $2 and left_at is null`,
    [trustId, stanox, at, movementId, reason],
  );
  await client.query(
    `update virtual_berth_current_state
     set trust_id = null, headcode = null, occupancy_id = null, occupancy_entered_at = null,
         event_at = $2, source_trust_movement_id = $3, updated_at = now()
     where stanox = $1 and trust_id is not distinct from $4`,
    [stanox, at, movementId, trustId],
  );
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
): Promise<void> {
  const { stanox, trustId, headcode, at, movementId, terminateImmediately } = params;
  const inserted = await client.query<{ id: string }>(
    `insert into virtual_berth_occupancy
       (projection_version, stanox, trust_id, headcode, entered_at, entry_trust_movement_id,
        left_at, exit_trust_movement_id, exit_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (entry_trust_movement_id) do nothing
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
}

async function processRow(
  client: PoolClient,
  row: TrustMovementRow,
  summary: VirtualBerthProjectorSummary,
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
    );
    summary.stepped += 1;
  }
  if (decision.openNew) {
    const headcode = headcodeFor(row.trust_id);
    await openOccupancy(client, {
      stanox: row.loc_stanox,
      trustId: row.trust_id,
      headcode,
      at: row.actual_timestamp,
      movementId: row.id,
      terminateImmediately: decision.terminateNew,
    });
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
  options: { batchSize?: number; rebuild?: boolean } = {},
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

    const batch = await pool.query<TrustMovementRow>(
      `select id::text as id, trust_id, loc_stanox, actual_timestamp, created, flags
       from trust_movement
       where id > $1
       order by id
       limit $2`,
      [lastId, batchSize],
    );
    if (batch.rows.length === 0) break;
    summary.batches += 1;
    summary.processedRows += batch.rows.length;

    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const row of batch.rows) {
        await processRow(client, row, summary);
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

    if (batch.rows.length < batchSize) break;
  }

  return summary;
}
