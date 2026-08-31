/** Structural subset of `pg`'s `Pool`/`PoolClient` — lets callers pass either, so a transactional
 * caller (e.g. the projector) can advance the checkpoint on the same client as its other writes. */
export interface Queryable {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Checkpoint {
  projectionDefinitionId: string;
  lastIngestionSequence: string;
  lastCompletedAt: Date | null;
  errorState: unknown;
}

interface CheckpointRow {
  projection_definition_id: string;
  last_ingestion_sequence: string;
  last_completed_at: Date | null;
  error_state: unknown;
}

function toCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    projectionDefinitionId: row.projection_definition_id,
    lastIngestionSequence: row.last_ingestion_sequence,
    lastCompletedAt: row.last_completed_at,
    errorState: row.error_state,
  };
}

/**
 * Scaffolding for the projection-checkpoint framework (docs/DATA_MODEL.md §10). No
 * projector calls this yet — that's Milestone 4. Registering the same name+codeVersion
 * twice is idempotent (config_hash is refreshed, id is stable).
 */
export async function getOrCreateProjectionDefinition(
  pool: Queryable,
  name: string,
  codeVersion: number,
  configHash: string,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into projection_definition (name, code_version, config_hash)
     values ($1, $2, $3)
     on conflict (name, code_version) do update set config_hash = excluded.config_hash
     returning id`,
    [name, codeVersion, configHash],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error("Failed to get or create projection_definition row");
  }
  return id;
}

/** Idempotent: creates a zeroed checkpoint row for this projection definition if none exists. */
export async function ensureCheckpoint(
  pool: Queryable,
  projectionDefinitionId: string,
): Promise<void> {
  await pool.query(
    `insert into projection_checkpoint (projection_definition_id)
     values ($1)
     on conflict (projection_definition_id) do nothing`,
    [projectionDefinitionId],
  );
}

export async function getCheckpoint(
  pool: Queryable,
  projectionDefinitionId: string,
): Promise<Checkpoint | undefined> {
  const result = await pool.query<CheckpointRow>(
    `select projection_definition_id, last_ingestion_sequence, last_completed_at, error_state
     from projection_checkpoint where projection_definition_id = $1`,
    [projectionDefinitionId],
  );
  const row = result.rows[0];
  return row ? toCheckpoint(row) : undefined;
}

/**
 * Records that a projection has processed forward to `lastIngestionSequence`. Monotonic: the
 * stored sequence only ever moves forward (`greatest(...)`). Every projector already computes its
 * next value from the checkpoint it just read, so in normal operation `greatest` is a no-op — but
 * it makes an out-of-order write a no-op instead of a rewind: a stale process from a redeploy
 * that already read an older checkpoint, or an operator manually seeding the checkpoint ahead
 * (both observed rewinding the resolver checkpoint by millions of rows in production on
 * 2026-08-31, re-triggering an oldest-first grind each time). `resetCheckpoint` is the only
 * sanctioned way to move a checkpoint backwards. `last_completed_at` still advances every call so
 * "a pass ran" stays observable even when the sequence didn't move.
 */
export async function advanceCheckpoint(
  pool: Queryable,
  projectionDefinitionId: string,
  lastIngestionSequence: string,
): Promise<void> {
  await pool.query(
    `update projection_checkpoint
     set last_ingestion_sequence = greatest(last_ingestion_sequence, $2::bigint),
         last_completed_at = now(), error_state = null, updated_at = now()
     where projection_definition_id = $1`,
    [projectionDefinitionId, lastIngestionSequence],
  );
}

/** Rewinds a projection's checkpoint back to zero so the next run reprocesses from the start —
 * the "rebuild" half of the projector checkpoint/rebuild command (docs/IMPLEMENTATION_PLAN.md
 * Milestone 4). Callers are responsible for clearing that projection's own output rows first. */
export async function resetCheckpoint(
  pool: Queryable,
  projectionDefinitionId: string,
): Promise<void> {
  await pool.query(
    `update projection_checkpoint
     set last_ingestion_sequence = 0, last_completed_at = null, error_state = null, updated_at = now()
     where projection_definition_id = $1`,
    [projectionDefinitionId],
  );
}
