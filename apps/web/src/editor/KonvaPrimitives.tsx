import { Circle, Line, Path, Rect, Text } from "react-konva";
import type { DrawPrimitive } from "@railway/map-schema";

/** 2026-09-27: draws the shared `DrawPrimitive` shapes (buffer stops, stop boards) with Konva —
 * the editor's side of the public renderer's `SvgPrimitives` (CLAUDE.md rule 13). */
export function KonvaPrimitives({ parts }: { parts: readonly DrawPrimitive[] }): JSX.Element {
  return (
    <>
      {parts.map((part, i) => {
        switch (part.kind) {
          case "rect":
            return (
              <Rect
                key={i}
                x={part.x}
                y={part.y}
                width={part.width}
                height={part.height}
                cornerRadius={part.rx ?? 0}
                fill={part.fill}
                {...(part.stroke ? { stroke: part.stroke } : {})}
                strokeWidth={part.strokeWidth ?? 0}
                listening={false}
              />
            );
          case "polygon":
            return (
              <Line
                key={i}
                points={part.points}
                closed
                fill={part.fill}
                {...(part.stroke ? { stroke: part.stroke } : {})}
                strokeWidth={part.strokeWidth ?? 0}
                listening={false}
              />
            );
          case "circle":
            return (
              <Circle
                key={i}
                x={part.cx}
                y={part.cy}
                radius={part.r}
                fill={part.fill}
                listening={false}
              />
            );
          case "polyline":
            return (
              <Line
                key={i}
                points={part.points}
                stroke={part.stroke}
                strokeWidth={part.strokeWidth}
                listening={false}
              />
            );
          case "path":
            return (
              <Path
                key={i}
                data={part.d}
                fill={part.fill}
                {...(part.stroke ? { stroke: part.stroke } : {})}
                strokeWidth={part.strokeWidth ?? 0}
                listening={false}
              />
            );
          case "text": {
            // SVG places text at its baseline with `text-anchor: middle`; Konva at its top-left.
            const width = part.fontSize * 6;
            return (
              <Text
                key={i}
                text={part.text}
                x={part.x}
                y={part.y}
                offsetX={width / 2}
                offsetY={part.fontSize * 0.8}
                width={width}
                align="center"
                fontFamily="Arial, Helvetica, sans-serif"
                fontStyle={part.bold ? "bold" : "normal"}
                fontSize={part.fontSize}
                fill={part.fill}
                listening={false}
              />
            );
          }
        }
      })}
    </>
  );
}
