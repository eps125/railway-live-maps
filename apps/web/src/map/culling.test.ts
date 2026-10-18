import { describe, expect, it } from "vitest";
import type { MapElement } from "@railway/map-schema";
import {
  buildCullIndex,
  cullRegionFor,
  elementDrawBounds,
  needsRecull,
  nextCullRegion,
} from "./culling.js";

const base = { layerId: "l", zIndex: 0 };

describe("elementDrawBounds (Milestone 94)", () => {
  it("covers a berth's drawn box, a signal's post and number, and a label's text", () => {
    const berth = elementDrawBounds(
      {
        ...base,
        id: "b",
        type: "berth",
        x: 100,
        y: 50,
        width: 40,
        height: 20,
        textAlign: "center",
        fontSize: 12,
        displayName: "0001",
      },
      { x: 100, y: 60, width: 40, height: 20 },
    )!;
    // The drawn (track-centred) box, not the authored one.
    expect(berth.minY).toBeLessThanOrEqual(60);
    expect(berth.maxY).toBeGreaterThanOrEqual(80);

    const signal = elementDrawBounds(
      {
        ...base,
        id: "s",
        type: "signal",
        x: 500,
        y: 500,
        orientation: 0,
        symbolStyle: "signal-blank",
        labelOffset: { x: -200, y: 0 },
      } as MapElement,
      undefined,
    )!;
    expect(signal.minX).toBeLessThanOrEqual(300);
    expect(signal.maxX).toBeGreaterThanOrEqual(540);

    const label = elementDrawBounds(
      {
        ...base,
        id: "l",
        type: "label",
        x: 1000,
        y: 100,
        text: "A long place name\nsecond line",
        align: "left",
        fontSize: 12,
      },
      undefined,
    )!;
    expect(label.minX).toBeLessThanOrEqual(1000);
    // 17 characters at 12 units: never estimated narrower than the text can be.
    expect(label.maxX).toBeGreaterThanOrEqual(1000 + 17 * 12 * 0.6);
    expect(label.maxY).toBeGreaterThan(100 + 12);
  });

  it("covers a control boundary's line and the names beyond its ends (Milestone 95)", () => {
    const box = elementDrawBounds(
      {
        ...base,
        id: "cb",
        type: "controlBoundary",
        points: [
          { x: 500, y: 100 },
          { x: 500, y: 300 },
        ],
        leftName: "Crewe Coal Yard SB",
        rightName: "Crewe PSB",
        nameEnds: "both",
        fontSize: 11,
      },
      undefined,
    )!;
    // The left name runs leftwards from just left of the line: 18 characters at 11 units.
    expect(box.minX).toBeLessThanOrEqual(500 - 18 * 11 * 0.6);
    expect(box.maxX).toBeGreaterThanOrEqual(500 + 9 * 11 * 0.6);
    // Names sit above the top end and hang below the bottom end.
    expect(box.minY).toBeLessThan(100 - 11);
    expect(box.maxY).toBeGreaterThan(300 + 11);
  });

  it("gives null (always drawn) for an element type it does not know", () => {
    expect(elementDrawBounds({ ...base, id: "x", type: "mystery" } as never, undefined)).toBeNull();
  });
});

describe("buildCullIndex", () => {
  const track = (id: string, x: number, y: number): MapElement => ({
    ...base,
    id,
    type: "trackPath",
    points: [
      { x, y },
      { x: x + 100, y },
    ],
  });

  it("finds what meets a region, across cell edges, and always includes unknown types", () => {
    const elements = [
      track("near", 990, 0),
      track("far", 50_000, 0),
      track("below", 990, 5_000),
      { ...base, id: "odd", type: "mystery" } as never,
    ];
    const index = buildCullIndex(elements, new Map());
    const found = index.query({ minX: 1050, minY: -10, maxX: 1060, maxY: 10 });
    expect([...found].sort()).toEqual(["near", "odd"]);
  });
});

describe("cull region", () => {
  const view = { x: 1000, y: 500, width: 2000, height: 1000 };

  it("is the view plus a window on every side", () => {
    expect(cullRegionFor(view)).toEqual({ minX: -1000, minY: -500, maxX: 5000, maxY: 2500 });
  });

  it("keeps a generous margin round a small (phone) view", () => {
    const phone = { x: 0, y: 0, width: 550, height: 1200 };
    expect(cullRegionFor(phone)).toEqual({ minX: -1000, minY: -1200, maxX: 1550, maxY: 2400 });
    // So a long drag across a phone screen does not renew it every few frames.
    const region = cullRegionFor(phone);
    expect(needsRecull(region, { ...phone, x: 700 })).toBe(false);
    expect(needsRecull(region, { ...phone, x: 800 })).toBe(true);
  });

  it("grows along a drag that turns back, and starts afresh after a long one", () => {
    const start = cullRegionFor(view);
    const moved = { ...view, x: view.x + 1100 };
    const grown = nextCullRegion(start, moved);
    // Still covers where the view was, so turning back draws nothing new.
    expect(grown.minX).toBe(start.minX);
    expect(grown.maxX).toBe(cullRegionFor(moved).maxX);
    const far = { ...view, x: view.x + 20_000 };
    expect(nextCullRegion(grown, far)).toEqual(cullRegionFor(far));
  });

  it("is renewed only near its edge, on a big zoom-out, or a big zoom-in", () => {
    const region = cullRegionFor(view);
    expect(needsRecull(null, view)).toBe(true);
    expect(needsRecull(region, view)).toBe(false);
    expect(needsRecull(region, { ...view, x: view.x + 900 })).toBe(false);
    expect(needsRecull(region, { ...view, x: view.x + 1100 })).toBe(true);
    expect(needsRecull(region, { x: 0, y: 0, width: 4000, height: 2000 })).toBe(true);
    // Zooming in keeps a region up to twice the size a fresh one would be...
    expect(needsRecull(region, { x: 2000, y: 1000, width: 1000, height: 500 })).toBe(false);
    // ...but not one drawn for a far-out view.
    const wide = cullRegionFor({ x: 0, y: 0, width: 20000, height: 10000 });
    expect(needsRecull(wide, { x: 5000, y: 5000, width: 2000, height: 1000 })).toBe(true);
  });
});
