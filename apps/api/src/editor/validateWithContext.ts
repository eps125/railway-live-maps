import type { Pool } from "pg";
import {
  validateMapDocument,
  type MapDocument,
  type ValidationIssue,
  type BoundaryElement,
  type TdBerthBinding,
} from "@railway/map-schema";

export interface ValidationTierResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  info: {
    elementCounts: Record<string, number>;
    boundBerthCount: number;
    unboundBerthCount: number;
    observedBerthBindingPercentage: number;
  };
}

/**
 * Extends `@railway/map-schema`'s pure `validateMapDocument` with the two checks its own
 * docstring names as deliberately out of scope for a DB-free package ("Cross-map
 * adjacent-boundary existence and 'ever observed in nationwide data' warnings need a DB
 * lookup... left for the publish/editor API layer once that context exists (Milestone
 * 11/12)"), plus the informational tier `docs/MAP_EDITOR_SPEC.md` §9 defines. Three tiers:
 * blocking errors (publication-blocking), warnings, informational diagnostics.
 */
export async function validateDraftInContext(
  pool: Pool,
  doc: MapDocument,
): Promise<ValidationTierResult> {
  const structural = validateMapDocument(doc);
  const errors: ValidationIssue[] = [...structural.errors];
  const warnings: ValidationIssue[] = [];

  const boundaryElements = doc.elements.filter(
    (element): element is BoundaryElement =>
      element.type === "boundary" && !!element.adjacentMapSlug,
  );
  if (boundaryElements.length > 0) {
    const slugs = [...new Set(boundaryElements.map((element) => element.adjacentMapSlug!))];
    const existing = await pool.query<{ slug: string }>(
      `select slug from map where slug = any($1::text[])`,
      [slugs],
    );
    const existingSlugs = new Set(existing.rows.map((row) => row.slug));
    for (const element of boundaryElements) {
      if (!existingSlugs.has(element.adjacentMapSlug!)) {
        errors.push({
          code: "unknown_adjacent_map",
          message: `Boundary "${element.id}" references unknown adjacent map slug "${element.adjacentMapSlug}"`,
          elementId: element.id,
        });
      }
    }
  }

  const tdBerthBindings = doc.bindings.filter(
    (binding): binding is TdBerthBinding => binding.type === "tdBerth",
  );
  let observedCount = 0;
  if (tdBerthBindings.length > 0) {
    const areas = tdBerthBindings.map((binding) => binding.tdArea);
    const berths = tdBerthBindings.map((binding) => binding.berth);
    const observedResult = await pool.query<{ td_area: string; berth_code: string }>(
      `select distinct td_area, berth_code from (
         select td_area, from_berth as berth_code from td_berth_event where from_berth is not null
         union all
         select td_area, to_berth as berth_code from td_berth_event where to_berth is not null
       ) observed
       join (select unnest($1::text[]) as td_area, unnest($2::text[]) as berth_code) wanted
         using (td_area, berth_code)`,
      [areas, berths],
    );
    const observedKeys = new Set(
      observedResult.rows.map((row) => `${row.td_area}|${row.berth_code}`),
    );
    for (const binding of tdBerthBindings) {
      const key = `${binding.tdArea}|${binding.berth}`;
      if (observedKeys.has(key)) {
        observedCount += 1;
      } else {
        warnings.push({
          code: "binding_never_observed",
          message: `Binding ${key} has never been observed in nationwide retained data`,
          bindingId: binding.id,
        });
      }
    }
  }

  const elementCounts: Record<string, number> = {};
  for (const element of doc.elements) {
    elementCounts[element.type] = (elementCounts[element.type] ?? 0) + 1;
  }
  const berthElements = doc.elements.filter((element) => element.type === "berth");
  // `doc.bindings` (matched by elementId) is authoritative, same as `validateMapDocument` and
  // the compiler — `element.bindingId` is a redundant back-reference that can drift stale.
  // Using it here previously produced the confusing "0 bound berths" alongside a
  // binding_never_observed warning for a binding that actually was attached to this element.
  const boundElementIds = new Set(doc.bindings.map((binding) => binding.elementId));
  const boundBerthCount = berthElements.filter((element) => boundElementIds.has(element.id)).length;
  const unboundBerthCount = berthElements.length - boundBerthCount;

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info: {
      elementCounts,
      boundBerthCount,
      unboundBerthCount,
      observedBerthBindingPercentage:
        tdBerthBindings.length > 0 ? Math.round((observedCount / tdBerthBindings.length) * 100) : 0,
    },
  };
}
