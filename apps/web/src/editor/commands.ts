import type { MapDocument, MapElement, MapBinding, TopologyEdge } from "@railway/map-schema";

type Layer = MapDocument["layers"][number];

/**
 * Milestone 11 command model (docs/MAP_EDITOR_SPEC.md §8: `AddElement`, `DeleteElements`,
 * `MoveElements`, `ResizeElement`, `SetProperty`, `SetBinding`, `ConnectTopology`,
 * `DisconnectTopology`, `ReorderLayer`). Mirrors `packages/domain/src/td/berthReducer.ts`'s
 * pure-effect style: no I/O, deterministic, exhaustively unit tested — just client-side
 * instead of a DB-backed projector. `addElement`/`deleteElements` take arrays so one can be
 * the other's exact inverse (deleting N elements restores all N, and their bindings, with a
 * single `addElement`).
 */
export type EditorCommand =
  | { type: "addElement"; elements: MapElement[]; bindings?: MapBinding[] }
  | { type: "deleteElements"; elementIds: string[] }
  | { type: "moveElements"; elementIds: string[]; dx: number; dy: number }
  | { type: "resizeElement"; elementId: string; width: number; height: number }
  | { type: "setProperty"; elementId: string; property: string; value: unknown }
  /** Milestone 64: several properties of one element in one undo step — a route re-trace changes
   * its points, traced tracks and exit signal together. A value of `undefined` removes the key. */
  | { type: "patchElement"; elementId: string; patch: Record<string, unknown> }
  | { type: "renameElement"; elementId: string; newId: string }
  | { type: "setBinding"; elementId: string; binding: MapBinding | null }
  /** Owner request 2026-09-17: a combined berth — up to 4 `tdBerth` bindings sharing one
   * elementId (docs/MAP_EDITOR_SPEC.md's berth section). Replaces the *entire* set of bindings
   * currently on `elementId` in one commit (same "whole-group" granularity as `setBinding`,
   * generalized past exactly one), so undo restores the prior group in a single step too. */
  | { type: "setCombinedBindings"; elementId: string; bindings: MapBinding[] }
  | { type: "connectTopology"; edge: TopologyEdge }
  | { type: "disconnectTopology"; edgeId: string }
  | { type: "reorderLayer"; layerId: string; newOrder: number }
  /** Not one of §8's named commands (which only lists reordering) but needed for §7's
   * "layer visibility/lock" bullet — same shape discipline as `setProperty`, one field over. */
  | {
      type: "setLayerProperty";
      layerId: string;
      property: "name" | "visible" | "locked";
      value: unknown;
    };

export interface ApplyCommandResult {
  doc: MapDocument;
  inverse: EditorCommand;
}

/** Structural, not a hardcoded type list: `moveElements` treats anything without `points` as an
 * x/y element, so a new points-based type missing from a list here would have `x += dx` written
 * onto it and silently corrupt. Milestone 55 added three such types (tunnel/viaduct/water). */
function hasPoints(element: MapElement): element is Extract<MapElement, { points: unknown }> {
  return "points" in element;
}

function hasPosition(
  element: MapElement,
): element is Extract<MapElement, { x: number; y: number }> {
  return !hasPoints(element);
}

function applyAddElement(
  doc: MapDocument,
  elements: MapElement[],
  bindings: MapBinding[],
): ApplyCommandResult {
  return {
    doc: {
      ...doc,
      elements: [...doc.elements, ...elements],
      bindings: [...doc.bindings, ...bindings],
    },
    inverse: { type: "deleteElements", elementIds: elements.map((element) => element.id) },
  };
}

function applyDeleteElements(doc: MapDocument, elementIds: string[]): ApplyCommandResult {
  const idSet = new Set(elementIds);
  // Milestone 64 / ADR 0016: a route belongs to its entry signal, so deleting the signal deletes
  // its routes (and their bindings) too, in the same undoable step, rather than leaving routes that
  // start nowhere and would block publication.
  for (const element of doc.elements) {
    if (element.type === "route" && idSet.has(element.entrySignalId)) idSet.add(element.id);
  }
  const removedElements = doc.elements.filter((element) => idSet.has(element.id));
  const removedBindings = doc.bindings.filter((binding) => idSet.has(binding.elementId));

  return {
    doc: {
      ...doc,
      elements: doc.elements.filter((element) => !idSet.has(element.id)),
      bindings: doc.bindings.filter((binding) => !idSet.has(binding.elementId)),
    },
    inverse: { type: "addElement", elements: removedElements, bindings: removedBindings },
  };
}

