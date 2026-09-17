import type { Pool } from "pg";
import { TD_PROJECTION_VERSION, joinCombinedBerthState } from "@railway/domain";
import type { CombinedBerthOverrides } from "./deltaBuilder.js";

export interface DeltaMapBinding {
  mapVersionId: string;
  mapSlug: string;
  elementId: string;
}

/**
 * Owner request 2026-09-17: for every (map, element) a just-changed berth binds to, checks
 * whether that element is a combined berth (docs/MAP_EDITOR_SPEC.md's berth section — more than
 * one `tdBerth` binding sharing the element, up to 4, for a split-berth permissive-working
 * group). If so, looks up every member's current `berth_current_state` (the row for the berth
 * that just changed is already durably written by the time this runs — both callers upsert
 * before publishing) and returns the joined `{description, enteredAt}` to override in the
 * outgoing delta, so a change to any one member always republishes the group's full combined
 * text. An ordinary (non-combined) binding costs one small indexed lookup on
 * `map_binding_index (map_version_id, element_id)` and is otherwise untouched — `buildDeltaMessages`
 * derives its state from the raw change directly.
 */
export async function computeCombinedOverrides(
  pool: Pool,
  bindings: DeltaMapBinding[],
): Promise<CombinedBerthOverrides> {
  const overrides: CombinedBerthOverrides = new Map();

  for (const { mapVersionId, mapSlug, elementId } of bindings) {
    const { rows: memberRows } = await pool.query<{
      td_area: string;
      berth: string;
      combined_order: number | null;
    }>(
      `select td_area, berth, combined_order
       from map_binding_index
       where map_version_id = $1 and element_id = $2 and binding_type = 'td_berth'`,
      [mapVersionId, elementId],
    );
    if (memberRows.length <= 1) continue; // not a combined berth

    const { rows: stateRows } = await pool.query<{
      td_area: string;
      berth_code: string;
      description: string | null;
      occupancy_entered_at: Date | null;
    }>(
      `select bcs.td_area, bcs.berth_code, bcs.description, bcs.occupancy_entered_at
       from berth_current_state bcs
       join (select unnest($1::text[]) as td_area, unnest($2::text[]) as berth_code) wanted
         on wanted.td_area = bcs.td_area and wanted.berth_code = bcs.berth_code
       where bcs.projection_version = $3`,
      [memberRows.map((m) => m.td_area), memberRows.map((m) => m.berth), TD_PROJECTION_VERSION],
    );
    const stateByKey = new Map(stateRows.map((r) => [`${r.td_area}|${r.berth_code}`, r]));

    const joined = joinCombinedBerthState(
      memberRows.map((member) => {
        const state = stateByKey.get(`${member.td_area}|${member.berth}`);
        return {
          tdArea: member.td_area,
          berth: member.berth,
          order: member.combined_order ?? 1,
          description: state?.description ?? null,
          enteredAt: state?.occupancy_entered_at ? state.occupancy_entered_at.toISOString() : null,
        };
      }),
    );
    overrides.set(`${mapSlug}|${elementId}`, joined);
  }

  return overrides;
}
