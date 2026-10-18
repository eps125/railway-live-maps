import { describe, expect, it } from "vitest";
import { syntheticBundle, syntheticSnapshotState } from "./syntheticMap.js";

describe("syntheticBundle (Milestone 94 bench)", () => {
  it("has about the asked-for element count in a 30/30/30/10 mix", () => {
    const bundle = syntheticBundle(5000);
    const counts: Record<string, number> = {};
    for (const element of Object.values(bundle.elementsById))
      counts[element.type] = (counts[element.type] ?? 0) + 1;
    expect(Object.keys(bundle.elementsById)).toHaveLength(5000);
    expect(counts).toEqual({ trackPath: 1500, berth: 1500, signal: 1500, label: 500 });
  });

  it("is deterministic and keeps every element inside the bounding box", () => {
    const a = syntheticBundle(1500);
    expect(syntheticBundle(1500)).toEqual(a);
    const { minX, minY, maxX, maxY } = a.boundingBox;
    for (const element of Object.values(a.elementsById)) {
      const points = "points" in element ? element.points : [element];
      for (const p of points) {
        expect(p.x).toBeGreaterThanOrEqual(minX);
        expect(p.x).toBeLessThanOrEqual(maxX);
        expect(p.y).toBeGreaterThanOrEqual(minY);
        expect(p.y).toBeLessThanOrEqual(maxY);
      }
    }
  });

  it("gives a snapshot listing every berth and signal, about a third of berths occupied", () => {
    const bundle = syntheticBundle(1500);
    const state = syntheticSnapshotState(bundle);
    const berths = Object.values(state.berths);
    expect(berths).toHaveLength(450);
    expect(Object.keys(state.signals)).toHaveLength(450);
    expect(berths.filter((b) => b.description).length).toBe(150);
  });
});
