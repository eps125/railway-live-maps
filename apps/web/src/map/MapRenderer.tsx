import { useMemo, useState } from "react";
import type { CompiledMapBundle } from "@railway/map-schema";
import type { BerthState, SignalState } from "./types.js";

export interface MapRendererProps {
  bundle: CompiledMapBundle;
  berths: Record<string, BerthState>;
  signals: Record<string, SignalState>;
}

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SIGNAL_COLORS: Record<SignalState["state"], string> = {
  blank: "#9aa0a6",
  on: "#c0392b",
  off: "#2e7d32",
};

const PADDING = 40;
const MIN_ZOOM_WIDTH = 100;

function initialViewBox(bundle: CompiledMapBundle): ViewBox {
  const { minX, minY, maxX, maxY } = bundle.boundingBox;
  return {
    x: minX - PADDING,
    y: minY - PADDING,
    width: Math.max(maxX - minX + PADDING * 2, MIN_ZOOM_WIDTH),
    height: Math.max(maxY - minY + PADDING * 2, MIN_ZOOM_WIDTH),
  };
}

/** Basic SVG public map renderer (docs/IMPLEMENTATION_PLAN.md Milestone 5,
 * docs/MAP_EDITOR_SPEC.md §12): plain SVG, pan/zoom via viewBox manipulation, semantic style
 * tokens for signals. The full train/run popup needs the resolver (Milestone 9) — clicking a
 * berth here only shows the raw description/berth id as a stub. */
export function MapRenderer({ bundle, berths, signals }: MapRendererProps): JSX.Element {
  const [viewBox, setViewBox] = useState<ViewBox>(() => initialViewBox(bundle));
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ startX: number; startY: number; origin: ViewBox } | null>(
    null,
  );

  const elementIdToBinding = useMemo(() => {
    const map = new Map<string, string>();
    for (const [key, elementId] of Object.entries(bundle.berthBindingIndex)) {
      map.set(elementId, key);
    }
    return map;
  }, [bundle]);

  const elements = Object.values(bundle.elementsById);

  function onWheel(event: React.WheelEvent<SVGSVGElement>): void {
    event.preventDefault();
    const scale = event.deltaY > 0 ? 1.1 : 0.9;
    setViewBox((current) => {
      const newWidth = Math.max(current.width * scale, MIN_ZOOM_WIDTH);
      const newHeight = Math.max(current.height * scale, MIN_ZOOM_WIDTH);
      const cx = current.x + current.width / 2;
      const cy = current.y + current.height / 2;
      return { x: cx - newWidth / 2, y: cy - newHeight / 2, width: newWidth, height: newHeight };
    });
  }

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>): void {
    setDrag({ startX: event.clientX, startY: event.clientY, origin: viewBox });
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>): void {
    if (!drag) return;
    const svg = event.currentTarget;
    const scaleX = drag.origin.width / svg.clientWidth;
    const scaleY = drag.origin.height / svg.clientHeight;
    const dx = (event.clientX - drag.startX) * scaleX;
    const dy = (event.clientY - drag.startY) * scaleY;
    setViewBox({ ...drag.origin, x: drag.origin.x - dx, y: drag.origin.y - dy });
  }

  function onPointerUp(): void {
    setDrag(null);
  }

  const selectedBerthState = selectedElementId ? berths[selectedElementId] : undefined;
  const selectedBinding = selectedElementId ? elementIdToBinding.get(selectedElementId) : undefined;

  return (
    <div style={{ position: "relative" }}>
      <svg
        role="img"
        aria-label={`${bundle.mapName} schematic map`}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        width="100%"
        height="600"
        style={{ background: "#0d1117", cursor: drag ? "grabbing" : "grab", touchAction: "none" }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {elements.map((element) => {
          if (element.type === "trackPath") {
            return (
              <polyline
                key={element.id}
                points={element.points.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke="#5f6b7a"
                strokeWidth={3}
              />
            );
          }
          if (element.type === "platform") {
            return (
              <polyline
                key={element.id}
                points={element.points.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke="#3a4552"
                strokeWidth={10}
                strokeLinecap="round"
              />
            );
          }
          if (element.type === "berth") {
            const berthState = berths[element.id];
            return (
              <g
                key={element.id}
                onClick={() => setSelectedElementId(element.id)}
                style={{ cursor: "pointer" }}
              >
                <rect
                  x={element.x}
                  y={element.y}
                  width={element.width}
                  height={element.height}
                  fill={berthState?.description ? "#1f6feb" : "#161b22"}
                  stroke="#c9d1d9"
                  strokeWidth={1}
                />
                <text
                  x={element.x + element.width / 2}
                  y={element.y + element.height / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={element.fontSize}
                  fill="#f0f6fc"
                >
                  {berthState?.description ?? ""}
                </text>
              </g>
            );
          }
          if (element.type === "signal") {
            const signalState = signals[element.id]?.state ?? "blank";
            return (
              <g key={element.id}>
                <circle cx={element.x} cy={element.y} r={6} fill={SIGNAL_COLORS[signalState]} />
                {element.label ? (
                  <text x={element.x + 10} y={element.y + 4} fontSize={10} fill="#8b949e">
                    {element.label}
                  </text>
                ) : null}
              </g>
            );
          }
          if (element.type === "label") {
            return (
              <text
                key={element.id}
                x={element.x}
                y={element.y}
                textAnchor={
                  element.align === "center"
                    ? "middle"
                    : element.align === "right"
                      ? "end"
                      : "start"
                }
                fontSize={element.fontSize}
                fill="#c9d1d9"
              >
                {element.text}
              </text>
            );
          }
          if (element.type === "boundary") {
            return (
              <g key={element.id}>
                <circle cx={element.x} cy={element.y} r={4} fill="#8b949e" />
                <text x={element.x + 8} y={element.y + 4} fontSize={10} fill="#8b949e">
                  {element.name}
                </text>
              </g>
            );
          }
          return null;
        })}
      </svg>

      {selectedElementId ? (
        <div
          role="status"
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            background: "#161b22",
            color: "#f0f6fc",
            padding: "8px 12px",
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          <div>Berth: {selectedElementId}</div>
          <div>TD binding: {selectedBinding ?? "unbound"}</div>
          <div>Description: {selectedBerthState?.description ?? "(empty)"}</div>
          <div style={{ opacity: 0.7, marginTop: 4 }}>
            Full run details arrive in a later milestone.
          </div>
        </div>
      ) : null}
    </div>
  );
}
