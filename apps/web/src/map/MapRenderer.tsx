import { useEffect, useMemo, useRef, useState } from "react";
import { sortElementsForPaint, type CompiledMapBundle } from "@railway/map-schema";
import type { BerthState, SignalState } from "./types.js";
import { RunPopup } from "./RunPopup.js";

export interface MapRendererProps {
  bundle: CompiledMapBundle;
  berths: Record<string, BerthState>;
  signals: Record<string, SignalState>;
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

/** Bright blue only for a confirmed resolver match; anything else occupied (ambiguous,
 * unmatched, or not yet resolved — runSummary is null until the resolver decides, which can
 * genuinely lag a step or two behind the berth stepping) gets a visibly darker shade rather than
 * being indistinguishable from a confirmed match. */
function berthColors(berthState: BerthState | undefined): { fill: string; stroke: string } {
  if (!berthState?.description) return { fill: "#161d27", stroke: "#2d3644" };
  return berthState.runSummary?.status === "matched"
    ? { fill: "#388bfd", stroke: "#58a6ff" }
    : { fill: "#1c3a5e", stroke: "#2f5b8a" };
}

const PADDING = 40;
export const MIN_ZOOM_WIDTH = 100;

/** How long to keep a tracked matched run's popup open after no berth on the map reports it
 * anymore, before treating it as genuinely gone. A berth step is not atomic from the client's
 * point of view: the old berth's occupancy clears before the resolver has necessarily confirmed
 * the run in its new berth (apps/worker/src/resolver/projector.ts's own loop), so there's a real
 * window — normally under a couple of seconds, but worth padding — where *no* berth reports the
 * tracked run even though it hasn't actually left. Closing immediately on the first missed check
 * was confirmed 2026-08-13 to make the popup flicker shut on every single step. */
const RUN_LOST_GRACE_MS = 8000;

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
export function MapRenderer({ bundle, berths, signals }: MapRendererProps): JSX.Element {
  const [viewBox, setViewBox] = useState<ViewBox>(() => initialViewBox(bundle));
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  // Set only when the selected berth was a confirmed match — lets the popup follow this specific
  // run across berth steps instead of the berth it happened to be clicked in (rule 5: a raw
  // description alone is never a stable identity, but a resolver-confirmed train_run id is).
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ startX: number; startY: number; origin: ViewBox } | null>(
    null,
  );
  // Two-finger pinch-to-zoom (touch has no wheel event) — tracks the distance between the two
  // touches at pinch start so subsequent moves scale the viewBox by how that distance has
  // changed, the same "zoom around a fixed center" idea onWheel already uses for the mouse.
  const [pinch, setPinch] = useState<{ startDistance: number; origin: ViewBox } | null>(null);
  const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const svgRef = useRef<SVGSVGElement>(null);
  const runLostTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-targets the selection to wherever the tracked run currently is, every time berth state
  // changes. If no berth reports it, that doesn't necessarily mean it's gone — see
  // RUN_LOST_GRACE_MS — so closing only happens once that grace window elapses with the run still
  // nowhere to be found, not on the first missed check.
  useEffect(() => {
    if (!selectedRunId) return;
    const current = Object.entries(berths).find(
      ([, state]) => state.runSummary?.trainRunId === selectedRunId,
    );
    if (current) {
      if (runLostTimeoutRef.current) {
        clearTimeout(runLostTimeoutRef.current);
        runLostTimeoutRef.current = null;
      }
      if (current[0] !== selectedElementId) setSelectedElementId(current[0]);
      return;
    }
    if (!runLostTimeoutRef.current) {
      runLostTimeoutRef.current = setTimeout(() => {
        setSelectedElementId(null);
        setSelectedRunId(null);
        runLostTimeoutRef.current = null;
      }, RUN_LOST_GRACE_MS);
    }
  }, [berths, selectedRunId, selectedElementId]);

  useEffect(() => {
    return () => {
      if (runLostTimeoutRef.current) clearTimeout(runLostTimeoutRef.current);
    };
  }, []);

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
            const colors = berthColors(berthState);
            // An empty berth has nothing to show a popup for — only occupied berths respond to
            // clicks (docs/PROJECT_SPEC.md §5: "click a populated berth").
            const isOccupied = Boolean(berthState?.description);
            return (
              <g
                key={element.id}
                onClick={
                  isOccupied
                    ? () => {
                        const trainRunId =
                          berthState?.runSummary?.status === "matched"
                            ? berthState.runSummary.trainRunId
                            : null;
                        setSelectedRunId(trainRunId);
                        setSelectedElementId(element.id);
                      }
                    : undefined
                }
                style={{ cursor: isOccupied ? "pointer" : "default" }}
              >
                <rect
                  x={element.x}
                  y={element.y}
                  width={element.width}
                  height={element.height}
                  fill={colors.fill}
                  stroke={colors.stroke}
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

      {selectedElementId && selectedBinding ? (
        // docs/PROJECT_SPEC.md §5: "Click a populated berth to open a train/run popup" — berths
        // only accept clicks while occupied (see the berth <g> above), so reaching this state
        // always traces back to a real occupied-berth click, or the popup following an
        // already-tracked matched run to wherever it currently is (selectedRunId), including
        // through the brief gap right after a berth step where neither the old berth nor the new
        // one has caught up yet — trusting the tracked selection here rather than re-checking the
        // *current* berth's own description is exactly what keeps the popup open through that gap
        // instead of flickering shut on every step.
        <RunPopup
          // Keyed on the run when one's tracked, not the berth — otherwise following a run to a
          // new berth would remount the popup (a "Loading…" flash) even though nothing about the
          // selection logically changed.
          key={selectedRunId ?? selectedElementId}
          elementId={selectedElementId}
          displayName={
            selectedElement?.type === "berth" ? selectedElement.displayName : selectedElementId
          }
          tdArea={selectedBinding.split("|")[0] ?? ""}
          berth={selectedBinding.split("|")[1] ?? ""}
          onClose={() => {
            if (runLostTimeoutRef.current) {
              clearTimeout(runLostTimeoutRef.current);
              runLostTimeoutRef.current = null;
            }
            setSelectedElementId(null);
            setSelectedRunId(null);
          }}
        />
      ) : null}
    </div>
  );
}
