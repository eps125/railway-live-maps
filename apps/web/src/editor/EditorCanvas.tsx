import { useEffect, useRef, useState } from "react";
import { Stage, Layer, Line, Rect, Text, Circle, Group, Transformer } from "react-konva";
import Konva from "konva";
import {
  MAP_STYLE,
  berthRenderRect,
  computeBoundingBox,
  levelCrossingGeometry,
  neutralSectionGeometry,
  placedLabelAnchor,
  pointsBounds,
  viaductWidth,
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

/** Element/tool types the author positions at half the map grid step rather than on it: a
 * platform's outline (so a shape's width can sit between grid lines, ADR 0005 rev.), a platform
 * number, and — owner request 2026-09-20 — a neutral section sign and its detached label, which
 * are small enough that a full grid square is a coarse jump. Everything else stays on the grid. */
/** Points-based types whose `points` are a closed outline rather than an open polyline. Drives
 * the wrap-edge vertex insertion, the minimum vertex count, and `closed` on the rendered shape.
 * Structural rather than a list of one, because Milestone 55 added two more (tunnel/water) and
 * every place that hardcoded `=== "platform"` silently excluded them. */
const POLYGON_TYPES = new Set(["platform", "tunnel", "water"]);

function isClosedShape(type: string, pointCount: number): boolean {
  return POLYGON_TYPES.has(type) && pointCount >= 3;
}

const HALF_GRID_TYPES = new Set([
  "platform",
  "platformNumber",
  "neutralSection",
  // Milestone 55: scenery is traced over real features rather than aligned to the grid, so
  // it wants the finer step for the same reason a platform outline does.
  "tunnel",
  "viaduct",
  "water",
  "levelCrossing",
]);

export function snapStep(type: string | undefined, gridSize: number): number {
  return type !== undefined && HALF_GRID_TYPES.has(type) ? Math.max(1, gridSize / 2) : gridSize;
}

function flattenPoints(points: Array<{ x: number; y: number }>): number[] {
  return points.flatMap((p) => [p.x, p.y]);
}

/** Konva `Text` props that reproduce the public SVG renderer's `x`/`y` + `textAnchor` +
 * alphabetic-baseline placement, so a station / label sits in the same spot in the editor as
 * in the live map (CLAUDE.md rule 13). Konva anchors a Text at its top-left; SVG at the
 * baseline with `text-anchor` — so offset ~0.8·fontSize vertically, and for centre/right use a
 * fixed box width. `x`/`y` stay the authored coords so drag maths is unchanged. */
export function anchoredText(
  x: number,
  y: number,
  fontSize: number,
  align: "left" | "center" | "right",
): {
  x: number;
  y: number;
  offsetY: number;
  width?: number;
  align?: "center" | "right";
  offsetX?: number;
} {
  const offsetY = fontSize * 0.8;
  const w = 260;
  if (align === "center") return { x, y, offsetY, width: w, align: "center", offsetX: w / 2 };
  if (align === "right") return { x, y, offsetY, width: w, align: "right", offsetX: w };
  return { x, y, offsetY };
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
  if (element.type === "levelCrossing") {
    const { bounds } = levelCrossingGeometry(element);
    return {
      minX: bounds.x,
      minY: bounds.y,
      maxX: bounds.x + bounds.width,
      maxY: bounds.y + bounds.height,
    };
  }
  // A neutral section is the one point-anchored element with a real drawn size, and its x/y is
  // the board's *centre* — so rubber-band select uses the board itself rather than a zero-sized
  // point that only catches the exact middle of a visibly large symbol.
  if (element.type === "neutralSection") {
    const half = element.size / 2;
    return {
      minX: element.x - half,
      minY: element.y - half,
      maxX: element.x + half,
      maxY: element.y + half,
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
  if (symbolStyle === "signal-on") return MAP_STYLE.signal.stateColors.on;
  if (symbolStyle === "signal-off") return MAP_STYLE.signal.stateColors.off;
  return MAP_STYLE.signal.stateColors.blank;
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
  // No dedicated lineside-feature layer exists in the conventional stack (and adding one to
  // `blankDocument` would leave every already-drafted map without it, falling back to Track),
  // so a sign lands on Labels — the "everything else" layer, on top, which is where it belongs
  // visually anyway. A dedicated layer is a later option once the family has more members.
  neutralSection: /label/i,
  // Milestone 55: a fresh map gets a "Scenery" layer below Track (draftStore.ts); an already
  // drafted map has no layer under Track at all, so these fall back to layers[0] and rely on
  // their default `zIndex: -1` to sink below the rails within whatever layer they land on. A
  // viaduct deliberately belongs with the track it carries (owner: "same layer as track").
  tunnel: /scenery|terrain/i,
  water: /scenery|terrain|water/i,
  viaduct: /track/i,
  // A crossing sits on the railway it crosses, so it belongs with the track rather than in
  // scenery; it paints above the rails (default zIndex 0) because the road crosses over them.
  levelCrossing: /track/i,
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
    case "neutralSection":
      return {
        id,
        layerId,
        zIndex: 0,
        type: "neutralSection",
        // x/y is the board's centre, so place it exactly where the author clicked.
        x: point.x,
        y: point.y,
        size: MAP_STYLE.neutralSection.size,
        labelPosition: "below",
        fontSize: 10,
      };
    case "tunnel":
      // zIndex -1: paints below the rails within its own layer (sortElementsForPaint's "small
      // nudge reorders within the layer"), which is what makes "below the track" true even on a
      // map whose layer stack has nothing under Track.
      return {
        id,
        layerId,
        zIndex: -1,
        type: "tunnel",
        points: [
          { x: point.x, y: point.y - MAP_STYLE.rowPitch / 2 },
          { x: point.x + 160, y: point.y - MAP_STYLE.rowPitch / 2 },
          { x: point.x + 160, y: point.y + MAP_STYLE.rowPitch / 2 },
          { x: point.x, y: point.y + MAP_STYLE.rowPitch / 2 },
        ],
        labelPosition: "below",
        fontSize: MAP_STYLE.placedLabel.fontSize,
      };
    case "water":
      return {
        id,
        layerId,
        zIndex: -1,
        type: "water",
        // A starting box across the track, for the common perpendicular river; reshape with the
        // vertex tools exactly like a platform.
        points: [
          { x: point.x - 20, y: point.y - 60 },
          { x: point.x + 20, y: point.y - 60 },
          { x: point.x + 20, y: point.y + 60 },
          { x: point.x - 20, y: point.y + 60 },
        ],
        labelPosition: "below",
        fontSize: MAP_STYLE.placedLabel.fontSize,
      };
    case "viaduct":
      return {
        id,
        layerId,
        zIndex: -1,
        type: "viaduct",
        points: [
          { x: point.x, y: point.y },
          { x: point.x + 160, y: point.y },
        ],
        width: MAP_STYLE.track.strokeWidth + MAP_STYLE.viaduct.extraWidth,
        labelPosition: "below",
        fontSize: MAP_STYLE.placedLabel.fontSize,
      };
    case "levelCrossing":
      return {
        id,
        layerId,
        zIndex: 0,
        type: "levelCrossing",
        x: point.x,
        y: point.y,
        orientation: 0,
        roadLength: MAP_STYLE.levelCrossing.roadLength,
        roadWidth: MAP_STYLE.levelCrossing.roadWidth,
        labelPosition: "below",
        fontSize: MAP_STYLE.placedLabel.fontSize,
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
      // A filled rectangle to start (ADR 0005 rev.) — reshape it with the vertex tools.
      return {
        id,
        layerId,
        zIndex: 0,
        type: "platform",
        points: [
          { x: point.x, y: point.y },
          { x: point.x + 120, y: point.y },
          { x: point.x + 120, y: point.y + MAP_STYLE.platform.height },
          { x: point.x, y: point.y + MAP_STYLE.platform.height },
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
  /** Milestone 36c: live state of each *bound* signal (`useLiveSignalStates`), shown in every
   * view so a wrong S-Class address/bit is obvious while authoring. A bound signal draws its live
   * state with the public renderer's colours (rule 13) and a dashed ring marking it as live;
   * unbound signals keep their static `symbolStyle` preview. */
  signalStates?: Record<string, "blank" | "on" | "off"> | undefined;
}

export function EditorCanvas({ previewState, signalStates }: EditorCanvasProps = {}): JSX.Element {
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

  // Fit the initial view to the document's content, once, the same way the public renderer
  // does (`MapRenderer.tsx` derives its viewBox from `bundle.boundingBox`). Without this the
  // editor opened at (0,0)/scale-1 while the live map was fit-to-bounds, so the same map looked
  // like it was "in a different place" / a different size in the two views.
  const didFitRef = useRef(false);
  useEffect(() => {
    if (didFitRef.current) return;
    if (stageSize.width < 2 || stageSize.height < 2) return;
    // If something already moved the viewport (a restored draft, a prior fit), don't fight it.
    if (viewport.x !== 0 || viewport.y !== 0 || viewport.scale !== 1) {
      didFitRef.current = true;
      return;
    }
    const bb = computeBoundingBox(doc.elements);
    if (!(bb.maxX > bb.minX) || !(bb.maxY > bb.minY)) {
      didFitRef.current = true;
      return;
    }
    const pad = 60;
    const scale = Math.max(
      MIN_SCALE,
      Math.min(
        MAX_SCALE,
        stageSize.width / (bb.maxX - bb.minX + pad * 2),
        stageSize.height / (bb.maxY - bb.minY + pad * 2),
      ),
    );
    const cx = (bb.minX + bb.maxX) / 2;
    const cy = (bb.minY + bb.maxY) / 2;
    dispatch({
      type: "setViewport",
      viewport: {
        scale,
        x: stageSize.width / 2 - cx * scale,
        y: stageSize.height / 2 - cy * scale,
      },
    });
    didFitRef.current = true;
  }, [stageSize, viewport, doc.elements, dispatch]);

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
    const placeStep = snapStep(toolMode, gridSize);
    const element = defaultElementForTool(toolMode, layerId, {
      x: snap(point.x, placeStep),
      y: snap(point.y, placeStep),
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
    const step = snapStep(element.type, gridSize);
    const newX = snap(e.target.x(), step);
    const newY = snap(e.target.y(), step);
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

  /**
   * Owner request 2026-09-20: a *detached* neutral-section label is dragged on its own, inside
   * the sign's Group, so the node's local x/y already is the offset from the board centre that
   * `labelOffset` stores. Konva gives a draggable child priority over its draggable parent, so
   * grabbing the label moves only the label and grabbing the board still moves the whole sign.
   */
  function commitLabelOffset(
    elementId: string,
    next: { x: number; y: number },
    current: { x: number; y: number },
  ): void {
    if (next.x === current.x && next.y === current.y) return;
    dispatch({
      type: "dispatchCommand",
      command: { type: "setProperty", elementId, property: "labelOffset", value: next },
    });
  }

  /** A neutral section's label lives *inside* the sign's Group, so the node's local x/y already
   * is the offset from the board centre that `labelOffset` stores. */
  function handleLabelDragEnd(e: Konva.KonvaEventObject<DragEvent>, elementId: string): void {
    const element = doc.elements.find((el) => el.id === elementId);
    if (!element || !("labelOffset" in element) || !element.labelOffset) return;
    const step = snapStep(element.type, gridSize);
    const next = { x: snap(e.target.x(), step), y: snap(e.target.y(), step) };
    // Snap the node back to the stored value either way, so a sub-step drag doesn't leave the
    // rendered label off its committed offset (same discipline as handlePositionedDragEnd).
    e.target.position(element.labelOffset);
    commitLabelOffset(elementId, next, element.labelOffset);
  }

  /** Milestone 55: a points-based shape (tunnel/viaduct/water) draws at absolute coordinates, so
   * its label node's x/y is absolute too — the stored offset is measured from the centre of the
   * shape's own bounds, which is what `placedLabelAnchor` resolves against. */
  function handleShapeLabelDragEnd(e: Konva.KonvaEventObject<DragEvent>, elementId: string): void {
    const element = doc.elements.find((el) => el.id === elementId);
    if (!element || !("points" in element) || !("labelOffset" in element)) return;
    if (!element.labelOffset) return;
    const bounds = pointsBounds(element.points);
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const step = snapStep(element.type, gridSize);
    const next = {
      x: snap(e.target.x() - cx, step),
      y: snap(e.target.y() - cy, step),
    };
    e.target.position({ x: cx + element.labelOffset.x, y: cy + element.labelOffset.y });
    commitLabelOffset(elementId, next, element.labelOffset);
  }

  /** Points-based elements (trackPath/platform) render at node (0,0) with absolute points —
   * dragging accumulates an offset in the node's own x/y, which *is* the dx/dy to apply. */
  function handlePathDragEnd(e: Konva.KonvaEventObject<DragEvent>, elementId: string): void {
    const moving = doc.elements.find((el) => el.id === elementId);
    const step = moving?.type === "platform" ? Math.max(1, gridSize / 2) : gridSize;
    const dx = snap(e.target.x(), step);
    const dy = snap(e.target.y(), step);
    e.target.position({ x: 0, y: 0 });
    if (dx === 0 && dy === 0) return;
    // Mirror handlePositionedDragEnd: dragging one element of a larger active selection moves
    // the whole (possibly mixed-type — berths, signals, other tracks, ...) group together in
    // one undo step, not just this trackPath/platform on its own.
    const idsToMove =
      selection.includes(elementId) && selection.length > 1 ? selection : [elementId];
    dispatch({
      type: "dispatchCommand",
      command: { type: "moveElements", elementIds: idsToMove, dx, dy },
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
    // Platform corners snap to half the grid step so a shape's width can sit between grid lines
    // (ADR 0005 rev.); tracks and everything else stay on the full grid.
    const step = snapStep(element.type, gridSize);

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
      const anchor =
        isTrack && !e.evt.altKey ? (points[pointIndex - 1] ?? points[pointIndex + 1]) : undefined;
      if (anchor) {
        // Keep the exact standard angle (snapSegmentAngle always snaps now); quantise the
        // distance along that ray to the grid rather than grid-snapping x and y independently,
        // which would pull the point back off the angle.
        const s = snapSegmentAngle(anchor, { x: px, y: py });
        const rdx = s.x - anchor.x;
        const rdy = s.y - anchor.y;
        const rlen = Math.hypot(rdx, rdy);
        if (rlen > 0) {
          const qlen = Math.max(gridSize, Math.round(rlen / gridSize) * gridSize);
          px = Math.round((anchor.x + (rdx / rlen) * qlen) * 2) / 2;
          py = Math.round((anchor.y + (rdy / rlen) * qlen) * 2) / 2;
        } else {
          px = s.x;
          py = s.y;
        }
      } else {
        px = snap(px, step);
        py = snap(py, step);
      }
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
    const vStep = snapStep(element.type, gridSize);
    const p = { x: snap(world.x, vStep), y: snap(world.y, vStep) };
    // A platform with 3+ points is a closed polygon, so the wrap edge (last → first) is also a
    // candidate for insertion; a trackPath is an open polyline.
    const closed = isClosedShape(element.type, element.points.length);
    const lastSeg = closed ? element.points.length : element.points.length - 1;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < lastSeg; i += 1) {
      const a = element.points[i]!;
      const b = element.points[(i + 1) % element.points.length]!;
      const d = distToSegment(p, a, b);
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
    if (!element || !("points" in element)) return;
    // A closed shape (platform/tunnel/water) needs 3 points to stay a shape; an open polyline
    // (trackPath/viaduct) needs 2. Their schemas enforce the same minimums, so dropping below
    // would make the document unpublishable.
    const minPoints = isClosedShape(element.type, element.points.length) ? 3 : 2;
    if (element.points.length <= minPoints) return;
    const newPoints = element.points.filter((_, i) => i !== pointIndex);
    dispatch({
      type: "dispatchCommand",
      command: { type: "setProperty", elementId, property: "points", value: newPoints },
    });
  }

  function handleTransformEnd(elementId: string): void {
    const node = nodeRefs.current.get(elementId);
    const element = doc.elements.find((el) => el.id === elementId);
    // Only a berth is resized by the Transformer, and only a berth has both width and height.
    // This used to test `"width" in element` as a proxy for that, which quietly stopped meaning
    // "berth" the moment `viaduct` gained an optional width (Milestone 55 follow-up).
    if (!node || element?.type !== "berth") return;
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
  // Combined berths (owner request 2026-09-17, docs/MAP_EDITOR_SPEC.md's berth section): more
  // than one tdBerth binding sharing an elementId. Editor-only visual cue (a dashed outline
  // instead of solid) so the author can tell at a glance which boxes are a split-berth group —
  // the public map keeps the plain solid outline.
  const combinedBerthElementIds = (() => {
    const counts = new Map<string, number>();
    for (const binding of doc.bindings) {
      if (binding.type !== "tdBerth") continue;
      counts.set(binding.elementId, (counts.get(binding.elementId) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([elementId]) => elementId));
  })();
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
            /** Milestone 55: the caption on a points-based scenery shape, at the same anchor the
             * public renderer uses. Only a *detached* label is independently draggable; an
             * attached one is part of the shape. */
            const renderPlacedLabel = (
              shape: Extract<MapElement, { points: unknown; labelPosition: unknown }>,
            ): JSX.Element | null => {
              if (!shape.label) return null;
              const at = placedLabelAnchor(pointsBounds(shape.points), shape);
              return (
                <Text
                  {...anchoredText(
                    at.x,
                    at.y,
                    shape.fontSize,
                    at.anchor === "middle" ? "center" : at.anchor === "end" ? "right" : "left",
                  )}
                  text={shape.label}
                  fontSize={shape.fontSize}
                  fill={selected ? "#58a6ff" : MAP_STYLE.placedLabel.fill}
                  draggable={draggable && shape.labelOffset !== undefined}
                  onClick={(e) => handleElementClick(e, shape.id)}
                  onDragEnd={(e) => handleShapeLabelDragEnd(e, shape.id)}
                />
              );
            };
            /** Milestone 55 fix: the draggable corner/endpoint handles for a selected
             * points-based shape. Previously written out inline per type, so the three shapes
             * added in Milestone 55 had none at all and could not be reshaped. Same behaviour as
             * the trackPath/platform handles: drag to move, double-click to remove. */
            const renderVertexHandles = (
              shape: Extract<MapElement, { points: unknown }>,
            ): JSX.Element[] | null =>
              selected && draggable
                ? shape.points.map((point, index) => (
                    <Circle
                      key={index}
                      x={point.x}
                      y={point.y}
                      radius={5}
                      fill="#0d1117"
                      stroke="#58a6ff"
                      strokeWidth={2}
                      draggable
                      onDblClick={(e) => handleRemoveVertex(e, shape.id, index)}
                      onDragEnd={(e) => handlePointDragEnd(e, shape.id, index, shape.points)}
                    />
                  ))
                : null;
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
              // ADR 0005 (rev.): a filled orange shape. 3+ points = a closed polygon whose
              // vertices vary its width/shape; a legacy 2-point platform stays a thick bar.
              const isPolygon = element.points.length >= 3;
              return (
                <Group key={element.id}>
                  <Line
                    ref={setRef}
                    points={flattenPoints(element.points)}
                    closed={isPolygon}
                    fill={MAP_STYLE.platform.color}
                    stroke={selected ? "#58a6ff" : isPolygon ? "#b8791f" : MAP_STYLE.platform.color}
                    strokeWidth={
                      isPolygon
                        ? selected
                          ? 2
                          : 1
                        : selected
                          ? MAP_STYLE.platform.height + 2
                          : MAP_STYLE.platform.height
                    }
                    hitStrokeWidth={16}
                    lineCap="butt"
                    lineJoin="round"
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
              const rawOverlay = previewState?.[element.id];
              const inhibitingOverlay = element.inhibitedBy
                ? previewState?.[element.inhibitedBy]
                : undefined;
              // Opt-in TD-area fringe pairs (2026-09-11 owner request) — mirrors the identical
              // check in apps/web/src/map/MapRenderer.tsx's public renderer, kept in sync by
              // hand since this is a deliberately separate Konva implementation (see this file's
              // own doc comment on why — CLAUDE.md rule 13 is about shared domain model/state
              // semantics, not shared rendering code).
              const isInhibited =
                rawOverlay?.description != null &&
                rawOverlay.description === inhibitingOverlay?.description;
              // `{ description: null }`, not `undefined` — an inhibited berth in an active
              // test/live preview should render blank (vacant-looking), not fall back to
              // `element.displayName` (design mode's "no preview running at all" placeholder).
              const overlay = isInhibited ? { description: null } : rawOverlay;
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
                    {...(combinedBerthElementIds.has(element.id) ? { dash: [4, 3] } : {})}
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
                    fill={
                      signalStates?.[element.id]
                        ? MAP_STYLE.signal.stateColors[signalStates[element.id]!]
                        : signalFill(element.symbolStyle)
                    }
                    stroke={selected ? "#58a6ff" : "#2d3644"}
                    strokeWidth={selected ? 2 : 1}
                  />
                  {signalStates?.[element.id] ? (
                    <Circle
                      y={hy}
                      radius={MAP_STYLE.signal.radius + 3}
                      stroke="#8b949e"
                      strokeWidth={1}
                      dash={[2, 2]}
                      listening={false}
                    />
                  ) : null}
                  {element.label ? (
                    offsetMode ? (
                      <Text
                        text={element.label}
                        x={-20}
                        y={hy + dir * (MAP_STYLE.signal.radius + 8)}
                        offsetY={10 * 0.8}
                        width={40}
                        align="center"
                        fontSize={10}
                        fill="#8b96a5"
                      />
                    ) : (
                      // Match the public renderer's inline label: x+10, alphabetic baseline y+4.
                      <Text
                        text={element.label}
                        x={10}
                        y={4}
                        offsetY={10 * 0.8}
                        fontSize={10}
                        fill="#8b96a5"
                      />
                    )
                  ) : null}
                </Group>
              );
            }
            if (element.type === "label") {
              // Match the public renderer's `x/y` + `textAnchor` + alphabetic-baseline
              // placement (CLAUDE.md rule 13) so a label sits in the same spot in both views.
              return (
                <Text
                  key={element.id}
                  ref={setRef}
                  {...anchoredText(element.x, element.y, element.fontSize, element.align)}
                  text={element.text}
                  fontSize={element.fontSize}
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
                  {...anchoredText(element.x, element.y, element.fontSize, "center")}
                  // The CRS goes on the *last* line, matching the public renderer's per-tspan
                  // placement for a multi-line name (CLAUDE.md rule 13).
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
            if (element.type === "tunnel" || element.type === "water") {
              // Same shape model as a platform (ADR 0005 rev.): a filled, reshapeable polygon
              // whose vertices the author drags. Mirrors the public renderer's fill/stroke so
              // the two views agree (CLAUDE.md rule 13).
              const scenery = element.type === "tunnel" ? MAP_STYLE.tunnel : MAP_STYLE.water;
              const dash = element.type === "tunnel" ? MAP_STYLE.tunnel.dash : undefined;
              return (
                <Group key={element.id}>
                  <Line
                    ref={setRef}
                    points={flattenPoints(element.points)}
                    closed
                    fill={scenery.fill}
                    stroke={selected ? "#58a6ff" : scenery.stroke}
                    strokeWidth={selected ? 2 : scenery.strokeWidth}
                    {...(dash && !selected ? { dash: [...dash] } : {})}
                    lineJoin="round"
                    draggable={draggable}
                    onClick={(e) => handleElementClick(e, element.id)}
                    onDragEnd={(e) => handlePathDragEnd(e, element.id)}
                    onDblClick={(e) => handleInsertVertex(e, element.id)}
                    hitStrokeWidth={16}
                  />
                  {renderVertexHandles(element)}
                  {renderPlacedLabel(element)}
                </Group>
              );
            }
            if (element.type === "viaduct") {
              return (
                <Group key={element.id}>
                  <Line
                    ref={setRef}
                    points={flattenPoints(element.points)}
                    stroke={selected ? "#58a6ff" : MAP_STYLE.viaduct.color}
                    strokeWidth={viaductWidth(element)}
                    lineJoin="round"
                    lineCap="butt"
                    hitStrokeWidth={Math.max(16, viaductWidth(element))}
                    draggable={draggable}
                    onClick={(e) => handleElementClick(e, element.id)}
                    onDragEnd={(e) => handlePathDragEnd(e, element.id)}
                    onDblClick={(e) => handleInsertVertex(e, element.id)}
                  />
                  {renderVertexHandles(element)}
                  {renderPlacedLabel(element)}
                </Group>
              );
            }
            if (element.type === "neutralSection") {
              // Mirror the public renderer exactly (CLAUDE.md rule 13): the same
              // `neutralSectionGeometry` board + four black bars, drawn relative to a Group at
              // the element's centre so the drag handler's coordinates stay the authored x/y.
              const geometry = neutralSectionGeometry(element);
              const style = MAP_STYLE.neutralSection;
              const label = element.label;
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
                    x={geometry.board.x - element.x}
                    y={geometry.board.y - element.y}
                    width={geometry.board.width}
                    height={geometry.board.height}
                    cornerRadius={geometry.board.rx}
                    fill={style.boardFill}
                    stroke={selected ? "#58a6ff" : style.boardStroke}
                    strokeWidth={selected ? 1.5 : 0.5}
                  />
                  {geometry.bars.map((bar, index) => (
                    <Rect
                      key={index}
                      x={bar.x - element.x}
                      y={bar.y - element.y}
                      width={bar.width}
                      height={bar.height}
                      fill={style.symbolFill}
                    />
                  ))}
                  {label ? (
                    <Text
                      {...anchoredText(
                        geometry.label.x - element.x,
                        geometry.label.y - element.y,
                        element.fontSize,
                        geometry.label.anchor === "middle"
                          ? "center"
                          : geometry.label.anchor === "end"
                            ? "right"
                            : "left",
                      )}
                      text={label}
                      fontSize={element.fontSize}
                      fill={selected ? "#58a6ff" : style.labelFill}
                      // Only a detached label is independently draggable; an attached one is
                      // part of the sign and moves with the board.
                      draggable={draggable && element.labelOffset !== undefined}
                      onClick={(e) => handleElementClick(e, element.id)}
                      onDragEnd={(e) => handleLabelDragEnd(e, element.id)}
                    />
                  ) : null}
                </Group>
              );
            }
            if (element.type === "levelCrossing") {
              // Mirrors the public renderer (CLAUDE.md rule 13) from the same geometry. The
              // editor always previews `blank` barriers: the canvas is an authoring view of the
              // document, and a barrier position is live data that belongs to Test mode / the
              // public map, never to the drawing surface.
              const geometry = levelCrossingGeometry(element);
              const style = MAP_STYLE.levelCrossing;
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
                  {geometry.road.map((segment, index) => (
                    <Line
                      key={`road-${index}`}
                      points={[
                        segment.x1 - element.x,
                        segment.y1 - element.y,
                        segment.x2 - element.x,
                        segment.y2 - element.y,
                      ]}
                      stroke={selected ? "#58a6ff" : style.roadColor}
                      strokeWidth={style.roadStrokeWidth}
                      lineCap="butt"
                    />
                  ))}
                  {geometry.barriers.map((segment, index) => (
                    <Line
                      key={`barrier-${index}`}
                      points={[
                        segment.x1 - element.x,
                        segment.y1 - element.y,
                        segment.x2 - element.x,
                        segment.y2 - element.y,
                      ]}
                      stroke={style.stateColors.blank}
                      strokeWidth={style.barrierStrokeWidth}
                      lineCap="round"
                    />
                  ))}
                  {element.label ? (
                    <Text
                      {...anchoredText(
                        geometry.label.x - element.x,
                        geometry.label.y - element.y,
                        element.fontSize,
                        geometry.label.anchor === "middle"
                          ? "center"
                          : geometry.label.anchor === "end"
                            ? "right"
                            : "left",
                      )}
                      text={element.label}
                      fontSize={element.fontSize}
                      fill={selected ? "#58a6ff" : MAP_STYLE.placedLabel.fill}
                      draggable={draggable && element.labelOffset !== undefined}
                      onClick={(e) => handleElementClick(e, element.id)}
                      onDragEnd={(e) => handleLabelDragEnd(e, element.id)}
                    />
                  ) : null}
                </Group>
              );
            }
            // boundary — mirror the public renderer: grey r=4 dot, name to its right on the
            // alphabetic baseline.
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
                <Circle
                  radius={4}
                  fill="#8b949e"
                  {...(selected ? { stroke: "#58a6ff", strokeWidth: 2 } : {})}
                />
                <Text
                  text={element.name}
                  x={8}
                  y={4}
                  offsetY={10 * 0.8}
                  fontSize={10}
                  fill="#8b949e"
                />
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
