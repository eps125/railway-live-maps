import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { apiError } from "../lib/queryRange.js";

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
  map_slug: string | null;
  element_id: string | null;
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
 * whichever map (if any) covers it. `location_reference` is a bounded reference table (CORPUS's
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

      const result = await pool.query<PlaceSearchRow>(
        `select lr.tiploc, lr.stanox, lr.crs, lr.name,
                (array_agg(m.slug) filter (where m.slug is not null))[1] as map_slug,
                (array_agg(mpi.element_id) filter (where m.slug is not null))[1] as element_id
           from location_reference lr
           left join map_place_index mpi
             on (lr.tiploc is not null and mpi.tiploc = lr.tiploc)
             or (lr.crs is not null and mpi.crs = lr.crs)
             or (lr.stanox is not null and mpi.stanox = lr.stanox)
           left join map_version mv
             on mv.id = mpi.map_version_id
            and mv.effective_from <= now()
            and (mv.effective_to is null or mv.effective_to > now())
           left join map m on m.id = mv.map_id
          where lr.name ilike $1 or lr.tiploc ilike $1 or lr.crs ilike $1 or lr.stanox ilike $1
          group by lr.id, lr.tiploc, lr.stanox, lr.crs, lr.name
          order by lr.name
          limit $2`,
        [`%${q}%`, limit],
      );

      return {
        results: result.rows.map((row) => ({
          tiploc: row.tiploc,
          stanox: row.stanox,
          crs: row.crs,
          name: row.name,
          mapSlug: row.map_slug,
          elementId: row.element_id,
        })),
      };
    },
  );
}
