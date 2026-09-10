import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { MapDocument } from "@railway/map-schema";
import { validateDraftInContext } from "./validateWithContext.js";

type QueryHandler = (text: string, values?: unknown[]) => { rows: unknown[] };

function fakePool(handler: QueryHandler): Pool {
  const query = async (text: string, values?: unknown[]) => {
    // Transaction / session-setting statements the scoped-client wrapper issues are no-ops here.
    if (/^\s*(begin|commit|rollback|set )/i.test(text)) return { rows: [] };
    return handler(text, values);
  };
  const client = { query, release: () => undefined };
  return { query, connect: async () => client } as unknown as Pool;
}

function baseDoc(overrides: Partial<MapDocument> = {}): MapDocument {
  return {
    schemaVersion: 1,
    map: {
      id: "test",
      name: "Test",
      canvas: { width: 100, height: 100, gridSize: 10 },
      timezone: "Europe/London",
    },
    layers: [{ id: "l1", name: "Track", visible: true, locked: false, order: 0 }],
    elements: [],
    topology: { nodes: [], edges: [] },
    bindings: [],
    editorMetadata: {},
    ...overrides,
  } as MapDocument;
}

describe("validateDraftInContext bound/unbound berth counts", () => {
  it("counts a berth as bound from doc.bindings even when element.bindingId is stale or unset", async () => {
    // Regression test: the compiler builds the published berth-binding index from
    // binding.elementId alone (packages/map-schema/src/compiler.ts) — never from
    // element.bindingId. A real editor bug once left element.bindingId out of sync with
    // doc.bindings, which made a genuinely-bound berth report as "0 bound" here while
    // simultaneously showing a binding_never_observed warning for the same binding.
    const doc = baseDoc({
      elements: [
        {
          id: "berth-1",
          layerId: "l1",
          zIndex: 0,
          type: "berth",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          textAlign: "center",
          fontSize: 12,
          displayName: "1008",
          // No bindingId set on the element at all.
        },
      ],
      bindings: [
        {
          id: "bind-1",
          elementId: "berth-1",
          type: "tdBerth",
          tdArea: "PX",
          berth: "1008",
          allowDuplicate: false,
        },
      ],
    });

    const pool = fakePool((text) => {
      if (text.includes("from td_berth_event")) {
        return { rows: [{ td_area: "PX", berth_code: "1008" }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await validateDraftInContext(pool, doc);

    expect(result.info.boundBerthCount).toBe(1);
    expect(result.info.unboundBerthCount).toBe(0);
  });

  it("warns 'not seen in the last 30 days' and probes td_berth_event wanted-driven, not a full scan", async () => {
    const doc = baseDoc({
      elements: [
        {
          id: "berth-1",
          layerId: "l1",
          zIndex: 0,
          type: "berth",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          textAlign: "center",
          fontSize: 12,
          displayName: "0512",
        },
      ],
      bindings: [
        {
          id: "bind-1",
          elementId: "berth-1",
          type: "tdBerth",
          tdArea: "PX",
          berth: "0512",
          allowDuplicate: false,
        },
      ],
    });

    let observedSql = "";
    let observedValues: unknown[] | undefined;
    const pool = fakePool((text, values) => {
      if (text.includes("from td_berth_event")) {
        observedSql = text;
        observedValues = values;
        return { rows: [] }; // never observed
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await validateDraftInContext(pool, doc);

    expect(observedSql).toContain("exists (");
    expect(observedSql).toContain("e.event_at >= now()");
    expect(observedSql).not.toMatch(/union all/i);
    expect(observedValues).toEqual([["PX"], ["0512"], 30]);
    expect(result.warnings.map((w) => w.code)).toContain("binding_never_observed");
    expect(result.warnings[0]?.message).toMatch(/last 30 days/);
    expect(result.info.observedBerthBindingPercentage).toBe(0);
  });

  it("is best-effort: a failing/slow observed query is skipped, not thrown — publish stays valid", async () => {
    const doc = baseDoc({
      elements: [
        {
          id: "berth-1",
          layerId: "l1",
          zIndex: 0,
          type: "berth",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          textAlign: "center",
          fontSize: 12,
          displayName: "0512",
        },
        {
          id: "bnd-1",
          layerId: "l1",
          zIndex: 0,
          type: "boundary",
          x: 5,
          y: 5,
          name: "North",
          adjacentMapSlug: "carnforth",
        },
      ],
      bindings: [
        {
          id: "bind-1",
          elementId: "berth-1",
          type: "tdBerth",
          tdArea: "PX",
          berth: "0512",
          allowDuplicate: false,
        },
      ],
    });

    // Every context query throws (statement timeout / DB unavailable).
    const pool = fakePool(() => {
      throw new Error("canceling statement due to statement timeout");
    });

    const result = await validateDraftInContext(pool, doc);

    // No throw; no blocking error (the unknown-adjacent-map error is NOT raised when the check
    // couldn't run); a "skipped" warning for each check.
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("adjacent_map_check_skipped");
    expect(codes).toContain("observed_binding_check_skipped");
    expect(codes).not.toContain("binding_never_observed");
  });

  it("counts a berth as unbound when no binding in doc.bindings references it, regardless of element.bindingId", async () => {
    const doc = baseDoc({
      elements: [
        {
          id: "berth-1",
          layerId: "l1",
          zIndex: 0,
          type: "berth",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          textAlign: "center",
          fontSize: 12,
          displayName: "1008",
          bindingId: "does-not-exist-in-bindings-array",
        },
      ],
      bindings: [],
    });

    const pool = fakePool((text) => {
      throw new Error(`unexpected query: ${text}`);
    });

    const result = await validateDraftInContext(pool, doc);

    expect(result.info.boundBerthCount).toBe(0);
    expect(result.info.unboundBerthCount).toBe(1);
  });
});
