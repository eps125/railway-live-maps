import { Circle, Group, Line, Text } from "react-konva";
import type Konva from "konva";
import { joinTrackEnds, type MapElement, type MapJoin } from "@railway/map-schema";

export const JOIN_COLOR = "#db61a2";
export const JOIN_SELECTED_COLOR = "#58a6ff";

function snap(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * Milestone 85 (docs/adr/0019): a module's own joins on the canvas — a dashed line across the
 * track ends at its edge, with its name and a ring on each track end it catches. Click to select;
 * drag the line to move it or an end to reshape it (both snap to the grid). Changes go through
 * `onChange` as a whole new join list (one undo step each).
 */
export function JoinsOverlay({
  joins,
  elements,
  selectedJoinId,
  editable,
  gridSize,
  scale,
  onSelect,
  onChange,
}: {
  joins: MapJoin[];
  elements: MapElement[];
  selectedJoinId: string | null;
  editable: boolean;
  gridSize: number;
  scale: number;
  onSelect: (joinId: string) => void;
  onChange: (joins: MapJoin[]) => void;
}): JSX.Element {
  const replace = (next: MapJoin): void =>
    onChange(joins.map((join) => (join.id === next.id ? next : join)));

  return (
    <>
      {joins.map((join) => {
        const selected = join.id === selectedJoinId;
        const color = selected ? JOIN_SELECTED_COLOR : JOIN_COLOR;
        const [a, b] = join.points;
        const handleLineDragEnd = (e: Konva.KonvaEventObject<DragEvent>): void => {
          const dx = snap(e.target.x(), gridSize);
          const dy = snap(e.target.y(), gridSize);
          e.target.position({ x: 0, y: 0 });
          if (dx === 0 && dy === 0) return;
          replace({
            ...join,
            points: [
              { x: a.x + dx, y: a.y + dy },
              { x: b.x + dx, y: b.y + dy },
            ],
          });
        };
        const handleEndDragEnd = (index: 0 | 1) => (e: Konva.KonvaEventObject<DragEvent>) => {
          e.cancelBubble = true;
          const point = { x: snap(e.target.x(), gridSize), y: snap(e.target.y(), gridSize) };
          const points: MapJoin["points"] = index === 0 ? [point, b] : [a, point];
          replace({ ...join, points });
        };
        return (
          <Group key={join.id}>
            <Group
              draggable={editable && selected}
              onDragEnd={handleLineDragEnd}
              onClick={(e) => {
                e.cancelBubble = true;
                onSelect(join.id);
              }}
              onTap={(e) => {
                e.cancelBubble = true;
                onSelect(join.id);
              }}
            >
              <Line
                points={[a.x, a.y, b.x, b.y]}
                stroke={color}
                strokeWidth={(selected ? 3 : 2) / scale}
                dash={[6 / scale, 4 / scale]}
                hitStrokeWidth={12 / scale}
              />
              <Text
                x={Math.max(a.x, b.x) + 6}
                y={Math.min(a.y, b.y) - 4}
                text={join.name}
                fontSize={12}
                fontStyle="bold"
                fill={color}
              />
            </Group>
            {joinTrackEnds(elements, join).map((end, index) => (
              <Circle
                key={index}
                x={end.x}
                y={end.y}
                radius={4}
                stroke={color}
                strokeWidth={1.5}
                listening={false}
              />
            ))}
            {editable && selected
              ? ([0, 1] as const).map((index) => (
                  <Circle
                    key={`end-${index}`}
                    x={join.points[index].x}
                    y={join.points[index].y}
                    radius={5}
                    fill="#0d1117"
                    stroke={color}
                    strokeWidth={2}
                    draggable
                    onDragEnd={handleEndDragEnd(index)}
                  />
                ))
              : null}
          </Group>
        );
      })}
    </>
  );
}
