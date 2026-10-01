import { Circle, Group, Line, Rect, Text } from "react-konva";
import type Konva from "konva";
import {
  computeBoundingBox,
  joinTrackEnds,
  MAP_STYLE,
  type MapElement,
  type MapJoin,
} from "@railway/map-schema";
import type { BackdropItem } from "./modulesSupport.js";

/** Joins of a module drawn behind the one being edited, and their track ends. */
export const BACKDROP_JOIN_COLOR = "#3fb950";
const GHOST_TRACK = "#6e7a8a";
const GHOST_TEXT = "#8b96a5";

function flat(points: Array<{ x: number; y: number }>): number[] {
  return points.flatMap((p) => [p.x, p.y]);
}

/** A simplified drawing of one element, for context only: tracks, platforms, berth boxes, signal
 * dots and names. Enough to see where things are; never edited from here. */
function ghost(element: MapElement): JSX.Element | null {
  switch (element.type) {
    case "trackPath":
      return (
        <Line
          key={element.id}
          points={flat(element.points)}
          stroke={GHOST_TRACK}
          strokeWidth={MAP_STYLE.track.strokeWidth}
          {...(element.hidden ? { dash: [6, 6] } : {})}
          lineJoin="round"
        />
      );
    case "viaduct":
      return (
        <Line
          key={element.id}
          points={flat(element.points)}
          stroke="#6d6255"
          strokeWidth={element.width ?? 12}
          opacity={0.5}
        />
      );
    case "platform":
    case "tunnel":
    case "water":
      return (
        <Line
          key={element.id}
          points={flat(element.points)}
          closed={element.points.length > 2}
          fill={
            element.type === "platform"
              ? "#ffa500"
              : element.type === "water"
                ? "#16384f"
                : "#111820"
          }
          {...(element.type === "platform" && element.points.length === 2
            ? { stroke: "#ffa500", strokeWidth: 8 }
            : {})}
          opacity={0.45}
        />
      );
    case "berth":
      return (
        <Group key={element.id} x={element.x} y={element.y}>
          <Rect width={element.width} height={element.height} stroke={GHOST_TEXT} strokeWidth={1} />
          <Text
            text={element.displayName}
            width={element.width}
            height={element.height}
            align="center"
            verticalAlign="middle"
            fontSize={Math.min(element.fontSize, element.height)}
            fill={GHOST_TEXT}
          />
        </Group>
      );
    case "signal":
      return <Circle key={element.id} x={element.x} y={element.y} radius={4} fill={GHOST_TRACK} />;
    case "station":
    case "label":
      return (
        <Text
          key={element.id}
          x={element.x}
          y={element.y}
          text={element.type === "station" ? element.name : element.text}
          fontSize={element.fontSize}
          fill={GHOST_TEXT}
          offsetX={0}
        />
      );
    case "platformNumber":
      return (
        <Rect
          key={element.id}
          x={element.x - 5}
          y={element.y - 5}
          width={10}
          height={10}
          stroke={GHOST_TEXT}
          strokeWidth={1}
        />
      );
    default:
      return null;
  }
}

export function BackdropJoins({
  joins,
  elements,
  color,
  scale,
}: {
  joins: MapJoin[];
  elements: MapElement[];
  color: string;
  scale: number;
}): JSX.Element {
  return (
    <>
      {joins.map((join) => (
        <Group key={join.id}>
          <Line
            points={flat(join.points)}
            stroke={color}
            strokeWidth={2 / scale}
            dash={[6 / scale, 4 / scale]}
          />
          <Text
            x={join.points[0].x + 4}
            y={Math.min(join.points[0].y, join.points[1].y) - 14}
            text={join.name}
            fontSize={11}
            fill={color}
          />
          {joinTrackEnds(elements, join).map((end, index) => (
            <Circle key={index} x={end.x} y={end.y} radius={3.5} stroke={color} strokeWidth={1.5} />
          ))}
        </Group>
      ))}
    </>
  );
}

/**
 * Milestone 85 (docs/adr/0019): the other parts of an assembled map, drawn dimmed behind what is
 * being edited — each module in its place, with its name and joins. A freely placed module can be
 * dragged to a new spot (snapped to the grid); an attached one goes where its joins put it.
 */
export function ModuleBackdrop({
  items,
  gridSize,
  scale,
  onMove,
}: {
  items: BackdropItem[];
  gridSize: number;
  scale: number;
  onMove?: ((key: string, dx: number, dy: number) => void) | undefined;
}): JSX.Element {
  return (
    <>
      {items.map((item) => {
        const box = computeBoundingBox(item.elements);
        const hasContent = item.elements.length > 0;
        const handleDragEnd = (e: Konva.KonvaEventObject<DragEvent>): void => {
          const x = Math.round(e.target.x() / gridSize) * gridSize;
          const y = Math.round(e.target.y() / gridSize) * gridSize;
          e.target.position({ x: item.dx, y: item.dy });
          if (x !== item.dx || y !== item.dy) onMove?.(item.key, x, y);
        };
        return (
          <Group
            key={item.key}
            x={item.dx}
            y={item.dy}
            opacity={0.6}
            listening={item.draggable}
            draggable={item.draggable}
            onDragEnd={handleDragEnd}
            onMouseEnter={(e) => {
              if (item.draggable) e.target.getStage()!.container().style.cursor = "move";
            }}
            onMouseLeave={(e) => {
              e.target.getStage()!.container().style.cursor = "";
            }}
          >
            {hasContent && item.title !== null ? (
              <>
                <Rect
                  x={box.minX - 10}
                  y={box.minY - 10}
                  width={box.maxX - box.minX + 20}
                  height={box.maxY - box.minY + 20}
                  stroke="#58a6ff"
                  strokeWidth={1 / scale}
                  dash={[8 / scale, 6 / scale]}
                  fill="rgba(88, 166, 255, 0.04)"
                />
                <Text
                  x={box.minX - 10}
                  y={box.minY - 28}
                  text={item.draggable ? `${item.title} (drag to move)` : item.title}
                  fontSize={13}
                  fill="#58a6ff"
                />
              </>
            ) : null}
            {item.elements.map(ghost)}
            <BackdropJoins
              joins={item.joins}
              elements={item.elements}
              color={BACKDROP_JOIN_COLOR}
              scale={scale}
            />
          </Group>
        );
      })}
    </>
  );
}
