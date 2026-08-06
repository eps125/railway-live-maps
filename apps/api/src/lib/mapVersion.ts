import type { Pool } from "pg";
import type { CompiledMapBundle, MapDocument } from "@railway/map-schema";

/** MVP freshness window for the "live-data status" summary and /state's/live's quality flag.
 * Not yet wired to configuration (docs/ARCHITECTURE.md §9 lists "freshness thresholds" as a
 * setting to add later) — a fixed, documented constant is the smallest coherent implementation
 * for now. Shared by `routes/maps.ts` and `routes/liveMap.ts` so both report quality the same way. */
export const FRESHNESS_THRESHOLD_MS = 90_000;

export interface MapVersionRow {
  id: string;
  map_id: string;
  slug: string;
  name: string;
  version_number: number;
  canonical_document: MapDocument;
  compiled_runtime_bundle: CompiledMapBundle;
  effective_from: Date;
  effective_to: Date | null;
}

/** Resolves the published map_version effective at `at` for a slug. Shared by `/definition`,
 * `/state`, `/live`, and the Milestone 11/12 editor (draft-seeding, diff) — every read of
 * "current published map" goes through this one query. */
export async function currentVersionForSlug(
  pool: Pool,
  slug: string,
  at: Date,
): Promise<MapVersionRow | undefined> {
  const result = await pool.query<MapVersionRow>(
    `select mv.id, mv.map_id, m.slug, m.name, mv.version_number, mv.canonical_document,
            mv.compiled_runtime_bundle, mv.effective_from, mv.effective_to
     from map_version mv
     join map m on m.id = mv.map_id
     where m.slug = $1 and mv.effective_from <= $2 and (mv.effective_to is null or mv.effective_to > $2)
     order by mv.effective_from desc
     limit 1`,
    [slug, at],
  );
  return result.rows[0];
}

export function tdAreasFromBundle(bundle: CompiledMapBundle): string[] {
  const areas = new Set<string>();
  // Defensive: every real compiled bundle (compileMapDocument's output) always has this field,
  // but a placeholder/malformed bundle should degrade to "no known areas" rather than 500 the
  // whole /maps listing for every other map too.
  for (const key of Object.keys(bundle.berthBindingIndex ?? {})) {
    const area = key.split("|")[0];
    if (area) areas.add(area);
  }
  return [...areas];
}

export async function liveDataStatus(
  pool: Pool,
  tdAreas: string[],
  now: Date,
): Promise<"ok" | "stale" | "unknown"> {
  if (tdAreas.length === 0) return "unknown";
  const result = await pool.query<{ last_heartbeat_at: Date }>(
    `select max(event_at) as last_heartbeat_at from td_heartbeat where td_area = any($1::text[])`,
    [tdAreas],
  );
  const lastHeartbeatAt = result.rows[0]?.last_heartbeat_at;
  if (!lastHeartbeatAt) return "unknown";
  return now.getTime() - lastHeartbeatAt.getTime() <= FRESHNESS_THRESHOLD_MS ? "ok" : "stale";
}
