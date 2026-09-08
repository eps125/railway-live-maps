import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAP_STYLE,
  berthRenderRect,
  pointOnPathAtX,
  sortElementsForPaint,
  type CompiledMapBundle,
  type MapElement,
  type PlatformElement,
  type PlatformNumberElement,
  type SignalElement,
} from "@railway/map-schema";
import type { BerthState, SignalState } from "./types.js";
import { RunPopup } from "./RunPopup.js";

export interface MapRendererProps {
  bundle: CompiledMapBundle;
  berths: Record<string, BerthState>;
  signals: Record<string, SignalState>;
  /** ADR 0004 D5: when false, vacant berths draw nothing (berthmaps behaviour); occupied
   * berths are unaffected. Defaults to true — parity with the pre-ADR renderer. */
  showEmptyBerths?: boolean;
}

export interface ViewBox {
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

/** Occupied vs vacant. (Run-match colouring was removed with the berth-run resolver, ADR 0002 —
 * there's no match/ambiguous distinction to show until run correlation is rebuilt.) */
function berthColors(berthState: BerthState | undefined): { fill: string; stroke: string } {
  if (!berthState?.description) return { fill: "#161d27", stroke: "#2d3644" };
  return { fill: "#1c3a5e", stroke: "#2f5b8a" };
}

/** The white bordered platform-number box (Traksy pattern), centred on `(cx, cy)`. Shared by
 * the legacy inline `platform.number` and the standalone `platformNumber` element (ADR 0005
 * E3). Colours come from `--map-platform-number-*` tokens with hard fallbacks. */
function numberBox(cx: number, cy: number, text: string, fontSize: number): JSX.Element {
  const box = MAP_STYLE.platform.numberBox;
  return (
    <>
      <rect
        x={cx - box / 2}
        y={cy - box / 2}
        width={box}
        height={box}
        fill="var(--map-platform-number-fill, #ffffff)"
        stroke="var(--map-platform-number-border, #2d3644)"
        strokeWidth={1}
      />
      <text
        x={cx}
        y={cy}
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={fontSize}
        fontWeight={700}
        fill="var(--map-platform-number-text, #04101f)"
      >
        {text}
      </text>
    </>
  );
}

/** ADR 0004 D6 / ADR 0005 E2-E3 (rev. 2026-09-08): a platform is a **filled shape**, Traksy
 * orange (`#FFA500`). With 3+ points its `points` are the polygon outline, so vertices vary its
 * width and shape (L-shaped platforms, bays). A legacy 2-point platform is drawn as a bar of
 * the standard height, still offset to the far side of a bound `trackElementId`. Platform
 * numbers are their own `platformNumber` elements — `element.number` is no longer rendered. */
function renderPlatform(
  element: PlatformElement,
  elementsById: Record<string, MapElement>,
): JSX.Element {
  if (element.points.length >= 3) {
    return (
      <polygon
        key={element.id}
        points={element.points.map((p) => `${p.x},${p.y}`).join(" ")}
        fill="var(--map-platform-fill, #ffa500)"
        stroke="none"
      />
    );
  }

  // Legacy 2-point platform → a standard-height bar (optionally offset onto a bound track).
  const a = element.points[0]!;
  const b = element.points[1] ?? a;
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const selfY = a.y;
  let barY = selfY - MAP_STYLE.platform.height / 2;
  const boundTrack = element.trackElementId ? elementsById[element.trackElementId] : undefined;
  if (boundTrack?.type === "trackPath") {
    const trackY = pointOnPathAtX(boundTrack.points, (minX + maxX) / 2);
    if (trackY !== null) {
      barY =
        selfY >= trackY
          ? trackY + MAP_STYLE.platform.offset
          : trackY - MAP_STYLE.platform.offset - MAP_STYLE.platform.height;
    }
  }
  return (
    <rect
      key={element.id}
      x={minX}
      y={barY}
      width={Math.max(maxX - minX, MAP_STYLE.platform.numberBox)}
      height={MAP_STYLE.platform.height}
      fill="var(--map-platform-fill, #ffa500)"
      stroke="none"
    />
  );
}

/** ADR 0005 E3: standalone platform number — the author places it above its platform. */
function renderPlatformNumber(element: PlatformNumberElement): JSX.Element {
  return <g key={element.id}>{numberBox(element.x, element.y, element.text, element.fontSize)}</g>;
}

/** ADR 0005 E4: a signal is either `inline` (head on the track at x,y — today's look) or
 * `offset` (a short stem out to a head set off the track, OTT-inspired but not identical:
 * shorter stem, solid aspect-colour head with a thin outline, label centred below). Side of
 * the stem is `orientation` (>= 90 && < 270 → above the track, else below). No aspect change —
 * still blank/on/off only (CLAUDE.md rule 9). */
function renderSignal(element: SignalElement, state: SignalState["state"]): JSX.Element {
  const color = SIGNAL_COLORS[state];
  const r = MAP_STYLE.signal.radius;

  if (element.renderMode === "offset") {
    const up = element.orientation >= 90 && element.orientation < 270;
    const dir = up ? -1 : 1;
    const headY = element.y + dir * MAP_STYLE.signal.offset;
    return (
      <g key={element.id}>
        <line
          x1={element.x}
          y1={element.y}
          x2={element.x}
          y2={headY}
          stroke="#8b949e"
          strokeWidth={2}
        />
        <circle cx={element.x} cy={headY} r={r} fill={color} stroke="#0d1117" strokeWidth={1} />
        {element.label ? (
          <text
            x={element.x}
            y={headY + dir * (r + 8)}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={10}
            fill="#8b949e"
          >
            {element.label}
          </text>
        ) : null}
      </g>
    );
  }

  return (
    <g key={element.id}>
      <circle cx={element.x} cy={element.y} r={r} fill={color} />
      {element.label ? (
        <text x={element.x + 10} y={element.y + 4} fontSize={10} fill="#8b949e">
          {element.label}
        </text>
      ) : null}
    </g>
  );
}

const PADDING = 40;
export const MIN_ZOOM_WIDTH = 100;

/** Pure zoom math for a two-finger pinch, factored out so it's directly unit-testable — jsdom
 * (this project's test environment) doesn't implement the `PointerEvent` constructor at all, so
 * a genuine two-distinct-pointer gesture can't be reliably simulated through fireEvent; this is
 * the part of the gesture handling that actually matters to get right. Mirrors onWheel's
 * "zoom around a fixed center" approach, just driven by pinch distance ratio instead of wheel
 * delta. */
export function viewBoxAfterPinch(
  pinch: { startDistance: number; origin: ViewBox },
  currentDistance: number,
): ViewBox | null {
  if (currentDistance === 0) return null;
  const scale = pinch.startDistance / currentDistance;
  const newWidth = Math.max(pinch.origin.width * scale, MIN_ZOOM_WIDTH);
  const newHeight = Math.max(pinch.origin.height * scale, MIN_ZOOM_WIDTH);
  const cx = pinch.origin.x + pinch.origin.width / 2;
  const cy = pinch.origin.y + pinch.origin.height / 2;
  return { x: cx - newWidth / 2, y: cy - newHeight / 2, width: newWidth, height: newHeight };
}

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
export function MapRenderer({
  bundle,
  berths,
  signals,
  showEmptyBerths = true,
}: MapRendererProps): JSX.Element {
  const [viewBox, setViewBox] = useState<ViewBox>(() => initialViewBox(bundle));
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ startX: number; startY: number; origin: ViewBox } | null>(
    null,
  );
  // Two-finger pinch-to-zoom (touch has no wheel event) — tracks the distance between the two
  // touches at pinch start so subsequent moves scale the viewBox by how that distance has
  // changed, the same "zoom around a fixed center" idea onWheel already uses for the mouse.
  const [pinch, setPinch] = useState<{ startDistance: number; origin: ViewBox } | null>(null);
  const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());
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

  function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function onPointerDown(event: React.PointerEvent<SVGSVGElement>): void {
    // Deliberately no setPointerCapture here (tried it, reverted 2026-08-11): capturing on
    // every pointerdown — including a plain tap that lands on a berth — broke the click event a
    // berth's own onClick depends on to open the popup. Losing a fast-moving finger past the
    // element's edge mid-gesture is a real but much smaller cost than that.
    activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointers.current.size === 2) {
      // A second finger landing supersedes any single-finger pan already in progress.
      setDrag(null);
      const [a, b] = [...activePointers.current.values()];
      setPinch({ startDistance: pointerDistance(a!, b!), origin: viewBox });
    } else if (activePointers.current.size === 1) {
      setDrag({ startX: event.clientX, startY: event.clientY, origin: viewBox });
    }
  }

  function onPointerMove(event: React.PointerEvent<SVGSVGElement>): void {
    if (!activePointers.current.has(event.pointerId)) return;
    activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pinch && activePointers.current.size === 2) {
      const [a, b] = [...activePointers.current.values()];
      const next = viewBoxAfterPinch(pinch, pointerDistance(a!, b!));
      if (next) setViewBox(next);
      return;
    }

    if (drag && activePointers.current.size === 1) {
      const svg = event.currentTarget;
      const scaleX = drag.origin.width / svg.clientWidth;
      const scaleY = drag.origin.height / svg.clientHeight;
      const dx = (event.clientX - drag.startX) * scaleX;
      const dy = (event.clientY - drag.startY) * scaleY;
      setViewBox({ ...drag.origin, x: drag.origin.x - dx, y: drag.origin.y - dy });
    }
  }

  function onPointerUp(event: React.PointerEvent<SVGSVGElement>): void {
    activePointers.current.delete(event.pointerId);
    setDrag(null);
    setPinch(null);
    // One finger still down after the other lifts (pinch ending, or a 3rd+ touch releasing) —
    // resume panning from its current position rather than jumping back to wherever the very
    // first pointerdown in this gesture happened.
    if (activePointers.current.size === 1) {
      const [remaining] = [...activePointers.current.values()];
      setDrag({ startX: remaining!.x, startY: remaining!.y, origin: viewBox });
    }
  }

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
        style={{
          background: "#0d1117",
          cursor: drag || pinch ? "grabbing" : "grab",
          touchAction: "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {elements.map((element) => {
          if (element.type === "trackPath") {
            // ADR 0004 D2/D4: the compiler has already welded topology-joined segments into
            // single polylines, so a round `stroke-linejoin` closes every diagonal↔horizontal
            // corner — no junction dots, matching OpenTrainTimes. Caps stay `butt`.
            return (
              <polyline
                key={element.id}
                points={element.points.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                stroke={MAP_STYLE.track.color}
                strokeWidth={MAP_STYLE.track.strokeWidth}
                strokeLinejoin="round"
                strokeLinecap="butt"
                shapeRendering="geometricPrecision"
              />
            );
          }
          if (element.type === "platform") {
            return renderPlatform(element, bundle.elementsById);
          }
          if (element.type === "platformNumber") {
            return renderPlatformNumber(element);
          }
          if (element.type === "station") {
            return (
              <text
                key={element.id}
                x={element.x}
                y={element.y}
                textAnchor="middle"
                fontSize={element.fontSize}
                fontWeight={700}
                fill="var(--map-station-label, #58a6ff)"
              >
                {element.name}
                {element.crs ? ` [${element.crs}]` : ""}
              </text>
            );
          }
          if (element.type === "berth") {
            const berthState = berths[element.id];
            const colors = berthColors(berthState);
            // An empty berth has nothing to show a popup for — only occupied berths respond to
            // clicks (docs/PROJECT_SPEC.md §5: "click a populated berth").
            const isOccupied = Boolean(berthState?.description);
            // ADR 0004 D5: a vacant berth can be hidden entirely (berthmaps style).
            if (!isOccupied && !showEmptyBerths) return null;
            // ADR 0004 D1: centre the box on its bound track rather than trusting the authored
            // top-left y.
            const rect = berthRenderRect(element, bundle.elementsById);
            return (
              <g
                key={element.id}
                onClick={isOccupied ? () => setSelectedElementId(element.id) : undefined}
                style={{ cursor: isOccupied ? "pointer" : "default" }}
              >
                <rect
                  x={rect.x}
                  y={rect.y}
                  width={rect.width}
                  height={rect.height}
                  fill={colors.fill}
                  stroke={colors.stroke}
                  strokeWidth={1}
                  rx={2}
                />
                <text
                  x={rect.x + rect.width / 2}
                  y={rect.y + rect.height / 2}
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
            return renderSignal(element, signals[element.id]?.state ?? "blank");
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

      {selectedElementId && selectedBinding ? (
        // docs/PROJECT_SPEC.md §5: "Click a populated berth to open a train/run popup".
        <RunPopup
          key={selectedElementId}
          elementId={selectedElementId}
          displayName={
            selectedElement?.type === "berth" ? selectedElement.displayName : selectedElementId
          }
          tdArea={selectedBinding.split("|")[0] ?? ""}
          berth={selectedBinding.split("|")[1] ?? ""}
          onClose={() => setSelectedElementId(null)}
        />
      ) : null}
    </div>
  );
}
