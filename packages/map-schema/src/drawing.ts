import type { BufferStopElement } from "./document.js";
import { MAP_STYLE } from "./style.js";

/**
 * 2026-09-27: small drawings described once as simple shapes, so the public SVG renderer and the
 * editor's Konva canvas draw exactly the same thing (CLAUDE.md rule 13) — each only has to turn
 * these primitives into its own nodes.
 */
export type DrawPrimitive =
  | {
      kind: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      fill: string;
      rx?: number;
      stroke?: string;
      strokeWidth?: number;
    }
  | { kind: "polygon"; points: number[]; fill: string; stroke?: string; strokeWidth?: number }
  | { kind: "circle"; cx: number; cy: number; r: number; fill: string }
  | { kind: "polyline"; points: number[]; stroke: string; strokeWidth: number }
  | { kind: "path"; d: string; fill: string; stroke?: string; strokeWidth?: number }
  | {
      kind: "text";
      x: number;
      /** Baseline. Centred horizontally on `x`. */
      y: number;
      text: string;
      fontSize: number;
      fill: string;
      bold: boolean;
    };

/** A drawing placed on the map: translate to (x, y), mirror by `scaleX`, turn by `rotation`
 * degrees, then draw `parts` in the drawing's own units. */
export interface PlacedDrawing {
  x: number;
  y: number;
  scaleX: number;
  rotation: number;
  parts: DrawPrimitive[];
}

/**
 * A buffer stop, top-down (owner's photos): the face a train meets at x = 0, the body running
 * back to x = `depth`, `across` wide centred on the track. Mirrored for one facing right.
 */
export function bufferStopDrawing(element: BufferStopElement): PlacedDrawing {
  const s = MAP_STYLE.bufferStop;
  const half = s.across / 2;
  const parts: DrawPrimitive[] = [];
  if ((element.style ?? "rawie") === "rawie") {
    // Red frame sloping back, the beam with a white stripe, two red box buffers with a white
    // stripe and dark faces.
    parts.push({
      kind: "polygon",
      points: [3, -4.6, s.depth, -2.4, s.depth, 2.4, 3, 4.6],
      fill: s.red,
      stroke: s.redEdge,
      strokeWidth: 0.25,
    });
    parts.push({
      kind: "rect",
      x: 2,
      y: -half,
      width: 1.1,
      height: s.across,
      fill: s.redLight,
      stroke: s.redEdge,
      strokeWidth: 0.25,
    });
    parts.push({ kind: "rect", x: 2.35, y: -half, width: 0.35, height: s.across, fill: s.white });
    for (const cy of [-2.5, 2.5]) {
      parts.push({
        kind: "rect",
        x: 0.35,
        y: cy - 1.2,
        width: 1.75,
        height: 2.4,
        fill: s.redLight,
        stroke: s.redEdge,
        strokeWidth: 0.25,
      });
      parts.push({ kind: "rect", x: 0.35, y: cy - 0.2, width: 1.75, height: 0.4, fill: s.white });
      parts.push({ kind: "rect", x: 0, y: cy - 1.3, width: 0.45, height: 2.6, fill: s.dark });
    }
  } else {
    // A dark beam, two red cylinders and black buffer discs on the end.
    parts.push({
      kind: "rect",
      x: 3.3,
      y: -half,
      width: 1.5,
      height: s.across,
      fill: s.dark,
      stroke: s.darkEdge,
      strokeWidth: 0.25,
    });
    for (const cy of [-2.5, 2.5]) {
      parts.push({
        kind: "rect",
        x: 1.4,
        y: cy - 0.9,
        width: 2,
        height: 1.8,
        rx: 0.5,
        fill: s.red,
      });
      parts.push({ kind: "rect", x: 0.5, y: cy - 0.3, width: 1, height: 0.6, fill: s.dark });
      parts.push({
        kind: "rect",
        x: 0,
        y: cy - 1.2,
        width: 0.5,
        height: 2.4,
        rx: 0.2,
        fill: s.dark,
      });
    }
  }
  // Facing left (trains arrive from the left): the body runs to the right of the face.
  return {
    x: element.x,
    y: element.y,
    scaleX: element.facing === "left" ? 1 : -1,
    rotation: 0,
    parts,
  };
}

/** The buffer stop's footprint on the map. */
export function bufferStopBounds(element: BufferStopElement): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const s = MAP_STYLE.bufferStop;
  return {
    x: element.facing === "left" ? element.x : element.x - s.depth,
    y: element.y - s.across / 2,
    width: s.depth,
    height: s.across,
  };
}

/**
 * The depot stop board (owner's photo: a white board, red disc, black "Stop"), drawn upright in
 * its own units — `depth` wide, `length` tall, centred on (0, 0), disc at the top — for
 * `signalPostGeometry` to place and turn. The first part is the cut-out round it.
 */
export function stopBoardParts(): DrawPrimitive[] {
  const b = MAP_STYLE.signal.stopBoard;
  const cut = MAP_STYLE.signal.cutout;
  return [
    {
      kind: "rect",
      x: -b.depth / 2 - cut.width,
      y: -b.length / 2 - cut.width,
      width: b.depth + 2 * cut.width,
      height: b.length + 2 * cut.width,
      rx: 0.6 + cut.width,
      fill: cut.color,
    },
    {
      kind: "rect",
      x: -b.depth / 2,
      y: -b.length / 2,
      width: b.depth,
      height: b.length,
      rx: 0.6,
      fill: b.white,
      stroke: b.edge,
      strokeWidth: 0.4,
    },
    { kind: "circle", cx: 0, cy: -b.length / 2 + 4.1, r: b.discRadius, fill: b.red },
    {
      kind: "text",
      x: 0,
      y: b.length / 2 - 2.2,
      text: "Stop",
      fontSize: b.fontSize,
      fill: b.text,
      bold: true,
    },
  ];
}
