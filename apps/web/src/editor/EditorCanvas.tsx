import { useRef } from "react";
import { Stage, Layer, Line, Rect, Text, Circle, Group, Transformer } from "react-konva";
import Konva from "konva";
import type { MapElement } from "@railway/map-schema";
import { useEditorState, useEditorDispatch, type ToolMode } from "./EditorState.js";

const CANVAS_VIEW_WIDTH = 900;
const CANVAS_VIEW_HEIGHT = 600;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const WHEEL_ZOOM_FACTOR = 1.05;

function snap(value: number, gridSize: number): number {
  return Math.round(value / gridSize) * gridSize;
}

function flattenPoints(points: Array<{ x: number; y: number }>): number[] {
  return points.flatMap((p) => [p.x, p.y]);
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
        type: "label",
        x: point.x,
        y: point.y,
        text: "Label",
        align: "left",
        fontSize: 12,
      };
    case "boundary":
      return { id, layerId, type: "boundary", x: point.x, y: point.y, name: "Boundary" };
    case "trackPath":
      return {
        id,
        layerId,
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
        type: "platform",
        points: [
          { x: point.x, y: point.y },
          { x: point.x + 100, y: point.y },
        ],
      };
    case "select":
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
    const layerId = doc.layers[0]?.id;
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

  const gridLines: JSX.Element[] = [];
  const { width: canvasWidth, height: canvasHeight } = doc.map.canvas;
  for (let x = 0; x <= canvasWidth; x += gridSize) {
    gridLines.push(
      <Line key={`gx-${x}`} points={[x, 0, x, canvasHeight]} stroke="#1c2430" strokeWidth={1} />,
    );
  }
  for (let y = 0; y <= canvasHeight; y += gridSize) {
    gridLines.push(
      <Line key={`gy-${y}`} points={[0, y, canvasWidth, y]} stroke="#1c2430" strokeWidth={1} />,
    );
  }

  const sortedVisibleLayers = [...doc.layers]
    .filter((l) => l.visible)
    .sort((a, b) => a.order - b.order);

  return (
    <Stage
      width={CANVAS_VIEW_WIDTH}
      height={CANVAS_VIEW_HEIGHT}
      x={viewport.x}
      y={viewport.y}
      scaleX={viewport.scale}
      scaleY={viewport.scale}
      draggable={toolMode === "select"}
      onWheel={handleWheel}
      onDragEnd={handleStageDragEnd}
      onClick={handleStageClick}
    >
      <Layer listening={false}>
        <Rect x={0} y={0} width={canvasWidth} height={canvasHeight} fill="#0d1117" />
        {gridLines}
      </Layer>
      <Layer>
        {sortedVisibleLayers.map((layer) => (
          <Group key={layer.id}>
            {doc.elements
              .filter((element) => element.layerId === layer.id)
              .map((element) => {
                const selected = selection.includes(element.id);
                const draggable = toolMode === "select" && !layer.locked;
                const setRef = (node: Konva.Node | null): void => {
                  if (node) nodeRefs.current.set(element.id, node);
                  else nodeRefs.current.delete(element.id);
                };

                if (element.type === "trackPath") {
                  return (
                    <Line
                      key={element.id}
                      ref={setRef}
                      points={flattenPoints(element.points)}
                      stroke={selected ? "#58a6ff" : "#5f6b7a"}
                      strokeWidth={selected ? 3 : 2}
                      draggable={draggable}
                      onClick={(e) => handleElementClick(e, element.id)}
                      onDragEnd={(e) => handlePathDragEnd(e, element.id)}
                    />
                  );
                }
                if (element.type === "platform") {
                  return (
                    <Line
                      key={element.id}
                      ref={setRef}
                      points={flattenPoints(element.points)}
                      stroke={selected ? "#58a6ff" : "#3d4a5c"}
                      strokeWidth={selected ? 8 : 6}
                      lineCap="round"
                      draggable={draggable}
                      onClick={(e) => handleElementClick(e, element.id)}
                      onDragEnd={(e) => handlePathDragEnd(e, element.id)}
                    />
                  );
                }
                if (element.type === "berth") {
                  const overlay = previewState?.[element.id];
                  const occupied = overlay !== undefined && overlay.description !== null;
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
                        width={element.width}
                        height={element.height}
                        fill={occupied ? "#d29922" : selected ? "#233044" : "#161d27"}
                        stroke={selected ? "#58a6ff" : "#2d3644"}
                        strokeWidth={selected ? 2 : 1}
                        cornerRadius={2}
                      />
                      <Text
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
                        radius={8}
                        fill={signalFill(element.symbolStyle)}
                        stroke={selected ? "#58a6ff" : "#2d3644"}
                        strokeWidth={selected ? 2 : 1}
                      />
                      {element.label ? (
                        <Text text={element.label} y={12} fontSize={10} fill="#8b96a5" />
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
          </Group>
        ))}
        {selectedBerthId ? (
          <Transformer
            ref={transformerRef}
            nodes={
              nodeRefs.current.has(selectedBerthId) ? [nodeRefs.current.get(selectedBerthId)!] : []
            }
            rotateEnabled={false}
          />
        ) : null}
      </Layer>
    </Stage>
  );
}
