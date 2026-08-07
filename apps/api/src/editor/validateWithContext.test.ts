import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { MapDocument } from "@railway/map-schema";
import { validateDraftInContext } from "./validateWithContext.js";

type QueryHandler = (text: string, values?: unknown[]) => { rows: unknown[] };

function fakePool(handler: QueryHandler): Pool {
  return {
    query: async (text: string, values?: unknown[]) => handler(text, values),
  } as unknown as Pool;
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

  it("counts a berth as unbound when no binding in doc.bindings references it, regardless of element.bindingId", async () => {
    const doc = baseDoc({
      elements: [
        {
          id: "berth-1",
          layerId: "l1",
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
