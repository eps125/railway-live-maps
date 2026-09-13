import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { apiError } from "../../lib/queryRange.js";

export interface TdBoundaryRoutesDeps {
  pool: Pool;
}

interface TdBoundaryRow {
  id: string;
  area_a: string;
  berth_a: string;
  area_b: string;
  berth_b: string;
  notes: string | null;
  created_by: string;
  created_at: Date;
}

function boundaryResponse(row: TdBoundaryRow) {
  return {
    id: row.id,
    areaA: row.area_a,
    berthA: row.berth_a,
    areaB: row.area_b,
    berthB: row.berth_b,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

interface CreateBoundaryBody {
  areaA?: unknown;
  berthA?: unknown;
  areaB?: unknown;
  berthB?: unknown;
  notes?: unknown;
}

/**
 * Milestone 39 (docs/adr/0007): admin-only management of `td_area_boundary` — owner-curated
 * reference data the `run-lineage-daemon` uses to correlate a run across a TD-area crossing.
 * Deliberately never auto-derived or auto-applied from SMART; this is the only way rows get in.
 * Registered under a scope gated by `requireRole("admin", ...)` in `server.ts`, same pattern as
 * `registerAdminUserRoutes`.
 */
export async function registerTdBoundaryRoutes(
  app: FastifyInstance,
  deps: TdBoundaryRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get("/api/v1/admin/td-boundaries", async () => {
    const result = await pool.query<TdBoundaryRow>(
      `select id, area_a, berth_a, area_b, berth_b, notes, created_by, created_at
       from td_area_boundary order by area_a, berth_a`,
    );
    return { boundaries: result.rows.map(boundaryResponse) };
  });

  app.post<{ Body: CreateBoundaryBody }>("/api/v1/admin/td-boundaries", async (request, reply) => {
    const { areaA, berthA, areaB, berthB, notes } = request.body ?? {};
    for (const [name, value] of [
      ["areaA", areaA],
      ["berthA", berthA],
      ["areaB", areaB],
      ["berthB", berthB],
    ] as const) {
      if (typeof value !== "string" || !value.trim()) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", `${name} (non-empty string) is required`);
      }
    }
    if (notes !== undefined && notes !== null && typeof notes !== "string") {
      reply.code(400);
      return apiError("VALIDATION_ERROR", "notes must be a string when provided");
    }

    const createdBy = request.authSession?.username ?? "unknown";
    try {
      const result = await pool.query<TdBoundaryRow>(
        `insert into td_area_boundary (area_a, berth_a, area_b, berth_b, notes, created_by)
           values ($1, $2, $3, $4, $5, $6)
           returning id, area_a, berth_a, area_b, berth_b, notes, created_by, created_at`,
        [areaA, berthA, areaB, berthB, notes ?? null, createdBy],
      );
      reply.code(201);
      return boundaryResponse(result.rows[0]!);
    } catch (error) {
      // unique (area_a, berth_a, area_b, berth_b)
      if (
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "23505"
      ) {
        reply.code(409);
        return apiError("DUPLICATE_BOUNDARY", "That boundary pair is already recorded");
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/td-boundaries/:id",
    async (request, reply) => {
      const result = await pool.query(`delete from td_area_boundary where id = $1`, [
        request.params.id,
      ]);
      if (result.rowCount === 0) {
        reply.code(404);
        return apiError("BOUNDARY_NOT_FOUND", `No boundary with id "${request.params.id}"`);
      }
      reply.code(204);
    },
  );
}
