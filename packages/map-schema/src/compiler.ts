import type {
  BoundaryElement,
  Layer,
  MapDocument,
  MapElement,
  TrackPathElement,
} from "./document.js";
import { MAP_STYLE } from "./style.js";

export interface CompiledMapBundle {
  schemaVersion: number;
  mapId: string;
  mapName: string;
  canvas: { width: number; height: number; gridSize: number };
  timezone: string;
  layers: MapDocument["layers"];
  elementsById: Record<string, MapElement>;
  /** `${tdArea}|${berth}` -> elementId */
  berthBindingIndex: Record<string, string>;
  /** `${tdArea}|${address}|${bit}` -> elementId */
  sBitBindingIndex: Record<string, string>;
  boundingBox: { minX: number; minY: number; maxX: number; maxY: number };
  /** nodeId -> adjacent nodeIds */
  topologyAdjacency: Record<string, string[]>;
  continuationLinks: Array<{
    elementId: string;
    adjacentMapSlug: string | undefined;
    direction: string | undefined;
  }>;
}

/**
 * Paint order: each layer occupies its own reserved "band" of z-space (`Layer.order *
 * Z_INDEX_LAYER_BAND`), and an element's `zIndex` is added directly on top of its own layer's
 * band before the whole thing is sorted as one flat number. With every element left at the
 * default `zIndex: 0`, this reduces to pure layer order — docs/MAP_EDITOR_SPEC.md's default
 * stacking (tracks < berths < signals < everything else). A small `zIndex` (the editor's +/-
 * buttons move it by 1) just reorders within the element's own band, i.e. relative to other
 * elements on the same layer. A `zIndex` large enough to exceed the band width is a deliberate
 * full override: it's added to the *global* number, so it can push an element clear across a
 * layer boundary on purpose (e.g. a specific signal set to sink below a specific berth). Document
 * array order is the final tiebreak. Shared by the compiler (for the published bundle the public
 * renderer consumes) and the editor canvas (for the live in-progress document), so both agree on
 * stacking without duplicating the sort. An element referencing an unknown layerId sorts last
 * rather than crashing or silently landing at the bottom.
 */
export const Z_INDEX_LAYER_BAND = 1_000_000;

export function sortElementsForPaint(elements: MapElement[], layers: Layer[]): MapElement[] {
  const layerOrderById = new Map(layers.map((layer) => [layer.id, layer.order]));

  function paintKey(element: MapElement): number {
    const layerOrder = layerOrderById.get(element.layerId);
    if (layerOrder === undefined) return Number.POSITIVE_INFINITY;
    return layerOrder * Z_INDEX_LAYER_BAND + element.zIndex;
  }

  return elements
    .map((element, index) => ({ element, index, key: paintKey(element) }))
    .sort((a, b) => (a.key !== b.key ? a.key - b.key : a.index - b.index))
    .map(({ element }) => element);
}

type Pt = { x: number; y: number };

function near(a: Pt, b: Pt): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= MAP_STYLE.weldTolerance;
}

/**
 * D2 (ADR 0004): weld `trackPath` elements that are the same running line broken into
 * segments back into a single multi-vertex polyline, so a diagonal meeting a horizontal is a
 * `stroke-linejoin` corner inside one stroke (no wedge-shaped gap between two `butt`-capped
 * elements) — the shape OpenTrainTimes uses, and without any junction dots.
 *
 * Two segments are welded only when **both** hold: an endpoint of one coincides (within
 * `weldTolerance`) with an endpoint of the other, **and** they are joined in `topology` — the
 * same `topologyEdgeId`, or two edges that share a node. A purely visual crossing with no
 * topology is never merged (docs/MAP_EDITOR_SPEC.md §4: "visual line crossings do not imply
 * connected track"). Segments with a different `line` are also left alone.
 *
 * Returns the rewritten element list (welded-away segments removed, the survivor's `points`
 * extended) and `remap`: `removedId -> survivingId`, so `trackElementId` back-references on
 * berths/signals can be repointed.
 */