function applyMoveElements(
  doc: MapDocument,
  elementIds: string[],
  dx: number,
  dy: number,
): ApplyCommandResult {
  const idSet = new Set(elementIds);
  const elements = doc.elements.map((element): MapElement => {
    if (!idSet.has(element.id)) return element;
    if (hasPoints(element)) {
      return {
        ...element,
        points: element.points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
      };
    }
    return { ...element, x: element.x + dx, y: element.y + dy };
  });

  return {
    doc: { ...doc, elements },
    inverse: { type: "moveElements", elementIds, dx: -dx, dy: -dy },
  };
}

function applyResizeElement(
  doc: MapDocument,
  elementId: string,
  width: number,
  height: number,
): ApplyCommandResult {
  const target = doc.elements.find((element) => element.id === elementId);
  if (!target || !("width" in target) || !("height" in target)) {
    throw new Error(`resizeElement: element "${elementId}" has no width/height to resize`);
  }
  const previousWidth = target.width;
  const previousHeight = target.height;

  const elements = doc.elements.map((element) =>
    element.id === elementId ? { ...element, width, height } : element,
  );

  return {
    doc: { ...doc, elements },
    inverse: { type: "resizeElement", elementId, width: previousWidth, height: previousHeight },
  };
}

function applySetProperty(
  doc: MapDocument,
  elementId: string,
  property: string,
  value: unknown,
): ApplyCommandResult {
  const target = doc.elements.find((element) => element.id === elementId);
  if (!target) {
    throw new Error(`setProperty: element "${elementId}" not found`);
  }
  const previousValue = (target as unknown as Record<string, unknown>)[property];

  const elements = doc.elements.map((element) =>
    element.id === elementId ? { ...element, [property]: value } : element,
  );

  return {
    doc: { ...doc, elements },
    inverse: { type: "setProperty", elementId, property, value: previousValue },
  };
}

function applyPatchElement(
  doc: MapDocument,
  elementId: string,
  patch: Record<string, unknown>,
): ApplyCommandResult {
  const target = doc.elements.find((element) => element.id === elementId);
  if (!target) {
    throw new Error(`patchElement: element "${elementId}" not found`);
  }
  const current = target as unknown as Record<string, unknown>;
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = current[key];
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  const elements = doc.elements.map((element) =>
    element.id === elementId ? (next as unknown as MapElement) : element,
  );
  return {
    doc: { ...doc, elements },
    inverse: { type: "patchElement", elementId, patch: previous },
  };
}

/** Element IDs are referenced from three other places in the document: `bindings.elementId`,
 * `trackElementId` on berth/signal elements and topology edges (an optional pointer to a
 * trackPath), and the element's own `id`. Renaming has to update all of them atomically or a
 * binding/track-link would silently point at nothing. */
function applyRenameElement(
  doc: MapDocument,
  elementId: string,
  newId: string,
): ApplyCommandResult {
  if (elementId === newId) {
    return { doc, inverse: { type: "renameElement", elementId: newId, newId: elementId } };
  }
  const target = doc.elements.find((element) => element.id === elementId);
  if (!target) {
    throw new Error(`renameElement: element "${elementId}" not found`);
  }
  if (doc.elements.some((element) => element.id === newId)) {
    throw new Error(`renameElement: an element with id "${newId}" already exists`);
  }

  const elements = doc.elements.map((element): MapElement => {
    const withNewId = element.id === elementId ? { ...element, id: newId } : element;
    if ("trackElementId" in withNewId && withNewId.trackElementId === elementId) {
      return { ...withNewId, trackElementId: newId };
    }
    // Milestone 64: a route names its entry/exit signals and the tracks it was traced along.
    if (withNewId.type === "route") {
      return {
        ...withNewId,
        entrySignalId: withNewId.entrySignalId === elementId ? newId : withNewId.entrySignalId,
        ...(withNewId.exitSignalId === elementId ? { exitSignalId: newId } : {}),
        trackIds: withNewId.trackIds.map((id) => (id === elementId ? newId : id)),
      };
    }
    return withNewId;
  });

  const bindings = doc.bindings.map((binding) =>
    binding.elementId === elementId ? { ...binding, elementId: newId } : binding,
  );

  const edges = doc.topology.edges.map((edge) =>
    edge.trackElementId === elementId ? { ...edge, trackElementId: newId } : edge,
  );

  return {
    doc: { ...doc, elements, bindings, topology: { ...doc.topology, edges } },
    inverse: { type: "renameElement", elementId: newId, newId: elementId },
  };
}

