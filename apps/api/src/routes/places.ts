import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { apiError } from "../lib/queryRange.js";
import { GUEST_VIEWER, mapVisibilitySql } from "../lib/viewer.js";

export interface PlaceRoutesDeps {
  pool: Pool;
}

/** A typeahead-style search, not a paginated history feed — a small fixed cap is enough and
 * keeps the response snappy regardless of how broad `q` matches. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface PlaceSearchRow {
  tiploc: string | null;
  stanox: string | null;
  crs: string | null;
  name: string;
  /** Milestone 83: every visible map with this place, by map name; empty when none. */
  maps: { slug: string; name: string; elementId: string }[] | null;
}

function parseSearchLimit(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : DEFAULT_LIMIT;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

/**
 * Milestone 31 (docs/IMPLEMENTATION_PLAN.md): `GET /api/v1/places/search?q=` — public, no
 * session required (matches `GET /api/v1/maps`). Matches the query against `location_reference`
 * (CORPUS-sourced; nationwide, already ingested) by name/CRS/TIPLOC/STANOX, left-joined against
 * `map_place_index` restricted to each map's currently-effective version so a result carries
 * every map that covers it and the viewer may see (Milestone 83 — it used to carry only one). `location_reference` is a bounded reference table (CORPUS's
 * whole-network location list, not an ever-growing event stream), so the `ilike` scan here is not
 * the kind of unbounded query the project's standing rule (Milestone 15 step 6) is about.
 */
export async function registerPlaceRoutes(
  app: FastifyInstance,
  deps: PlaceRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get<{ Querystring: { q?: string; limit?: string } }>(
    "/api/v1/places/search",
    async (request, reply) => {
      const q = request.query.q?.trim();
      if (!q) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "q (non-empty string) is required");
      }
      const limit = parseSearchLimit(request.query.limit);

      const viewer = request.viewer ?? GUEST_VIEWER;
      const visible = mapVisibilitySql(viewer, "m", 3);

      // Milestone 83 (docs/adr/0018): a place may be on several maps — return all of them the
      // viewer may see, one entry per map (the first matching element on that map), by name.
      const result = await pool.query<PlaceSearchRow>(
        `with places as (
           select lr.id, lr.tiploc, lr.stanox, lr.crs, lr.name
             from location_reference lr
            where lr.name ilike $1 or lr.tiploc ilike $1 or lr.crs ilike $1 or lr.stanox ilike $1
            order by lr.name
            limit $2
         ),
         on_maps as (
           select distinct on (p.id, m.id)
                  p.id as place_id, m.slug, m.name, mpi.element_id
             from places p
             join map_place_index mpi
               on (p.tiploc is not null and mpi.tiploc = p.tiploc)
               or (p.crs is not null and mpi.crs = p.crs)
               or (p.stanox is not null and mpi.stanox = p.stanox)
             join map_version mv
               on mv.id = mpi.map_version_id
              and mv.effective_from <= now()
              and (mv.effective_to is null or mv.effective_to > now())
             join map m on m.id = mv.map_id
            where ${visible.sql}
            order by p.id, m.id, mpi.element_id
         )
         select p.tiploc, p.stanox, p.crs, p.name,
                (select json_agg(json_build_object('slug', om.slug, 'name', om.name,
                                                   'elementId', om.element_id)
                                 order by lower(om.name), om.slug)
                   from on_maps om where om.place_id = p.id) as maps
           from places p
          order by p.name`,
        [`%${q}%`, limit, ...visible.params],
      );

      return {
        results: result.rows.map((row) => ({
          tiploc: row.tiploc,
          stanox: row.stanox,
          crs: row.crs,
          name: row.name,
          maps: row.maps ?? [],
        })),
      };
    },
  );
}
