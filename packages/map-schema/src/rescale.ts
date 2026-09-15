import type { MapDocument, MapElement } from "./document.js";

/**
 * Multiplies every coordinate a map document stores — element positions/polylines, topology
 * nodes, and `canvas.width`/`height`/`gridSize` — by `scale`, uniformly in both axes. Pairs with
 * a `MAP_STYLE.rowPitch`/`weldTolerance` change of the same factor (see `style.ts`'s doc
 * comment): those two live in this same coordinate space, so scaling them without also scaling
 * an already-drawn document's coordinates would leave it geometrically stale relative to the new
 * row spacing.
 *
 * Deliberately does NOT touch: each element's own `fontSize`, a `berth`'s stored `width`/`height`
 * box size, or any `MAP_STYLE` "furniture" constant (berth/platform/signal render sizes, stroke
 * widths) — those are meant to stay their current absolute pixel size. Scaling *only* the
 * coordinate space while furniture stays fixed is what actually creates more breathing room
 * between rows; scaling everything uniformly (furniture included) would be indistinguishable
 * from zooming the viewport in, which was explicitly not the goal (2026-09-15 owner discussion).
 *
 * Pure and total: every element type in the discriminated union is covered, so this can't
 * silently drop a coordinate a future element type adds without a type error here first.
 */
export function rescaleMapDocument(doc: MapDocument, scale: number): MapDocument {
  return {
    ...doc,
    map: {
      ...doc.map,
      canvas: {
        width: doc.map.canvas.width * scale,
        height: doc.map.canvas.height * scale,
        gridSize: doc.map.canvas.gridSize * scale,
      },
    },
    elements: doc.elements.map((element) => rescaleElement(element, scale)),
    topology: {
      nodes: doc.topology.nodes.map((node) => ({
        ...node,
        x: node.x * scale,
        y: node.y * scale,
      })),
      edges: doc.topology.edges,
    },
  };
}

function rescaleElement(element: MapElement, scale: number): MapElement {
  switch (element.type) {
    case "trackPath":
    case "platform":
      return {
        ...element,
        points: element.points.map((p) => ({ x: p.x * scale, y: p.y * scale })),
      };
    case "berth":
      // width/height are the box's own furniture size — not rescaled (see module doc comment).
      return { ...element, x: element.x * scale, y: element.y * scale };
    case "signal":
    case "platformNumber":
    case "station":
    case "label":
    case "boundary":
      return { ...element, x: element.x * scale, y: element.y * scale };
  }
}
