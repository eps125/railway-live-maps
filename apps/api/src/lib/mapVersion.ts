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

/** 2026-09-26: a published version's document and compiled bundle, parsed, by version id. Published
 * versions are immutable (CLAUDE.md rule 11), so an entry can never go stale. Every `/state`,
 * `/live`, `/definition` request used to read and parse both (~300 KB and more for Carlisle) —
 * CPU on the API's single thread that queued editor saves and publishes behind it. Small LRU:
 * a handful of maps, and a publish supersedes the entry naturally with a new id. */
const VERSION_CACHE_LIMIT = 16;
const versionContent = new Map<
  string,
  { canonical_document: MapDocument; compiled_runtime_bundle: CompiledMapBundle }
>();

/** Test-only: forget cached version content. */
export function clearMapVersionCache(): void {
  versionContent.clear();
}

/** Resolves the published map_version effective at `at` for a slug. Shared by `/definition`,
 * `/state`, `/live`, and the Milestone 11/12 editor (draft-seeding, diff) — every read of
 * "current published map" goes through this one query. The large document and bundle come from
 * the immutable-version cache when present. */
export async function currentVersionForSlug(
  pool: Pool,
  slug: string,
  at: Date,
): Promise<MapVersionRow | undefined> {
  const result = await pool.query<
    Omit<MapVersionRow, "canonical_document" | "compiled_runtime_bundle">
  >(
    `select mv.id, mv.map_id, m.slug, m.name, mv.version_number, mv.effective_from, mv.effective_to
     from map_version mv
     join map m on m.id = mv.map_id
     where m.slug = $1 and mv.effective_from <= $2 and (mv.effective_to is null or mv.effective_to > $2)
     order by mv.effective_from desc
     limit 1`,
    [slug, at],
  );
  const row = result.rows[0];
  if (!row) return undefined;

  let content = versionContent.get(row.id);
  if (content) {
    // Refresh its place in the LRU.
    versionContent.delete(row.id);
  } else {
    const loaded = await pool.query<{
      canonical_document: MapDocument;
      compiled_runtime_bundle: CompiledMapBundle;
    }>(
      `select mv.canonical_document, mv.compiled_runtime_bundle from map_version mv where mv.id = $1`,
      [row.id],
    );
    content = loaded.rows[0];
    if (!content) return undefined;
  }
  versionContent.set(row.id, content);
  while (versionContent.size > VERSION_CACHE_LIMIT) {
    versionContent.delete(versionContent.keys().next().value!);
  }
  return { ...row, ...content };
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

/**
 * Confirmed in production (2026-08-09): NR's `CT` heartbeat message is not a reliable per-area
 * "still alive" ping — two genuinely busy areas (Preston `PX`, Carlisle `CL`) went 4-5+ hours
 * without one while `td_berth_event` for the same two areas stayed seconds-fresh the entire
 * time (real CA/CB/CC step traffic never stopped). Relying on `td_heartbeat` alone made the
 * live-status banner permanently claim "stale" for a map that was, in fact, live — so real berth
 * activity counts as freshness evidence too, not just the dedicated heartbeat message type.
 */

/**
 * How far back `liveDataStatus`'s main query looks for the most recent event before falling back
 * to the `everObserved` existence check below. Almost every real, currently-mapped area has *some*
 * event within a day, so this bound covers the common case in one cheap, index-friendly query;
 * the rare "genuinely nothing in the last day" case still gets the right answer, just via one
 * extra query (see below).
 *
 * Bounding this query is not optional: without it (production incident, 2026-09-13), `= any(text[])`
 * defeats Postgres's usual "index scan for MAX" rewrite (that optimization only applies to a
 * single equality, not a multi-value array), so an unbounded `max(event_at) where td_area =
 * any($1)` scans every historical row ever recorded for that area — months of nationwide capture
 * — instead of stopping at the newest one. Milestone 30's landing page was the first thing to ever
 * call `GET /api/v1/maps` from a live browser (nothing did before); a few page reloads were enough
 * to stack up several of these multi-minute scans and exhaust the API's whole 10-connection
 * Postgres pool, taking every other route down with 10s connection-acquire timeouts. Bounding the
 * range here also lets Postgres prune `td_berth_event`'s monthly partitions outright, matching the
 * project's standing rule (docs/IMPLEMENTATION_PLAN.md Milestone 15 step 6): every
 * projector/bridge query carries an explicit bounded range or reads a rollup, never an unbounded
 * scan of a table that grows without limit.
 */
const LIVE_STATUS_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export async function liveDataStatus(
  pool: Pool,
  tdAreas: string[],
  now: Date,
): Promise<"ok" | "stale" | "unknown"> {
  if (tdAreas.length === 0) return "unknown";
  const since = new Date(now.getTime() - LIVE_STATUS_LOOKBACK_MS);
  const result = await pool.query<{ last_activity_at: Date | null }>(
    `select greatest(
       (select max(event_at) from td_heartbeat where td_area = any($1::text[]) and event_at >= $2),
       (select max(event_at) from td_berth_event where td_area = any($1::text[]) and event_at >= $2)
     ) as last_activity_at`,
    [tdAreas, since],
  );
  const lastActivityAt = result.rows[0]?.last_activity_at;
  if (lastActivityAt) {
    return now.getTime() - lastActivityAt.getTime() <= FRESHNESS_THRESHOLD_MS ? "ok" : "stale";
  }

  // Nothing in the last day — could be a genuinely never-observed area ("unknown") or one that
  // really has gone quiet for over a day ("stale", not "unknown": it was mapped and has real
  // history, just not recently). `exists(...)` short-circuits at the first matching row per the
  // same `(td_area, event_at desc)` index, so this stays cheap regardless of table size — unlike
  // `max()`, an existence check doesn't need Postgres's single-equality MIN/MAX rewrite to avoid
  // scanning every row.
  const everObserved = await pool.query<{ observed: boolean }>(
    `select
       exists(select 1 from td_heartbeat where td_area = any($1::text[]))
       or exists(select 1 from td_berth_event where td_area = any($1::text[])) as observed`,
    [tdAreas],
  );
  return everObserved.rows[0]?.observed ? "stale" : "unknown";
}
