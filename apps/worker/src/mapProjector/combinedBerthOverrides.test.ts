import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { computeCombinedOverrides } from "./combinedBerthOverrides.js";

type QueryHandler = (text: string, values?: unknown[]) => { rows: unknown[] };

function fakePool(handler: QueryHandler): Pool {
  return {
    query: async (text: string, values?: unknown[]) => handler(text, values),
  } as unknown as Pool;
}

describe("computeCombinedOverrides", () => {
  it("returns nothing for an ordinary (non-combined) binding — no berth_current_state query needed", async () => {
    const pool = fakePool((text) => {
      if (text.includes("from map_binding_index")) {
        return { rows: [{ td_area: "PX", berth: "0512", combined_order: null }] };
      }
      throw new Error(`unexpected query: ${text}`);
    });
    const overrides = await computeCombinedOverrides(pool, [
      { mapVersionId: "1", mapSlug: "lancaster", elementId: "berth-1" },
    ]);
    expect(overrides.size).toBe(0);
  });

  it("joins every member's current state for a combined berth (>1 member sharing the element)", async () => {
    const pool = fakePool((text) => {
      if (text.includes("from map_binding_index")) {
        return {
          rows: [
            { td_area: "PX", berth: "A001", combined_order: 1 },
            { td_area: "PX", berth: "B001", combined_order: 2 },
          ],
        };
      }
      if (text.includes("from berth_current_state")) {
        return {
          rows: [
            {
              td_area: "PX",
              berth_code: "A001",
              description: "1A23",
              occupancy_entered_at: new Date("2026-09-17T10:00:00.000Z"),
            },
            {
              td_area: "PX",
              berth_code: "B001",
              description: null,
              occupancy_entered_at: null,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const overrides = await computeCombinedOverrides(pool, [
      { mapVersionId: "1", mapSlug: "lancaster", elementId: "berth-1" },
    ]);
    expect(overrides.get("lancaster|berth-1")).toEqual({
      description: "1A23",
      enteredAt: "2026-09-17T10:00:00.000Z",
    });
  });

  it("keys overrides by mapSlug|elementId, handling more than one binding entry independently", async () => {
    const pool = fakePool((text, values) => {
      if (text.includes("from map_binding_index")) {
        const elementId = (values as unknown[])[1];
        if (elementId === "berth-1") {
          return {
            rows: [
              { td_area: "PX", berth: "A001", combined_order: 1 },
              { td_area: "PX", berth: "B001", combined_order: 2 },
            ],
          };
        }
        return { rows: [{ td_area: "PX", berth: "0512", combined_order: null }] };
      }
      if (text.includes("from berth_current_state")) {
        return {
          rows: [
            {
              td_area: "PX",
              berth_code: "A001",
              description: "1A23",
              occupancy_entered_at: new Date("2026-09-17T10:00:00.000Z"),
            },
            { td_area: "PX", berth_code: "B001", description: null, occupancy_entered_at: null },
          ],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    });

    const overrides = await computeCombinedOverrides(pool, [
      { mapVersionId: "1", mapSlug: "lancaster", elementId: "berth-1" },
      { mapVersionId: "1", mapSlug: "lancaster", elementId: "berth-99" },
    ]);
    expect(overrides.has("lancaster|berth-1")).toBe(true);
    expect(overrides.has("lancaster|berth-99")).toBe(false);
  });
});
