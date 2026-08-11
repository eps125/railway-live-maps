import type { BoundaryElement, Layer, MapDocument, MapElement } from "./document.js";

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
  const elementsById: Record<string, MapElement> = {};
  for (const element of sortElementsForPaint(doc.elements, doc.layers)) {
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
