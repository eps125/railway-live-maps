import type { BoundaryElement, MapDocument, MapElement } from "./document.js";

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

function computeBoundingBox(elements: MapElement[]): CompiledMapBundle["boundingBox"] {
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
  for (const element of doc.elements) {
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
