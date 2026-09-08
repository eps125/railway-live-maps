import { useEffect, useRef, useState } from "react";
import { Stage, Layer, Line, Rect, Text, Circle, Group, Transformer } from "react-konva";
import Konva from "konva";
import {
  MAP_STYLE,
  berthRenderRect,
  sortElementsForPaint,
  type Layer as MapLayer,
  type MapElement,
} from "@railway/map-schema";
import { useEditorState, useEditorDispatch, type ToolMode } from "./EditorState.js";
import { snapSegmentAngle, weldToEndpoint } from "./geometrySnap.js";

/** Perpendicular distance from a point to a line segment — picks which segment of a polyline a
 * double-click lands on for vertex insertion (ADR 0005 E2). */
function distToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Fallback only, used for the first paint before ResizeObserver reports the real size of
// `.editor-canvas-frame` (apps/web/src/styles.css) — the stage itself always tracks that
// container's actual size, not a fixed constant, so it fills whatever space the surrounding
// layout gives it instead of sitting in a corner of it.
const FALLBACK_CANVAS_VIEW_WIDTH = 900;
const FALLBACK_CANVAS_VIEW_HEIGHT = 600;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const WHEEL_ZOOM_FACTOR = 1.05;

function snap(value: number, gridSize: number): number {
  return Math.round(value / gridSize) * gridSize;
}

