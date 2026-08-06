import { createPool } from "@railway/database";
import type { CompiledMapBundle } from "@railway/map-schema";
import { insertMapBindingIndexRows } from "@railway/map-publish";
import type { Config } from "../config.js";

/**
 * `backfill-map-bindings` — one-shot, idempotent. Migration 0010 added `map_binding_index`
 * after Milestone 5 had already published map versions (e.g. Lancaster), so those versions'
 * bindings only exist inside their stored `compiled_runtime_bundle` JSON. This command finds
 * every `map_version` with zero `map_binding_index` rows and populates them from that stored
 * bundle, using the exact same insert helper `publish-map` now calls automatically for new
 * versions. Safe to re-run: a version that already has bindings is skipped, and the insert
 * itself is `on conflict do nothing`.
 */
export async function runBackfillMapBindings(config: Config): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      const missing = await client.query<{ id: string; compiled_runtime_bundle: unknown }>(
        `select mv.id, mv.compiled_runtime_bundle
         from map_version mv
         left join map_binding_index mbi on mbi.map_version_id = mv.id
         where mbi.id is null
         group by mv.id, mv.compiled_runtime_bundle`,
      );

      if (missing.rows.length === 0) {
        console.log("backfill-map-bindings: every map_version already has bindings");
        return;
      }

      for (const row of missing.rows) {
        const bundle = row.compiled_runtime_bundle as CompiledMapBundle;
        await client.query("begin");
        try {
          await insertMapBindingIndexRows(client, row.id, bundle);
          await client.query("commit");
          console.log(`backfill-map-bindings: populated bindings for map_version ${row.id}`);
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
