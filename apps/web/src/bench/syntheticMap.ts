import type { CompiledMapBundle, MapElement } from "@railway/map-schema";
import type { BerthState, SignalState } from "../map/types.js";

/**
 * Milestone 94 (dev-only): a synthetic compiled map bundle of about `elementCount` elements, for
 * measuring how the public renderer scales with map size. Never shipped or published.
 *
 * Shaped like the real Carlisle bundle (2026-10-18): 2-point horizontal track segments, berths
 * 40 × 20 with **no** `trackElementId` (none of Carlisle's 279 are bound, so the renderer searches
 * for the nearest track), ADR 0017 signals on posts, and plain labels. The mix is the one asked
 * for: per three 100-unit cells, 3 tracks, 3 berths, 3 signals and 1 label (30/30/30/10).
 * Deterministic: the same count always gives the same bundle.
 */
export function syntheticBundle(elementCount: number): CompiledMapBundle {
  const cellsPerRow = 150;
  const cellWidth = 100;
  const rowPitch = 80;
  const groups = Math.max(1, Math.round(elementCount / 10));
  const elementsById: Record<string, MapElement> = {};
  const berthBindingIndex: Record<string, string> = {};
  const sBitBindingIndex: Record<string, string> = {};
  let cell = 0;
  let maxX = 0;
  let maxY = 0;

  for (let g = 0; g < groups; g += 1) {
    for (let k = 0; k < 3; k += 1, cell += 1) {
      const row = Math.floor(cell / cellsPerRow);
      const x0 = (cell % cellsPerRow) * cellWidth;
      const y = row * rowPitch + 40;
      maxX = Math.max(maxX, x0 + cellWidth);
      maxY = Math.max(maxY, y + 30);
      const track = `t${cell}`;
      const berth = `b${cell}`;
      const signal = `s${cell}`;
      elementsById[track] = {
        id: track,
        type: "trackPath",
        layerId: "layer-track",
        zIndex: 0,
        points: [
          { x: x0, y },
          { x: x0 + cellWidth, y },
        ],
      };
      elementsById[berth] = {
        id: berth,
        type: "berth",
        layerId: "layer-berths",
        zIndex: 0,
        x: x0 + 30,
        y: y - 10,
        width: 40,
        height: 20,
        textAlign: "center",
        fontSize: 12,
        displayName: berthCode(cell),
      };
      elementsById[signal] = {
        id: signal,
        type: "signal",
        layerId: "layer-signals",
        zIndex: 0,
        x: x0 + 80,
        y,
        orientation: 0,
        symbolStyle: "signal-blank",
        appliesTo: "right",
        side: "above",
        label: `S${cell}`,
      } as MapElement;
      berthBindingIndex[`SY|${berthCode(cell)}`] = berth;
      sBitBindingIndex[`SY|${hex2(cell >> 3)}|${cell & 7}`] = signal;
    }
    const label = `l${g}`;
    const row = Math.floor((cell - 2) / cellsPerRow);
    elementsById[label] = {
      id: label,
      type: "label",
      layerId: "layer-labels",
      zIndex: 0,
      x: ((cell - 2) % cellsPerRow) * cellWidth + 50,
      y: row * rowPitch + 70,
      text: `Place ${g}`,
      align: "center",
      fontSize: 12,
    };
  }

  return {
    schemaVersion: 1,
    mapId: `synthetic-${elementCount}`,
    mapName: `Synthetic ${elementCount}`,
    canvas: { width: maxX, height: maxY, gridSize: 10 },
    timezone: "Europe/London",
    layers: [
      { id: "layer-track", name: "Track", order: 0, locked: false, visible: true },
      { id: "layer-berths", name: "Berths", order: 2, locked: false, visible: true },
      { id: "layer-signals", name: "Signals", order: 3, locked: false, visible: true },
      { id: "layer-labels", name: "Labels", order: 4, locked: false, visible: true },
    ],
    elementsById,
    berthBindingIndex,
    sBitBindingIndex,
    placeBindingIndex: [],
    boundingBox: { minX: 0, minY: 0, maxX, maxY },
    topologyAdjacency: {},
  } as unknown as CompiledMapBundle;
}

function hex2(n: number): string {
  return (n & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

function berthCode(cell: number): string {
  return String(cell % 10000).padStart(4, "0");
}

/** A headcode for the `i`th train: digit, letter, two digits. */
export function headcode(i: number): string {
  return `${i % 10}${String.fromCharCode(65 + (i % 26))}${String(i % 100).padStart(2, "0")}`;
}

/** A live snapshot for the bundle, as the WebSocket sends it: every berth listed (about a third
 * occupied, like a busy map) and every signal on or off. */
export function syntheticSnapshotState(bundle: CompiledMapBundle): {
  berths: Record<string, BerthState>;
  signals: Record<string, SignalState>;
} {
  const berths: Record<string, BerthState> = {};
  const signals: Record<string, SignalState> = {};
  let i = 0;
  const enteredAt = "2026-10-18T09:00:00.000Z";
  for (const element of Object.values(bundle.elementsById)) {
    if (element.type === "berth") {
      berths[element.id] =
        i % 3 === 0
          ? { description: headcode(i), enteredAt }
          : { description: null, enteredAt: null };
      i += 1;
    } else if (element.type === "signal") {
      signals[element.id] = { state: i % 2 === 0 ? "on" : "off" };
    }
  }
  return { berths, signals };
}
