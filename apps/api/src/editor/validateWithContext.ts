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
 * The "ever observed in nationwide data" check is a *warning*, not a blocking gate, and
 * `td_berth_event` is a partitioned nationwide table with no index on `from_berth`/`to_berth`
 * — an all-history `distinct` scan of it on every publish/validate grew slow enough on the live
 * recorder to time out the gateway. Bounding the look-back to this window keeps the query on
 * the existing `(td_area, event_at desc)` index and is a fine proxy for "is this a real,
 * live berth": one that belongs on a current map has had traffic recently.
 */
const OBSERVED_LOOKBACK_DAYS = 90;

/** Fail a pathological validation query in a bounded time with a clear error rather than
 * hanging until the gateway 504s. */
const VALIDATION_STATEMENT_TIMEOUT_MS = 20_000;

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
  const tdBerthBindings = doc.bindings.filter(
    (binding): binding is TdBerthBinding => binding.type === "tdBerth",
  );

  // Both DB checks run on one short-lived client with a statement timeout, so a slow scan of
  // the nationwide tables surfaces as a clear error in ~20s instead of hanging the request
  // until the gateway 504s.
  const observedKeys = new Set<string>();
  const existingSlugs = new Set<string>();
  if (boundaryElements.length > 0 || tdBerthBindings.length > 0) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set transaction read only");
      await client.query(`set local statement_timeout = ${VALIDATION_STATEMENT_TIMEOUT_MS}`);

      if (boundaryElements.length > 0) {
        const slugs = [...new Set(boundaryElements.map((element) => element.adjacentMapSlug!))];
        const existing = await client.query<{ slug: string }>(
          `select slug from map where slug = any($1::text[])`,
          [slugs],
        );
        for (const row of existing.rows) existingSlugs.add(row.slug);
      }

      if (tdBerthBindings.length > 0) {
        const areas = tdBerthBindings.map((binding) => binding.tdArea);
        const berths = tdBerthBindings.map((binding) => binding.berth);
        // Wanted-driven: for each of the handful of bindings, an EXISTS probe that the
        // `(td_area, event_at desc)` index serves and that short-circuits on the first hit —
        // instead of an all-history `distinct` scan of the whole table.
        const observedResult = await client.query<{ td_area: string; berth_code: string }>(
          `with wanted(td_area, berth_code) as (select * from unnest($1::text[], $2::text[]))
           select distinct w.td_area, w.berth_code
           from wanted w
           where exists (
             select 1 from td_berth_event e
             where e.td_area = w.td_area
               and e.event_at >= now() - ($3::int * interval '1 day')
               and (e.from_berth = w.berth_code or e.to_berth = w.berth_code)
           )`,
          [areas, berths, OBSERVED_LOOKBACK_DAYS],
        );
        for (const row of observedResult.rows) {
          observedKeys.add(`${row.td_area}|${row.berth_code}`);
        }
      }

      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  for (const element of boundaryElements) {
    if (!existingSlugs.has(element.adjacentMapSlug!)) {
      errors.push({
        code: "unknown_adjacent_map",
        message: `Boundary "${element.id}" references unknown adjacent map slug "${element.adjacentMapSlug}"`,
        elementId: element.id,
      });
    }
  }

  let observedCount = 0;
  for (const binding of tdBerthBindings) {
    const key = `${binding.tdArea}|${binding.berth}`;
    if (observedKeys.has(key)) {
      observedCount += 1;
    } else {
      warnings.push({
        code: "binding_never_observed",
        message: `Binding ${key} has not been seen in nationwide retained data in the last ${OBSERVED_LOOKBACK_DAYS} days`,
        bindingId: binding.id,
      });
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
