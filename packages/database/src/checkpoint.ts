import type { Pool } from "pg";

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
  pool: Pool,
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
export async function ensureCheckpoint(pool: Pool, projectionDefinitionId: string): Promise<void> {
  await pool.query(
    `insert into projection_checkpoint (projection_definition_id)
     values ($1)
     on conflict (projection_definition_id) do nothing`,
    [projectionDefinitionId],
  );
}

export async function getCheckpoint(
  pool: Pool,
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

export async function advanceCheckpoint(
  pool: Pool,
  projectionDefinitionId: string,
  lastIngestionSequence: string,
): Promise<void> {
  await pool.query(
    `update projection_checkpoint
     set last_ingestion_sequence = $2, last_completed_at = now(), error_state = null, updated_at = now()
     where projection_definition_id = $1`,
    [projectionDefinitionId, lastIngestionSequence],
  );
}