export function weldTrackPaths(
  elements: MapElement[],
  topology: MapDocument["topology"],
): { elements: MapElement[]; remap: Record<string, string> } {
  const edgeNodes = new Map<string, Set<string>>();
  for (const edge of topology.edges) {
    edgeNodes.set(edge.id, new Set([edge.fromNodeId, edge.toNodeId]));
  }
  const topologyJoined = (a: TrackPathElement, b: TrackPathElement): boolean => {
    if (!a.topologyEdgeId || !b.topologyEdgeId) return false;
    if (a.topologyEdgeId === b.topologyEdgeId) return true;
    const na = edgeNodes.get(a.topologyEdgeId);
    const nb = edgeNodes.get(b.topologyEdgeId);
    if (!na || !nb) return false;
    for (const n of na) if (nb.has(n)) return true;
    return false;
  };

  // Mutable working copies of every trackPath's point list, keyed by id; non-track elements
  // pass through untouched. `absorbed` maps a removed id to the id that swallowed it.
  const working = new Map<string, TrackPathElement>();
  for (const el of elements)
    if (el.type === "trackPath") working.set(el.id, { ...el, points: [...el.points] });
  const absorbed = new Map<string, string>();

  let merged = true;
  while (merged) {
    merged = false;
    const ids = [...working.keys()];
    outer: for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = working.get(ids[i]!);
        const b = working.get(ids[j]!);
        if (!a || !b) continue;
        if ((a.line ?? null) !== (b.line ?? null)) continue;
        if (!topologyJoined(a, b)) continue;

        const aStart = a.points[0]!;
        const aEnd = a.points[a.points.length - 1]!;
        const bStart = b.points[0]!;
        const bEnd = b.points[b.points.length - 1]!;

        let mergedPoints: Pt[] | null = null;
        if (near(aEnd, bStart)) mergedPoints = [...a.points, ...b.points.slice(1)];
        else if (near(aEnd, bEnd))
          mergedPoints = [...a.points, ...[...b.points].reverse().slice(1)];
        else if (near(aStart, bEnd)) mergedPoints = [...b.points, ...a.points.slice(1)];
        else if (near(aStart, bStart))
          mergedPoints = [...[...b.points].reverse(), ...a.points.slice(1)];
        if (!mergedPoints) continue;

        working.set(a.id, { ...a, points: mergedPoints });
        working.delete(b.id);
        absorbed.set(b.id, a.id);
        merged = true;
        break outer;
      }
    }
  }

  if (absorbed.size === 0) return { elements, remap: {} };

  // Collapse chains (b absorbed by a, a later absorbed by c) so every removed id points at the
  // final survivor.
  const remap: Record<string, string> = {};
  for (const from of absorbed.keys()) {
    let to = absorbed.get(from)!;
    while (absorbed.has(to)) to = absorbed.get(to)!;
    remap[from] = to;
  }

  const rewritten = elements
    .filter((el) => !(el.type === "trackPath" && remap[el.id]))
    .map((el) => {
      if (el.type === "trackPath") return working.get(el.id) ?? el;
      if (
        (el.type === "berth" || el.type === "signal" || el.type === "platform") &&
        el.trackElementId
      ) {
        const to = remap[el.trackElementId];
        if (to) return { ...el, trackElementId: to };
      }
      return el;
    });

  return { elements: rewritten, remap };
}

export function computeBoundingBox(elements: MapElement[]): CompiledMapBundle["boundingBox"] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const consider = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };

  for (const element of elements) {
    if (element.type === "trackPath" || element.type === "platform") {
      for (const point of element.points) consider(point.x, point.y);
    } else {
      consider(element.x, element.y);
    }
  }

  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Publication compilation (docs/MAP_EDITOR_SPEC.md §11): element-by-id lookup, berth/S-bit
 * binding indexes, bounding box, topology adjacency, map continuation links — and
 * `editorMetadata` is simply never copied into the output, which is how it gets stripped.
 */
export function compileMapDocument(doc: MapDocument): CompiledMapBundle {
  // D2 (ADR 0004): merge topology-joined coincident track segments into single polylines
  // before indexing, so the public renderer never has to bridge a gap between two separate
  // `butt`-capped `trackPath` elements at a junction.
  const { elements: compiledElements } = weldTrackPaths(
    sortElementsForPaint(doc.elements, doc.layers),
    doc.topology,
  );
  const elementsById: Record<string, MapElement> = {};
  for (const element of compiledElements) {
    elementsById[element.id] = element;
  }

  const berthBindingIndex: Record<string, string> = {};
  const sBitBindingIndex: Record<string, string> = {};
  for (const binding of doc.bindings) {
    if (binding.type === "tdBerth") {
      berthBindingIndex[`${binding.tdArea}|${binding.berth}`] = binding.elementId;
    } else {
      sBitBindingIndex[`${binding.tdArea}|${binding.address}|${binding.bit}`] = binding.elementId;
    }
  }

  const topologyAdjacency: Record<string, string[]> = {};
  for (const node of doc.topology.nodes) {
    topologyAdjacency[node.id] = [];
  }
  for (const edge of doc.topology.edges) {
    topologyAdjacency[edge.fromNodeId]?.push(edge.toNodeId);
    topologyAdjacency[edge.toNodeId]?.push(edge.fromNodeId);
  }

  const continuationLinks = doc.elements
    .filter((element): element is BoundaryElement => element.type === "boundary")
    .map((element) => ({
      elementId: element.id,
      adjacentMapSlug: element.adjacentMapSlug,
      direction: element.direction,
    }));

  return {
    schemaVersion: doc.schemaVersion,
    mapId: doc.map.id,
    mapName: doc.map.name,
    canvas: doc.map.canvas,
    timezone: doc.map.timezone,
    layers: doc.layers,
    elementsById,
    berthBindingIndex,
    sBitBindingIndex,
    boundingBox: computeBoundingBox(doc.elements),
    topologyAdjacency,
    continuationLinks,
  };
}