function flattenPoints(points: Array<{ x: number; y: number }>): number[] {
  return points.flatMap((p) => [p.x, p.y]);
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A berth has a real width/height; every other positioned element (signal/label/boundary) is
 * point-shaped in the document, and a points-based element (trackPath/platform) has no single
 * x/y at all — each needs its own way of turning into a rubber-band-select-able rectangle. */
export function elementBounds(element: MapElement): Bounds | null {
  if ("points" in element) {
    if (element.points.length === 0) return null;
    const xs = element.points.map((p) => p.x);
    const ys = element.points.map((p) => p.y);
    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
  }
  if (element.type === "berth") {
    return {
      minX: element.x,
      minY: element.y,
      maxX: element.x + element.width,
      maxY: element.y + element.height,
    };
  }
  return { minX: element.x, minY: element.y, maxX: element.x, maxY: element.y };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function signalFill(symbolStyle: string): string {
  // Editor-only preview convention for the symbolStyle token itself (an editable document
  // field, not a computed aspect) — matches CLAUDE.md #9's blank/on/off vocabulary exactly.
  if (symbolStyle === "signal-on") return "#f85149";
  if (symbolStyle === "signal-off") return "#3fb950";
  return "#5f6b7a";
}

function nextElementId(): string {
  return `el-${Math.random().toString(36).slice(2, 10)}`;
}

// Element type -> a name pattern for the layer it conventionally belongs on. There's no formal
// "kind" on Layer (docs/MAP_EDITOR_SPEC.md leaves layers freeform/user-named), only the
// tracks-under-berths-under-signals-under-everything-else convention sortElementsForPaint's own
// doc comment describes — matched against here by name so a newly-placed element lands on the
// layer a human would expect instead of always the very first layer in the document regardless
// of tool. Real-world regression: a hand-authored map ended up with every berth/signal/label on
// its "Track" layer (doc.layers[0]) because this lookup didn't exist yet, making paint order
// between tracks and berths effectively arbitrary (whichever was added to the document later won).
const TOOL_LAYER_NAME_HINT: Partial<Record<ToolMode, RegExp>> = {
  berth: /berth/i,
  signal: /signal/i,
  label: /label/i,
  station: /label|station/i,
  trackPath: /track/i,
  platform: /platform/i,
  platformNumber: /platform/i,
  boundary: /track/i,
};

export function defaultLayerIdForTool(tool: ToolMode, layers: MapLayer[]): string | undefined {
  const hint = TOOL_LAYER_NAME_HINT[tool];
  const matched = hint ? layers.find((layer) => hint.test(layer.name)) : undefined;
  return (matched ?? layers[0])?.id;
}

function defaultElementForTool(
  tool: ToolMode,
  layerId: string,
  point: { x: number; y: number },
): MapElement | null {
  const id = nextElementId();
  switch (tool) {
    case "berth":
      return {
        id,
        layerId,
        zIndex: 0,
        type: "berth",
        x: point.x,
        y: point.y,
        width: 60,
        height: 24,
        textAlign: "center",
        fontSize: 12,
        displayName: "New berth",
      };
    case "signal":
      return {
        id,
        layerId,
        zIndex: 0,
        type: "signal",
        x: point.x,
        y: point.y,
        orientation: 0,
        symbolStyle: "signal-blank",
      };
    case "label":
      return {
        id,
        layerId,
        zIndex: 0,
        type: "label",
        x: point.x,
        y: point.y,
        text: "Label",
        align: "left",
        fontSize: 12,
      };
    case "boundary":
      return { id, layerId, zIndex: 0, type: "boundary", x: point.x, y: point.y, name: "Boundary" };
    case "station":
      return {
        id,
        layerId,
        zIndex: 0,
        type: "station",
        x: point.x,
        y: point.y,
        name: "New station",
        fontSize: 16,
      };
    case "trackPath":
      return {
        id,
        layerId,
        zIndex: 0,
        type: "trackPath",
        points: [
          { x: point.x, y: point.y },
          { x: point.x + 100, y: point.y },
        ],
      };
    case "platform":
      return {
        id,
        layerId,
        zIndex: 0,
        type: "platform",
        points: [
          { x: point.x, y: point.y },
          { x: point.x + 100, y: point.y },
        ],
      };
    case "platformNumber":
      // zIndex 1: paints above platform bars (zIndex 0) within the Platforms layer (ADR 0005 E3).
      return {
        id,
        layerId,
        zIndex: 1,
        type: "platformNumber",
        x: point.x,
        y: point.y,
        text: "1",
        fontSize: 10,
      };
    case "select":
    case "multiselect":
      // Multiselect places nothing on click — it's consumed by a drag (see
      // handleStageMouseDown/Move/Up's rubber-band-select handling), same as a plain click
      // with no drag distance doing nothing useful for it either.
      return null;
  }
}

/**
 * Milestone 11 editor canvas (docs/MAP_EDITOR_SPEC.md §6-7, §12: "Konva/react-konva for
 * selection, transforms and hit testing"). A second, Konva-based renderer alongside the public
 * SVG one (`apps/web/src/map/MapRenderer.tsx`) — CLAUDE.md rule 13 is about shared domain
 * model/state semantics, not shared rendering code, so this is a deliberate second
 * implementation, not a duplication of it.
 *
 * Scope for this pass: pan/zoom, grid, snap-to-grid placement and move, click/shift-click
 * selection, single-element resize (berth only, via Transformer). Deferred (see the M11/M12
 * plan's scope decision): 45°-constrained/magnetic track drawing, multi-point polyline drawing
 * beyond a two-point default segment, align/distribute, grouping.
 */
export interface EditorCanvasProps {
  /** Milestone 12 Test mode overlay (docs/MAP_EDITOR_SPEC.md §10): when set, a berth element's
   * displayed text is its simulated/live/historical description instead of its static
   * `displayName` — "the preview must use the same reducers/style semantics as the public
   * application." Keyed by element ID, matching the shape `GET /api/v1/editor/state/{slug}`
   * already returns. `undefined`/absent entries render the normal design-time `displayName`. */
  previewState?: Record<string, { description: string | null }> | undefined;
}

export function EditorCanvas({ previewState }: EditorCanvasProps = {}): JSX.Element {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const transformerRef = useRef<Konva.Transformer>(null);
  const nodeRefs = useRef(new Map<string, Konva.Node>());
  const containerRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({
    width: FALLBACK_CANVAS_VIEW_WIDTH,
    height: FALLBACK_CANVAS_VIEW_HEIGHT,
  });
  // Rubber-band select (Multiselect tool): world-space drag start/current-point while active,
  // null otherwise. Kept separate from the Stage's own draggable-when-Select pan (see the
  // `draggable={toolMode === "select"}` prop below) rather than folded into Select mode itself —
  // Select's empty-canvas drag is already how the canvas is panned, and there is no other pan
  // input (the wheel handler only zooms), so overloading that same drag for marquee-select would
  // remove panning rather than add a new capability.
  const [marquee, setMarquee] = useState<{
    start: { x: number; y: number };
    end: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      // Konva stages render nothing useful at 0×0 (e.g. mid-layout-shift) — keep the last good
      // size rather than collapsing the canvas.
      if (width > 0 && height > 0) {
        setStageSize({ width, height });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const { document: doc, selection, toolMode, viewport } = state;
  const gridSize = doc.map.canvas.gridSize;

  function toWorldPoint(stage: Konva.Stage): { x: number; y: number } {
    const pointer = stage.getPointerPosition();
    if (!pointer) return { x: 0, y: 0 };
    return {
      x: (pointer.x - viewport.x) / viewport.scale,
      y: (pointer.y - viewport.y) / viewport.scale,
    };
  }

  function handleWheel(e: Konva.KonvaEventObject<WheelEvent>): void {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const oldScale = viewport.scale;
    const mousePointTo = {
      x: (pointer.x - viewport.x) / oldScale,
      y: (pointer.y - viewport.y) / oldScale,
    };
    const rawScale = e.evt.deltaY < 0 ? oldScale * WHEEL_ZOOM_FACTOR : oldScale / WHEEL_ZOOM_FACTOR;
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, rawScale));

    dispatch({
      type: "setViewport",
      viewport: {
        scale: newScale,
        x: pointer.x - mousePointTo.x * newScale,
        y: pointer.y - mousePointTo.y * newScale,
      },
    });
  }

  function handleStageDragEnd(e: Konva.KonvaEventObject<DragEvent>): void {
    if (e.target !== e.target.getStage()) return;
    dispatch({ type: "setViewport", viewport: { ...viewport, x: e.target.x(), y: e.target.y() } });
  }

  function handleStageMouseDown(e: Konva.KonvaEventObject<MouseEvent>): void {
    if (toolMode !== "multiselect") return;
    const stage = e.target.getStage();
    if (!stage || e.target !== stage) return;
    const point = toWorldPoint(stage);
    setMarquee({ start: point, end: point });
  }

  function handleStageMouseMove(e: Konva.KonvaEventObject<MouseEvent>): void {
    if (!marquee) return;
    const stage = e.target.getStage();
    if (!stage) return;
    setMarquee({ ...marquee, end: toWorldPoint(stage) });
  }

  function handleStageMouseUp(e: Konva.KonvaEventObject<MouseEvent>): void {
    if (!marquee) return;
    const box: Bounds = {
      minX: Math.min(marquee.start.x, marquee.end.x),
      minY: Math.min(marquee.start.y, marquee.end.y),
      maxX: Math.max(marquee.start.x, marquee.end.x),
      maxY: Math.max(marquee.start.y, marquee.end.y),
    };
    const withinLockedLayer = new Set(doc.layers.filter((l) => l.locked).map((l) => l.id));
    const hit = doc.elements
      .filter((el) => !withinLockedLayer.has(el.layerId))
      .filter((el) => {
        const bounds = elementBounds(el);
        return bounds !== null && boundsIntersect(box, bounds);
      })
      .map((el) => el.id);

    const ids = e.evt.shiftKey ? [...new Set([...selection, ...hit])] : hit;
    dispatch({ type: "setSelection", ids });
    setMarquee(null);
    dispatch({ type: "setToolMode", mode: "select" });
  }

  function handleStageClick(e: Konva.KonvaEventObject<MouseEvent>): void {
    const stage = e.target.getStage();
    if (!stage) return;
    const clickedOnEmpty = e.target === stage;

    if (toolMode === "select") {
      if (clickedOnEmpty) dispatch({ type: "setSelection", ids: [] });
      return;
    }
    if (!clickedOnEmpty) return;

    const point = toWorldPoint(stage);
    const layerId = defaultLayerIdForTool(toolMode, doc.layers);
    if (!layerId) return;
    const element = defaultElementForTool(toolMode, layerId, {
      x: snap(point.x, gridSize),
      y: snap(point.y, gridSize),
    });
    if (!element) return;

    dispatch({ type: "dispatchCommand", command: { type: "addElement", elements: [element] } });
    dispatch({ type: "setSelection", ids: [element.id] });
    dispatch({ type: "setToolMode", mode: "select" });
  }

  function handleElementClick(e: Konva.KonvaEventObject<MouseEvent>, elementId: string): void {
    e.cancelBubble = true;
    if (toolMode !== "select") return;
    if (e.evt.shiftKey) {
      const already = selection.includes(elementId);
      dispatch({
        type: "setSelection",
        ids: already ? selection.filter((id) => id !== elementId) : [...selection, elementId],
      });
    } else {
      dispatch({ type: "setSelection", ids: [elementId] });
    }
  }

  /** Position-based elements (berth/signal/label/boundary) are Groups positioned at (x,y) —
   * dragend gives the new absolute position directly. */
  function handlePositionedDragEnd(e: Konva.KonvaEventObject<DragEvent>, elementId: string): void {
    const element = doc.elements.find((el) => el.id === elementId);
    if (!element || !("x" in element)) return;
    const newX = snap(e.target.x(), gridSize);
    const newY = snap(e.target.y(), gridSize);
    const dx = newX - element.x;
    const dy = newY - element.y;
    e.target.position({ x: element.x, y: element.y });
    if (dx === 0 && dy === 0) return;
    const idsToMove =
      selection.includes(elementId) && selection.length > 1 ? selection : [elementId];
    dispatch({
      type: "dispatchCommand",
      command: { type: "moveElements", elementIds: idsToMove, dx, dy },
    });
  }

  /** Points-based elements (trackPath/platform) render at node (0,0) with absolute points —
   * dragging accumulates an offset in the node's own x/y, which *is* the dx/dy to apply. */
  function handlePathDragEnd(e: Konva.KonvaEventObject<DragEvent>, elementId: string): void {
    const dx = snap(e.target.x(), gridSize);
    const dy = snap(e.target.y(), gridSize);
    e.target.position({ x: 0, y: 0 });
    if (dx === 0 && dy === 0) return;
    dispatch({
      type: "dispatchCommand",
      command: { type: "moveElements", elementIds: [elementId], dx, dy },
    });
  }

  /** Per-endpoint drag handle for a selected trackPath/platform — the only way to lengthen,
   * shorten or re-angle a segment (there's no Transformer-style resize for points-based
   * elements). Rewrites just the dragged point and pushes the whole array through `setProperty`,
   * so undo/redo gets one step per drag. For `trackPath` (ADR 0005 E1) the raw drop is first
   * angle-snapped to `{0°, ±1:2, ±1:1, 90°}` about the neighbouring vertex (Alt bypasses), then
   * — for an endpoint — magnetically welded onto a nearby other-track endpoint; a welded pair is
   * given a shared synthetic `topologyEdgeId` so the publish-time weld (ADR 0004 D2) merges
   * them. */
  function handlePointDragEnd(
    e: Konva.KonvaEventObject<DragEvent>,
    elementId: string,
    pointIndex: number,
    points: Array<{ x: number; y: number }>,
  ): void {
    const element = doc.elements.find((el) => el.id === elementId);
    if (!element || !("points" in element)) return;
    const isTrack = element.type === "trackPath";
    const isEndpoint = pointIndex === 0 || pointIndex === points.length - 1;

    let px = e.target.x();
    let py = e.target.y();
    let weldPartnerId: string | undefined;

    if (isTrack && isEndpoint) {
      const others = doc.elements.filter(
        (el): el is Extract<MapElement, { type: "trackPath" }> =>
          el.type === "trackPath" && el.id !== elementId,
      );
      const ends = others.flatMap((t) => [t.points[0]!, t.points[t.points.length - 1]!]);
      const welded = weldToEndpoint({ x: px, y: py }, ends);
      if (welded) {
        px = welded.x;
        py = welded.y;
        weldPartnerId = others.find((t) =>
          [t.points[0]!, t.points[t.points.length - 1]!].some(
            (pt) => Math.hypot(pt.x - px, pt.y - py) < 1e-6,
          ),
        )?.id;
      }
    }

    if (!weldPartnerId) {
      if (isTrack && !e.evt.altKey) {
        const anchor = points[pointIndex - 1] ?? points[pointIndex + 1];
        if (anchor) {
          const s = snapSegmentAngle(anchor, { x: px, y: py });
          px = s.x;
          py = s.y;
        }
      }
      px = snap(px, gridSize);
      py = snap(py, gridSize);
    }

    e.target.position({ x: points[pointIndex]!.x, y: points[pointIndex]!.y });
    const moved = px !== points[pointIndex]!.x || py !== points[pointIndex]!.y;
    if (!moved && !weldPartnerId) return;

    if (moved) {
      const newPoints = points.map((p, i) => (i === pointIndex ? { x: px, y: py } : p));
      dispatch({
        type: "dispatchCommand",
        command: { type: "setProperty", elementId, property: "points", value: newPoints },
      });
    }

    if (weldPartnerId) {
      const self = element as Extract<MapElement, { type: "trackPath" }>;
      const partner = doc.elements.find((el) => el.id === weldPartnerId) as
        Extract<MapElement, { type: "trackPath" }> | undefined;
      const shared =
        self.topologyEdgeId ??
        partner?.topologyEdgeId ??
        `weld-${Math.random().toString(36).slice(2, 8)}`;
      if (self.topologyEdgeId !== shared) {
        dispatch({
          type: "dispatchCommand",
          command: { type: "setProperty", elementId, property: "topologyEdgeId", value: shared },
        });
      }
      if (partner && partner.topologyEdgeId !== shared) {
        dispatch({
          type: "dispatchCommand",
          command: {
            type: "setProperty",
            elementId: weldPartnerId,
            property: "topologyEdgeId",
            value: shared,
          },
        });
      }
    }
  }

  /** ADR 0005 E2: double-click a track/platform segment to insert a grid-snapped vertex on the
   * nearest segment; double-click an existing vertex handle to remove it (kept ≥ 2 points). */
  function handleInsertVertex(e: Konva.KonvaEventObject<MouseEvent>, elementId: string): void {
    const element = doc.elements.find((el) => el.id === elementId);
    if (!element || !("points" in element)) return;
    const stage = e.target.getStage();
    if (!stage) return;
    const world = toWorldPoint(stage);
    const p = { x: snap(world.x, gridSize), y: snap(world.y, gridSize) };
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < element.points.length - 1; i += 1) {
      const d = distToSegment(p, element.points[i]!, element.points[i + 1]!);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const newPoints = [
      ...element.points.slice(0, bestIdx + 1),
      p,
      ...element.points.slice(bestIdx + 1),
    ];
    dispatch({
      type: "dispatchCommand",
      command: { type: "setProperty", elementId, property: "points", value: newPoints },
    });
  }

  function handleRemoveVertex(
    e: Konva.KonvaEventObject<MouseEvent>,
    elementId: string,
    pointIndex: number,
  ): void {
    e.cancelBubble = true;
    const element = doc.elements.find((el) => el.id === elementId);
    if (!element || !("points" in element) || element.points.length <= 2) return;
    const newPoints = element.points.filter((_, i) => i !== pointIndex);
    dispatch({
      type: "dispatchCommand",
      command: { type: "setProperty", elementId, property: "points", value: newPoints },
    });
  }

  function handleTransformEnd(elementId: string): void {
    const node = nodeRefs.current.get(elementId);
    const element = doc.elements.find((el) => el.id === elementId);
    if (!node || !element || !("width" in element)) return;
    const width = Math.max(
      gridSize,
      Math.round((element.width * node.scaleX()) / gridSize) * gridSize,
    );
    const height = Math.max(
      gridSize,
      Math.round((element.height * node.scaleY()) / gridSize) * gridSize,
    );
    node.scaleX(1);
    node.scaleY(1);
    dispatch({
      type: "dispatchCommand",
      command: { type: "resizeElement", elementId, width, height },
    });
  }

  const selectedBerthId =
    selection.length === 1 && doc.elements.find((el) => el.id === selection[0])?.type === "berth"
      ? selection[0]
      : null;

  // The grid/background follow wherever the viewport currently is, rather than a document-level
  // canvas.width/height boundary — panning left or right always uncovers more usable space,
  // never runs off the edge of a pre-set canvas size. `canvas.{width,height}` in the document
  // still exists (packages/map-schema/src/document.ts) but is now purely a publish-time value,
  // recomputed to fit the real element bounding box when the map is published (see
  // MapEditorApp/the publish flow) — it's not consulted for rendering here at all anymore.
  // Padded to 3x the visible area (1x on each side) so a single continuous drag-pan gesture
  // doesn't visibly outrun the grid before `handleStageDragEnd` commits the new viewport and
  // this recomputes — Konva moves already-rendered children with the stage's own transform
  // during a drag with no React re-render needed, only the *extent* of what's rendered depends
  // on viewport state being current.
  const visibleWorld = {
    minX: -viewport.x / viewport.scale,
    minY: -viewport.y / viewport.scale,
    maxX: (stageSize.width - viewport.x) / viewport.scale,
    maxY: (stageSize.height - viewport.y) / viewport.scale,
  };
  const padX = visibleWorld.maxX - visibleWorld.minX;
  const padY = visibleWorld.maxY - visibleWorld.minY;
  const gridMinX = snap(visibleWorld.minX - padX, gridSize);
  const gridMaxX = snap(visibleWorld.maxX + padX, gridSize);
  const gridMinY = snap(visibleWorld.minY - padY, gridSize);
  const gridMaxY = snap(visibleWorld.maxY + padY, gridSize);

  const gridLines: JSX.Element[] = [];
  for (let x = gridMinX; x <= gridMaxX; x += gridSize) {
    gridLines.push(
      <Line key={`gx-${x}`} points={[x, gridMinY, x, gridMaxY]} stroke="#1c2430" strokeWidth={1} />,
    );
  }
  for (let y = gridMinY; y <= gridMaxY; y += gridSize) {
    gridLines.push(
      <Line key={`gy-${y}`} points={[gridMinX, y, gridMaxX, y]} stroke="#1c2430" strokeWidth={1} />,
    );
  }

  // A single flat, globally-ordered list — not one Konva Group per layer — because zIndex is a
  // full override on top of the default layer stacking (e.g. sinking a signal below a berth on
  // a different layer), and Konva always paints an earlier Group's children before a later
  // Group's regardless of any per-element key, so per-layer Groups can't express a cross-layer
  // override. sortElementsForPaint (packages/map-schema) is the single shared source of truth
  // for this ordering, also used by the compiler for the published bundle the public renderer
  // consumes — see docs there for the layer-order/zIndex band math.
  const layersById = new Map(doc.layers.map((layer) => [layer.id, layer]));
  const elementsMap = new Map(doc.elements.map((element) => [element.id, element]));
  const paintOrderedElements = sortElementsForPaint(
    doc.elements.filter((element) => layersById.get(element.layerId)?.visible ?? false),
    doc.layers,
  );

  return (
    <div ref={containerRef} className="editor-canvas-measure">
      <Stage
        width={stageSize.width}
        height={stageSize.height}
        x={viewport.x}
        y={viewport.y}
        scaleX={viewport.scale}
        scaleY={viewport.scale}
        draggable={toolMode === "select"}
        onWheel={handleWheel}
        onDragEnd={handleStageDragEnd}
        onClick={handleStageClick}
        onMouseDown={handleStageMouseDown}
        onMouseMove={handleStageMouseMove}
        onMouseUp={handleStageMouseUp}
      >
        <Layer listening={false}>
          <Rect
            x={gridMinX}
            y={gridMinY}
            width={gridMaxX - gridMinX}
            height={gridMaxY - gridMinY}
            fill="#0d1117"
          />
          {gridLines}
        </Layer>
        <Layer>
          {paintOrderedElements.map((element) => {
            const layer = layersById.get(element.layerId)!;
            const selected = selection.includes(element.id);
            const draggable = toolMode === "select" && !layer.locked;
            const setRef = (node: Konva.Node | null): void => {
              if (node) nodeRefs.current.set(element.id, node);
              else nodeRefs.current.delete(element.id);
            };

            if (element.type === "trackPath") {
              return (
                <Group key={element.id}>
                  <Line
                    ref={setRef}
                    points={flattenPoints(element.points)}
                    stroke={selected ? "#58a6ff" : "#5f6b7a"}
                    strokeWidth={selected ? 3 : 2}
                    hitStrokeWidth={16}
                    draggable={draggable}
                    onClick={(e) => handleElementClick(e, element.id)}
                    onDblClick={(e) => handleInsertVertex(e, element.id)}
                    onDragEnd={(e) => handlePathDragEnd(e, element.id)}
                  />
                  {selected && draggable
                    ? element.points.map((point, index) => (
                        <Circle
                          key={index}
                          x={point.x}
                          y={point.y}
                          radius={5}
                          fill="#0d1117"
                          stroke="#58a6ff"
                          strokeWidth={2}
                          draggable
                          onDblClick={(e) => handleRemoveVertex(e, element.id, index)}
                          onDragEnd={(e) =>
                            handlePointDragEnd(e, element.id, index, element.points)
                          }
                        />
                      ))
                    : null}
                </Group>
              );
            }
            if (element.type === "platform") {
              // ADR 0004 D6: orange bar (matches the public renderer's filled rect) instead of
              // the old grey line; keeps the points-based drag/reshape mechanics.
              const px = element.points.map((p) => p.x);
              const py = element.points.map((p) => p.y);
              return (
                <Group key={element.id}>
                  <Line
                    ref={setRef}
                    points={flattenPoints(element.points)}
                    stroke={selected ? "#58a6ff" : MAP_STYLE.platform.color}
                    strokeWidth={
                      selected ? MAP_STYLE.platform.height + 2 : MAP_STYLE.platform.height
                    }
                    hitStrokeWidth={16}
                    lineCap="butt"
                    lineJoin="round"
                    draggable={draggable}
                    onClick={(e) => handleElementClick(e, element.id)}
                    onDblClick={(e) => handleInsertVertex(e, element.id)}
                    onDragEnd={(e) => handlePathDragEnd(e, element.id)}
                  />
                  {element.number ? (
                    <Text
                      text={element.number}
                      x={Math.min(...px)}
                      y={(Math.min(...py) + Math.max(...py)) / 2 - 5}
                      fontSize={10}
                      fontStyle="bold"
                      fill="#04101f"
                      listening={false}
                    />
                  ) : null}
                  {selected && draggable
                    ? element.points.map((point, index) => (
                        <Circle
                          key={index}
                          x={point.x}
                          y={point.y}
                          radius={5}
                          fill="#0d1117"
                          stroke="#58a6ff"
                          strokeWidth={2}
                          draggable
                          onDblClick={(e) => handleRemoveVertex(e, element.id, index)}
                          onDragEnd={(e) =>
                            handlePointDragEnd(e, element.id, index, element.points)
                          }
                        />
                      ))
                    : null}
                </Group>
              );
            }
            if (element.type === "platformNumber") {
              const box = MAP_STYLE.platform.numberBox;
              return (
                <Group
                  key={element.id}
                  ref={setRef}
                  x={element.x}
                  y={element.y}
                  draggable={draggable}
                  onClick={(e) => handleElementClick(e, element.id)}
                  onDragEnd={(e) => handlePositionedDragEnd(e, element.id)}
                >
                  <Rect
                    x={-box / 2}
                    y={-box / 2}
                    width={box}
                    height={box}
                    fill="#ffffff"
                    stroke={selected ? "#58a6ff" : "#2d3644"}
                    strokeWidth={1}
                  />
                  <Text
                    text={element.text}
                    x={-box / 2}
                    y={-box / 2}
                    width={box}
                    height={box}
                    align="center"
                    verticalAlign="middle"
                    fontSize={element.fontSize}
                    fontStyle="bold"
                    fill="#04101f"
                    listening={false}
                  />
                </Group>
              );
            }
            if (element.type === "berth") {
              const overlay = previewState?.[element.id];
              const occupied = overlay !== undefined && overlay.description !== null;
              // ADR 0004 D1: the box is drawn centred on its bound track. The Group stays at the
              // authored x/y (so drag + Transformer resize math is unchanged); `yOffset` is a
              // purely visual nudge of the Rect/Text inside it.
              const centred = berthRenderRect(element, elementsMap);
              const yOffset = centred.y - element.y;
              return (
                <Group
                  key={element.id}
                  ref={setRef}
                  x={element.x}
                  y={element.y}
                  draggable={draggable}
                  onClick={(e) => handleElementClick(e, element.id)}
                  onDragEnd={(e) => handlePositionedDragEnd(e, element.id)}
                  onTransformEnd={() => handleTransformEnd(element.id)}
                >
                  <Rect
                    y={yOffset}
                    width={element.width}
                    height={element.height}
                    fill={occupied ? "#d29922" : selected ? "#233044" : "#161d27"}
                    stroke={selected ? "#58a6ff" : "#2d3644"}
                    strokeWidth={selected ? 2 : 1}
                    cornerRadius={2}
                  />
                  <Text
                    y={yOffset}
                    text={overlay ? (overlay.description ?? "") : element.displayName}
                    width={element.width}
                    height={element.height}
                    align={element.textAlign}
                    verticalAlign="middle"
                    fontSize={element.fontSize}
                    fontFamily="ui-monospace, 'Roboto Mono', Consolas, monospace"
                    fill={occupied ? "#04101f" : "#e6edf3"}
                  />
                </Group>
              );
            }
            if (element.type === "signal") {
              // ADR 0005 E4: `offset` draws a stem out to a head set off the track; `inline` is
              // today's on-track circle. Side from `orientation` (>=90 && <270 -> above).
              const offsetMode = element.renderMode === "offset";
              const dir = element.orientation >= 90 && element.orientation < 270 ? -1 : 1;
              const hy = offsetMode ? dir * MAP_STYLE.signal.offset : 0;
              return (
                <Group
                  key={element.id}
                  ref={setRef}
                  x={element.x}
                  y={element.y}
                  draggable={draggable}
                  onClick={(e) => handleElementClick(e, element.id)}
                  onDragEnd={(e) => handlePositionedDragEnd(e, element.id)}
                >
                  {offsetMode ? (
                    <Line points={[0, 0, 0, hy]} stroke="#8b949e" strokeWidth={2} />
                  ) : null}
                  <Circle
                    y={hy}
                    radius={MAP_STYLE.signal.radius}
                    fill={signalFill(element.symbolStyle)}
                    stroke={selected ? "#58a6ff" : "#2d3644"}
                    strokeWidth={selected ? 2 : 1}
                  />
                  {element.label ? (
                    <Text
                      text={element.label}
                      x={offsetMode ? -20 : 12}
                      y={hy + (offsetMode ? dir * (MAP_STYLE.signal.radius + 4) - 5 : 0)}
                      width={40}
                      align={offsetMode ? "center" : "left"}
                      fontSize={10}
                      fill="#8b96a5"
                    />
                  ) : null}
                </Group>
              );
            }
            if (element.type === "label") {
              return (
                <Text
                  key={element.id}
                  ref={setRef}
                  x={element.x}
                  y={element.y}
                  text={element.text}
                  fontSize={element.fontSize}
                  align={element.align}
                  fill={selected ? "#58a6ff" : "#c9d3de"}
                  draggable={draggable}
                  onClick={(e) => handleElementClick(e, element.id)}
                  onDragEnd={(e) => handlePositionedDragEnd(e, element.id)}
                />
              );
            }
            if (element.type === "station") {
              return (
                <Text
                  key={element.id}
                  ref={setRef}
                  x={element.x}
                  y={element.y}
                  text={element.crs ? `${element.name} [${element.crs}]` : element.name}
                  fontSize={element.fontSize}
                  fontStyle="bold"
                  fill={selected ? "#58a6ff" : "#4c8fd6"}
                  draggable={draggable}
                  onClick={(e) => handleElementClick(e, element.id)}
                  onDragEnd={(e) => handlePositionedDragEnd(e, element.id)}
                />
              );
            }
            // boundary
            return (
              <Group
                key={element.id}
                ref={setRef}
                x={element.x}
                y={element.y}
                draggable={draggable}
                onClick={(e) => handleElementClick(e, element.id)}
                onDragEnd={(e) => handlePositionedDragEnd(e, element.id)}
              >
                <Circle radius={6} fill="#f59e0b" stroke={selected ? "#58a6ff" : "#2d3644"} />
                <Text text={element.name} y={9} fontSize={10} fill="#8b96a5" />
              </Group>
            );
          })}
          {selectedBerthId ? (
            <Transformer
              ref={transformerRef}
              nodes={
                nodeRefs.current.has(selectedBerthId)
                  ? [nodeRefs.current.get(selectedBerthId)!]
                  : []
              }
              rotateEnabled={false}
            />
          ) : null}
          {marquee ? (
            <Rect
              x={Math.min(marquee.start.x, marquee.end.x)}
              y={Math.min(marquee.start.y, marquee.end.y)}
              width={Math.abs(marquee.end.x - marquee.start.x)}
              height={Math.abs(marquee.end.y - marquee.start.y)}
              fill="rgba(88, 166, 255, 0.15)"
              stroke="#58a6ff"
              strokeWidth={1 / viewport.scale}
              listening={false}
            />
          ) : null}
        </Layer>
      </Stage>
    </div>
  );
}
