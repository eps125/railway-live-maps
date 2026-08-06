import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { TD_PROJECTION_VERSION } from "@railway/domain";

export interface EditorBindingDiagnosticsRoutesDeps {
  pool: Pool;
}

interface ObservedRow {
  first_observed_at: Date;
  last_observed_at: Date;
  event_count: string;
}

interface CurrentStateRow {
  description: string | null;
  occupancy_entered_at: Date | null;
}

/** `GET /api/v1/editor/bindings/td/{area}/{berth}/diagnostics` (docs/API_CONTRACT.md §4) —
 * backs the property panel's binding diagnostics/autocomplete
 * (docs/MAP_EDITOR_SPEC.md §9's informational tier: "last observed time per binding, current
 * value preview"). Reuses the same `td_berth_event` from/to-berth union
 * `routes/td.ts`'s berth-activity endpoint already queries. */
export async function registerEditorBindingDiagnosticsRoutes(
  app: FastifyInstance,
  deps: EditorBindingDiagnosticsRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get<{ Params: { area: string; berth: string } }>(
    "/api/v1/editor/bindings/td/:area/:berth/diagnostics",
    async (request) => {
      const { area, berth } = request.params;

      const [observed, currentState] = await Promise.all([
        pool.query<ObservedRow>(
          `select min(observed_at) as first_observed_at, max(observed_at) as last_observed_at,
                  count(*) as event_count
           from (
             select event_at as observed_at from td_berth_event where td_area = $1 and from_berth = $2
             union all
             select event_at as observed_at from td_berth_event where td_area = $1 and to_berth = $2
           ) observed`,
          [area, berth],
        ),
        pool.query<CurrentStateRow>(
          `select description, occupancy_entered_at from berth_current_state
           where projection_version = $1 and td_area = $2 and berth_code = $3`,
          [TD_PROJECTION_VERSION, area, berth],
        ),
      ]);

      const row = observed.rows[0];
      const everObserved = row?.first_observed_at != null;
      const current = currentState.rows[0];

      return {
        tdArea: area,
        berth,
        everObserved,
        firstObservedAt: row?.first_observed_at ? row.first_observed_at.toISOString() : null,
        lastObservedAt: row?.last_observed_at ? row.last_observed_at.toISOString() : null,
        eventCount: row ? Number(row.event_count) : 0,
        currentDescription: current?.description ?? null,
        currentEnteredAt: current?.occupancy_entered_at
          ? current.occupancy_entered_at.toISOString()
          : null,
      };
    },
  );
}