function applySetBinding(
  doc: MapDocument,
  elementId: string,
  binding: MapBinding | null,
): ApplyCommandResult {
  const previousBinding = doc.bindings.find((b) => b.elementId === elementId) ?? null;

  const bindings = doc.bindings.filter((b) => b.elementId !== elementId);
  if (binding) bindings.push(binding);

  const elements = doc.elements.map((element) =>
    element.id === elementId && "bindingId" in element
      ? { ...element, bindingId: binding?.id }
      : element,
  );

  return {
    doc: { ...doc, elements, bindings },
    inverse: { type: "setBinding", elementId, binding: previousBinding },
  };
}

function applySetCombinedBindings(
  doc: MapDocument,
  elementId: string,
  bindings: MapBinding[],
): ApplyCommandResult {
  const previousBindings = doc.bindings.filter((b) => b.elementId === elementId);

  const rest = doc.bindings.filter((b) => b.elementId !== elementId);

  const elements = doc.elements.map((element) =>
    element.id === elementId && "bindingId" in element
      ? { ...element, bindingId: bindings[0]?.id }
      : element,
  );

  return {
    doc: { ...doc, elements, bindings: [...rest, ...bindings] },
    inverse: { type: "setCombinedBindings", elementId, bindings: previousBindings },
  };
}

function applyConnectTopology(doc: MapDocument, edge: TopologyEdge): ApplyCommandResult {
  return {
    doc: { ...doc, topology: { ...doc.topology, edges: [...doc.topology.edges, edge] } },
    inverse: { type: "disconnectTopology", edgeId: edge.id },
  };
}

function applyDisconnectTopology(doc: MapDocument, edgeId: string): ApplyCommandResult {
  const removed = doc.topology.edges.find((edge) => edge.id === edgeId);
  if (!removed) {
    throw new Error(`disconnectTopology: edge "${edgeId}" not found`);
  }
  return {
    doc: {
      ...doc,
      topology: { ...doc.topology, edges: doc.topology.edges.filter((edge) => edge.id !== edgeId) },
    },
    inverse: { type: "connectTopology", edge: removed },
  };
}

function applyReorderLayer(
  doc: MapDocument,
  layerId: string,
  newOrder: number,
): ApplyCommandResult {
  const target = doc.layers.find((layer) => layer.id === layerId);
  if (!target) {
    throw new Error(`reorderLayer: layer "${layerId}" not found`);
  }
  const previousOrder = target.order;

  const layers: Layer[] = doc.layers.map((layer) =>
    layer.id === layerId ? { ...layer, order: newOrder } : layer,
  );

  return {
    doc: { ...doc, layers },
    inverse: { type: "reorderLayer", layerId, newOrder: previousOrder },
  };
}

function applySetLayerProperty(
  doc: MapDocument,
  layerId: string,
  property: "name" | "visible" | "locked",
  value: unknown,
): ApplyCommandResult {
  const target = doc.layers.find((layer) => layer.id === layerId);
  if (!target) {
    throw new Error(`setLayerProperty: layer "${layerId}" not found`);
  }
  const previousValue = target[property];

  const layers: Layer[] = doc.layers.map((layer) =>
    layer.id === layerId ? { ...layer, [property]: value } : layer,
  );

  return {
    doc: { ...doc, layers },
    inverse: { type: "setLayerProperty", layerId, property, value: previousValue },
  };
}

/** Pure: applies one command to a document, returning the new document and the command that
 * exactly undoes it. Never mutates `doc`. */
export function applyCommand(doc: MapDocument, command: EditorCommand): ApplyCommandResult {
  switch (command.type) {
    case "addElement":
      return applyAddElement(doc, command.elements, command.bindings ?? []);
    case "deleteElements":
      return applyDeleteElements(doc, command.elementIds);
    case "moveElements":
      return applyMoveElements(doc, command.elementIds, command.dx, command.dy);
    case "resizeElement":
      return applyResizeElement(doc, command.elementId, command.width, command.height);
    case "setProperty":
      return applySetProperty(doc, command.elementId, command.property, command.value);
    case "patchElement":
      return applyPatchElement(doc, command.elementId, command.patch);
    case "renameElement":
      return applyRenameElement(doc, command.elementId, command.newId);
    case "setBinding":
      return applySetBinding(doc, command.elementId, command.binding);
    case "setCombinedBindings":
      return applySetCombinedBindings(doc, command.elementId, command.bindings);
    case "connectTopology":
      return applyConnectTopology(doc, command.edge);
    case "disconnectTopology":
      return applyDisconnectTopology(doc, command.edgeId);
    case "reorderLayer":
      return applyReorderLayer(doc, command.layerId, command.newOrder);
    case "setLayerProperty":
      return applySetLayerProperty(doc, command.layerId, command.property, command.value);
  }
}

export { hasPoints, hasPosition };
