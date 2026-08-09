import { useEffect, useMemo, useRef, useState } from "react";
import { sortElementsForPaint, type CompiledMapBundle } from "@railway/map-schema";
import type { BerthState, SignalState } from "./types.js";
import { RunPopup } from "./RunPopup.js";

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
  blank: "#5f6b7a",
  on: "#f85149",
  off: "#3fb950",
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
  const svgRef = useRef<SVGSVGElement>(null);

  const elementIdToBinding = useMemo(() => {
    const map = new Map<string, string>();
    for (const [key, elementId] of Object.entries(bundle.berthBindingIndex)) {
      map.set(elementId, key);
    }
    return map;
  }, [bundle]);

  // Paint order and layer visibility must match the editor canvas exactly (CLAUDE.md rule 13:
  // public renderer and editor preview share the same domain model/state semantics) —
  // `elementsById` is a Record, and relying on its own key-insertion order to already reflect
  // sortElementsForPaint's result is exactly the kind of implicit assumption that's easy to
  // silently break, so paint order is computed explicitly here via the same shared function
  // EditorCanvas.tsx uses. A layer with no explicit `visible: false` (including one this bundle
  // doesn't list at all) still renders — unlike the editor's stricter default, an unknown/absent
  // layer here should never hide real published content.
  const layersById = useMemo(
    () => new Map(bundle.layers.map((layer) => [layer.id, layer])),
    [bundle],
  );
  const elements = useMemo(
    () =>
      sortElementsForPaint(
        Object.values(bundle.elementsById).filter(
          (element) => layersById.get(element.layerId)?.visible !== false,
        ),
        bundle.layers,
      ),
    [bundle, layersById],
  );

  // React attaches its synthetic onWheel listener as passive at the root, so
  // event.preventDefault() there is silently ignored (and Chrome logs a warning on every
  // tick) — attach a real, non-passive listener directly on the element instead so zooming
  // the map actually stops the page from scrolling underneath it.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    function onWheel(event: WheelEvent): void {
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

    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

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
  const selectedElement = selectedElementId ? bundle.elementsById[selectedElementId] : undefined;

  return (
    <div className="map-frame">
      <svg
        ref={svgRef}
        role="img"
        aria-label={`${bundle.mapName} schematic map`}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        width="100%"
        height="600"
        style={{ background: "#0d1117", cursor: drag ? "grabbing" : "grab", touchAction: "none" }}
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
                stroke="#3d4a5c"
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
                stroke="#232c38"
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
                  fill={berthState?.description ? "#388bfd" : "#161d27"}
                  stroke={berthState?.description ? "#58a6ff" : "#2d3644"}
                  strokeWidth={1}
                  rx={2}
                />
                <text
                  x={element.x + element.width / 2}
                  y={element.y + element.height / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontFamily="ui-monospace, 'Roboto Mono', Consolas, monospace"
                  fontSize={element.fontSize}
                  fill={berthState?.description ? "#04101f" : "#8b96a5"}
                  fontWeight={berthState?.description ? 700 : 400}
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

      {selectedElementId && selectedBinding && selectedBerthState?.description ? (
        // docs/PROJECT_SPEC.md §5: "Click a populated berth to open a train/run popup" — only
        // fetches/renders the full popup for an occupied, bound berth; an empty or unbound one
        // falls through to the plain stub below instead.
        <RunPopup
          key={selectedElementId}
          elementId={selectedElementId}
          displayName={
            selectedElement?.type === "berth" ? selectedElement.displayName : selectedElementId
          }
          tdArea={selectedBinding.split("|")[0] ?? ""}
          berth={selectedBinding.split("|")[1] ?? ""}
        />
      ) : selectedElementId ? (
        <div role="status" className="map-inspector">
          <div className="map-inspector__title">{selectedElementId}</div>
          <dl>
            <dt>TD binding</dt>
            <dd>{selectedBinding ?? "unbound"}</dd>
            <dt>Description</dt>
            <dd>{selectedBerthState?.description ?? "(empty)"}</dd>
          </dl>
          <div className="map-inspector__note">
            {selectedBinding ? "This berth is currently empty." : "This element has no TD binding."}
          </div>
        </div>
      ) : null}
    </div>
  );
}
