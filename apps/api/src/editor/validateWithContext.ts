import type { Pool, PoolClient, QueryResultRow } from "pg";
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
 * The "ever observed in nationwide data" check is a *warning*, not a blocking gate. Bounding the
 * look-back to this window is a fine proxy for "is this a real, live berth": one that belongs on
 * a current map has had traffic within the last month.
 *
 * 2026-09-11: this check used to query `td_berth_event` — a partitioned nationwide table with no
 * index on `from_berth`/`to_berth` (every raw CA/CB/CC step, including cancels and null-marker
 * steps) — running one `from_berth = ? or to_berth = ?` correlated EXISTS probe per binding on
 * the map. Without an index on either column that scan fell back to reading every matching row
 * in the relevant partition(s), repeated once per berth, which was slow enough on the live
 * recorder to hit `OBSERVED_CHECK_TIMEOUT_MS` on essentially every validate/publish — so the
 * check was *always* skipped in practice, not just under genuine load. Switched to
 * `berth_occupancy` instead: it already carries a matching index
 * (`berth_occupancy_area_berth_idx (td_area, berth_code, entered_at desc)`, migration 0008), one
 * row per real occupancy interval (not every raw step), and no `from`/`to` split to OR across —
 * a single `(td_area, berth_code)` equality prefix plus an `entered_at` range on that same index,
 * an index seek rather than a scan. It's also arguably the more honest signal for what this
 * check actually claims ("has a real train genuinely occupied this berth recently") than a raw
 * step log that can include a cancel on a berth that was never really occupied.
 */
const OBSERVED_LOOKBACK_DAYS = 30;

/** Per-check statement timeouts. If a check can't complete in this budget its result is simply
 * dropped (best-effort) — a slow *advisory* query must never block or fail a publish. */
const BOUNDARY_CHECK_TIMEOUT_MS = 5_000;
const OBSERVED_CHECK_TIMEOUT_MS = 8_000;

/**
 * Runs one read-only query on its own short-lived transaction with a `statement_timeout`, and
 * returns `null` (rather than throwing) on any failure — timeout, aborted transaction, no
 * connection available. Callers treat `null` as "this context check couldn't run" and degrade
 * gracefully; they never turn it into a blocking error.
 */
async function bestEffortQuery<T extends QueryResultRow>(
  pool: Pool,
  sql: string,
  params: unknown[],
  timeoutMs: number,
): Promise<T[] | null> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return null;
  }
  try {
    await client.query("begin");
    await client.query("set transaction read only");
    await client.query(`set local statement_timeout = ${timeoutMs}`);
    const result = await client.query<T>(sql, params);
    await client.query("commit");
    return result.rows;
  } catch {
    await client.query("rollback").catch(() => undefined);
    return null;
  } finally {
    client.release();
  }
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
  const tdBerthBindings = doc.bindings.filter(
    (binding): binding is TdBerthBinding => binding.type === "tdBerth",
  );

  // Both DB checks are advisory and best-effort: each runs with its own statement timeout and,
  // on any failure, is simply dropped with a "check skipped" warning. Neither can block or 500
  // a publish — a slow scan of the nationwide tables used to do both.
  let boundaryCheckOk = boundaryElements.length === 0;
  let observedCheckOk = tdBerthBindings.length === 0;
  const observedKeys = new Set<string>();
  const existingSlugs = new Set<string>();

  if (boundaryElements.length > 0) {
    const slugs = [...new Set(boundaryElements.map((element) => element.adjacentMapSlug!))];
    const rows = await bestEffortQuery<{ slug: string }>(
      pool,
      `select slug from map where slug = any($1::text[])`,
      [slugs],
      BOUNDARY_CHECK_TIMEOUT_MS,
    );
    if (rows !== null) {
      boundaryCheckOk = true;
      for (const row of rows) existingSlugs.add(row.slug);
    }
  }

  if (tdBerthBindings.length > 0) {
    const areas = tdBerthBindings.map((binding) => binding.tdArea);
    const berths = tdBerthBindings.map((binding) => binding.berth);
    // Wanted-driven: for each of the handful of bindings, an EXISTS probe against
    // `berth_occupancy_area_berth_idx (td_area, berth_code, entered_at desc)` — an index seek,
    // not a scan (see OBSERVED_LOOKBACK_DAYS's doc comment for why this reads berth_occupancy
    // rather than td_berth_event).
    const rows = await bestEffortQuery<{ td_area: string; berth_code: string }>(
      pool,
      `with wanted(td_area, berth_code) as (select * from unnest($1::text[], $2::text[]))
       select distinct w.td_area, w.berth_code
       from wanted w
       where exists (
         select 1 from berth_occupancy o
         where o.td_area = w.td_area
           and o.berth_code = w.berth_code
           and o.entered_at >= now() - ($3::int * interval '1 day')
       )`,
      [areas, berths, OBSERVED_LOOKBACK_DAYS],
      OBSERVED_CHECK_TIMEOUT_MS,
    );
    if (rows !== null) {
      observedCheckOk = true;
      for (const row of rows) observedKeys.add(`${row.td_area}|${row.berth_code}`);
    }
  }

  // The unknown-adjacent-map *error* is only raised when the check actually ran — a DB that was
  // too slow to answer must never block a publish.
  if (boundaryCheckOk) {
    for (const element of boundaryElements) {
      if (!existingSlugs.has(element.adjacentMapSlug!)) {
        errors.push({
          code: "unknown_adjacent_map",
          message: `Boundary "${element.id}" references unknown adjacent map slug "${element.adjacentMapSlug}"`,
          elementId: element.id,
        });
      }
    }
  } else {
    warnings.push({
      code: "adjacent_map_check_skipped",
      message:
        "Adjacent-map existence check was skipped (database slow or unavailable) — verify any adjacent map slugs manually.",
    });
  }

  let observedCount = 0;
  if (observedCheckOk) {
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
  } else {
    warnings.push({
      code: "observed_binding_check_skipped",
      message:
        "The nationwide 'berth seen recently' check was skipped (query too slow) — binding coverage not verified.",
    });
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
