import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAP_CSS_TOKENS,
  MAP_STYLE,
  berthRenderRect,
  levelCrossingGeometry,
  realisticLevelCrossingGeometry,
  neutralSectionGeometry,
  placedLabelAnchor,
  pointOnPathAtX,
  pointsBounds,
  switchedDiamondGeometry,
  viaductWidth,
  sortElementsForPaint,
  type CompiledMapBundle,
  type MapElement,
  type BarrierDisplayState,
  type LevelCrossingElement,
  type NeutralSectionElement,
  type PlacedLabel,
  type PlatformElement,
  type PlatformNumberElement,
  type SignalElement,
  type SwitchedDiamondElement,
  type TunnelElement,
  type ViaductElement,
  type WaterElement,
} from "@railway/map-schema";
import type { BerthState, SignalState } from "./types.js";
import { RunPopup } from "./RunPopup.js";
import { navigate } from "../useRoute.js";

export interface MapRendererProps {
  bundle: CompiledMapBundle;
  berths: Record<string, BerthState>;
  signals: Record<string, SignalState>;
  /** Milestone 55 / ADR 0014: each bound level crossing's barrier position. A crossing missing
   * from this record renders `blank` — exactly like an unbound signal, and never a guess. */
  crossings?: Record<string, { state: BarrierDisplayState }>;
  /** ADR 0004 D5: when false, vacant berths draw nothing (berthmaps behaviour); occupied
   * berths are unaffected. Defaults to true — parity with the pre-ADR renderer. */
  showEmptyBerths?: boolean;
  /** Milestone 31: jump to and centre the initial view on this element (a places-search
   * click-through) instead of the remembered/default view. Only evaluated on first mount —
   * subsequent identical prop values don't re-centre a view the visitor has since panned away
   * from. Silently ignored if the element doesn't exist in this bundle or has no single (x, y)
   * point (e.g. a `trackPath`/`platform`, which are polylines). */
  centerElementId?: string | null;
  /** Milestone 57: in playback, the instant currently being displayed. Passed straight through
   * to `RunPopup`, which asks the API about the berth's occupancy *then* rather than now — the
   * whole reason a click on the playback map used to do nothing. `null`/omitted means live. */
  atIso?: string | null;
}

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SIGNAL_COLORS: Record<SignalState["state"], string> = MAP_STYLE.signal.stateColors;

/** Milestone 32 (folded into `label` 2026-09-13): shared click-through for a boundary link,
 * used by both a `label` carrying `adjacentMapSlug` (the current, preferred way to author one)
 * and the legacy standalone `boundary` element type still found in already-published immutable
 * map versions. Looks up the same physical boundary on the adjacent map by
 * `adjacentBoundaryName`, since the two sides typically name it differently (one map's "Carlisle
 * PSB" is the other's "Preston PSB" for the identical crossing) — falls back to this element's
 * own name/text when unset. `undefined` (no `adjacentMapSlug`) means "not a boundary link" — no
 * click handler at all. */
function boundaryClickHandler(
  adjacentMapSlug: string | undefined,
  adjacentBoundaryName: string | undefined,
  ownName: string,
): (() => void) | undefined {
  if (!adjacentMapSlug) return undefined;
  return () => {
    const boundaryName = adjacentBoundaryName ?? ownName;
    navigate(
      `/map/${encodeURIComponent(adjacentMapSlug)}?boundary=${encodeURIComponent(boundaryName)}`,
    );
  };
}

/** Occupied vs vacant. Every occupied berth is the one light blue — run-match colouring was
 * removed with the berth-run resolver (ADR 0002) and there's no matched/ambiguous distinction
 * worth showing until run↔schedule correlation is rebuilt. */
function berthColors(berthState: BerthState | undefined): { fill: string; stroke: string } {
  if (!berthState?.description) return { fill: "#161d27", stroke: "#2d3644" };
  return { fill: "#3d7fc4", stroke: "#6aa4de" };
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

/** Milestone 55: the caption a piece of map furniture carries, at the anchor
 * `placedLabelAnchor` worked out (attached to a side, or detached to a free offset). One
 * implementation so a tunnel, viaduct, water body, neutral section and level crossing all label
 * identically. Returns nothing when the element has no label. */
function placedLabelText(at: PlacedLabel, text: string | undefined, fontSize: number) {
  if (!text) return null;
  return (
    <text
      x={at.x}
      y={at.y}
      textAnchor={at.anchor}
      fontSize={fontSize}
      fill={MAP_STYLE.placedLabel.fill}
    >
      {text}
    </text>
  );
}

/** Milestone 55: track in tunnel — a dark bore with a dashed portal outline, painted under the
 * rails. Scenery: no binding, no state, nothing inferred. */
function renderTunnel(element: TunnelElement): JSX.Element {
  const style = MAP_STYLE.tunnel;
  return (
    <g key={element.id}>
      <polygon
        points={element.points.map((p) => `${p.x},${p.y}`).join(" ")}
        fill={`var(${MAP_CSS_TOKENS.tunnelFill}, ${style.fill})`}
        stroke={style.stroke}
        strokeWidth={style.strokeWidth}
        strokeDasharray={style.dash.join(" ")}
        strokeLinejoin="round"
      />
      {placedLabelText(
        placedLabelAnchor(pointsBounds(element.points), element),
        element.label,
        element.fontSize,
      )}
    </g>
  );
}

/** Milestone 55: a viaduct deck — the same polyline shape as a track path, but wider and
 * stone-coloured, and painted *beneath* the rails so the line runs over it. Never welded into
 * track geometry and never part of topology: scenery that follows the track, not track. */
function renderViaduct(element: ViaductElement): JSX.Element {
  const style = MAP_STYLE.viaduct;
  return (
    <g key={element.id}>
      <polyline
        points={element.points.map((p) => `${p.x},${p.y}`).join(" ")}
        fill="none"
        stroke={`var(${MAP_CSS_TOKENS.viaductColor}, ${style.color})`}
        strokeWidth={viaductWidth(element)}
        strokeLinejoin="round"
        strokeLinecap="butt"
        shapeRendering="geometricPrecision"
      />
      {placedLabelText(
        placedLabelAnchor(pointsBounds(element.points), element),
        element.label,
        element.fontSize,
      )}
    </g>
  );
}

/** Milestone 55: a river, dock or coastline — any orientation, painted below the track so the
 * railway crosses over it. */
function renderWater(element: WaterElement): JSX.Element {
  const style = MAP_STYLE.water;
  return (
    <g key={element.id}>
      <polygon
        points={element.points.map((p) => `${p.x},${p.y}`).join(" ")}
        fill={`var(${MAP_CSS_TOKENS.waterFill}, ${style.fill})`}
        stroke={style.stroke}
        strokeWidth={style.strokeWidth}
        strokeLinejoin="round"
      />
      {placedLabelText(
        placedLabelAnchor(pointsBounds(element.points), element),
        element.label,
        element.fontSize,
      )}
    </g>
  );
}

/**
 * Milestone 55 / ADR 0014: a level crossing — the road across the railway, plus a barrier arm
 * each side, drawn parallel to the railway (owner preference 2026-09-20). Only their colour
 * reflects the state: red = down, green = up, grey = `blank` (unbound, or a bit not currently
 * trustworthy), so the crossing still reads as a crossing without claiming a position.
 *
 * The state is whatever the bound S-Class bit says and nothing else — never derived from train
 * movements, routes, timetables or nearby signals (CLAUDE.md rule 10). These are barrier
 * positions, not signal aspects; rule 9's blank/on/off vocabulary is untouched by them.
 */
function renderLevelCrossing(
  element: LevelCrossingElement,
  barrierState: BarrierDisplayState,
): JSX.Element {
  const style = MAP_STYLE.levelCrossing;
  const geometry = levelCrossingGeometry(element, barrierState);
  const barrierColor = style.stateColors[barrierState];
  // Milestone 59 (owner decision 2026-09-21): realistic is the default for every crossing, and the
  // position is shown by the arms' pose. `up` raises them; `down` and `blank` both lower them —
  // the owner chose to draw an unknown (or unbound) crossing lowered, in full colour. The schematic
  // lines, with their grey-for-unknown, are now the per-crossing opt-out.
  if (!element.schematicBarriers) {
    return renderRealisticLevelCrossing(element, geometry, barrierState === "up" ? "up" : "down");
  }
  return (
    <g key={element.id}>
      {geometry.road.map((segment, index) => (
        <line
          key={`road-${index}`}
          x1={segment.x1}
          y1={segment.y1}
          x2={segment.x2}
          y2={segment.y2}
          stroke={`var(${MAP_CSS_TOKENS.levelCrossingRoad}, ${style.roadColor})`}
          strokeWidth={style.roadStrokeWidth}
          strokeLinecap="butt"
        />
      ))}
      {geometry.barriers.map((segment, index) => (
        <line
          key={`barrier-${index}`}
          x1={segment.x1}
          y1={segment.y1}
          x2={segment.x2}
          y2={segment.y2}
          stroke={barrierColor}
          strokeWidth={style.barrierStrokeWidth}
          strokeLinecap="round"
        />
      ))}
      {placedLabelText(geometry.label, element.label, element.fontSize)}
    </g>
  );
}

/**
 * Milestone 58/59: a level crossing drawn "realistically" — asphalt approaches with a dashed white
 * centreline, and on each side of the railway a red/white banded arm with a white picket skirt,
 * lowered across the road or raised along its edge (`realisticLevelCrossingGeometry`, shared with
 * the editor canvas per CLAUDE.md rule 13). The road edges stay the schematic ones, so the
 * crossing keeps the same outline whichever style it is drawn in.
 */
function renderRealisticLevelCrossing(
  element: LevelCrossingElement,
  geometry: ReturnType<typeof levelCrossingGeometry>,
  pose: "down" | "up",
): JSX.Element {
  const style = MAP_STYLE.levelCrossing;
  const look = style.realistic;
  const realistic = realisticLevelCrossingGeometry(element, pose);
  const line = (
    key: string,
    segment: { x1: number; y1: number; x2: number; y2: number },
    stroke: string,
    strokeWidth: number,
    extra: Record<string, string | number> = {},
  ) => (
    <line
      key={key}
      x1={segment.x1}
      y1={segment.y1}
      x2={segment.x2}
      y2={segment.y2}
      stroke={stroke}
      strokeWidth={strokeWidth}
      {...extra}
    />
  );
  return (
    <g key={element.id}>
      {realistic.surfaces.map((surface, index) => (
        <polygon
          key={`surface-${index}`}
          points={surface.map((p) => `${p.x},${p.y}`).join(" ")}
          fill={look.surfaceColor}
        />
      ))}
      {geometry.road.map((segment, index) =>
        line(
          `road-${index}`,
          segment,
          `var(${MAP_CSS_TOKENS.levelCrossingRoad}, ${style.roadColor})`,
          style.roadStrokeWidth,
          { strokeLinecap: "butt" },
        ),
      )}
      {realistic.centreline.map((segment, index) =>
        line(`centreline-${index}`, segment, look.centrelineColor, look.centrelineWidth, {
          strokeDasharray: look.centrelineDash.join(" "),
        }),
      )}
      {realistic.barriers.map((barrier, index) => (
        <g key={`barrier-${index}`}>
          {barrier.pickets.map((picket, p) =>
            line(`picket-${p}`, picket, look.skirtColor, look.picketWidth),
          )}
          {line("rail", barrier.skirtRail, look.skirtColor, look.skirtRailWidth, {
            strokeLinecap: "round",
          })}
          {line("arm", barrier.arm, look.armWhite, look.armWidth, { strokeLinecap: "butt" })}
          {line("bands", barrier.arm, look.armRed, look.armWidth, {
            strokeLinecap: "butt",
            strokeDasharray: `${barrier.bandLength} ${barrier.bandLength}`,
          })}
          <rect
            x={barrier.post.x - look.postSize / 2}
            y={barrier.post.y - look.postSize / 2}
            width={look.postSize}
            height={look.postSize}
            fill={look.postColor}
          />
        </g>
      ))}
      {placedLabelText(geometry.label, element.label, element.fontSize)}
    </g>
  );
}

/**
 * Milestone 53: an AC neutral section, drawn as Sign AJ02 Issue 1's own board — a white
 * rounded square carrying the black two-bar symbol, to the real drawing's proportions
 * (`neutralSectionGeometry`). Static authored furniture: no binding, no live state, no click
 * behaviour, nothing inferred from it (CLAUDE.md rules 9/10).
 */
function renderNeutralSection(element: NeutralSectionElement): JSX.Element {
  const style = MAP_STYLE.neutralSection;
  const geometry = neutralSectionGeometry(element);
  const symbolFill = `var(${MAP_CSS_TOKENS.neutralSectionSymbol}, ${style.symbolFill})`;
  return (
    <g key={element.id}>
      <rect
        x={geometry.board.x}
        y={geometry.board.y}
        width={geometry.board.width}
        height={geometry.board.height}
        rx={geometry.board.rx}
        fill={`var(${MAP_CSS_TOKENS.neutralSectionBoard}, ${style.boardFill})`}
        stroke={style.boardStroke}
        strokeWidth={0.5}
      />
      {geometry.bars.map((bar, index) => (
        <rect
          key={index}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={bar.height}
          fill={symbolFill}
        />
      ))}
      {placedLabelText(geometry.label, element.label, element.fontSize)}
    </g>
  );
}

/**
 * Milestone 63: a switched diamond — an open rhombus over the crossing, filled with the map
 * background so the rails beneath it are hidden (`switchedDiamondGeometry`, shared with the
 * editor). Static: it says the diamond has movable blades, never which way they lie.
 */
function renderSwitchedDiamond(element: SwitchedDiamondElement): JSX.Element {
  const style = MAP_STYLE.switchedDiamond;
  const { points } = switchedDiamondGeometry(element);
  return (
    <polygon
      key={element.id}
      data-testid={`switched-diamond-${element.id}`}
      points={points.map((p) => `${p.x},${p.y}`).join(" ")}
      fill={style.fill}
      stroke={MAP_STYLE.track.color}
      strokeWidth={style.strokeWidth}
      strokeLinejoin="miter"
      shapeRendering="geometricPrecision"
    />
  );
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

export const MIN_ZOOM_WIDTH = 100;

/** Public map view state (pan/zoom), remembered per map so returning to a map restores where
 * you were looking — like traksy.uk. `localStorage`, keyed by map id. */
const VIEW_KEY_PREFIX = "mtm.mapView.";
/** First visit renders at this fixed magnification (map units per CSS pixel) regardless of how
 * big the map is — a consistent default zoom rather than "fit everything". */
const DEFAULT_UNITS_PER_PX = 1.4;
const VIEW_SAVE_DEBOUNCE_MS = 400;

function readSavedView(mapId: string): ViewBox | null {
  try {
    const raw = window.localStorage.getItem(VIEW_KEY_PREFIX + mapId);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ViewBox>;
    if (
      typeof v.x === "number" &&
      typeof v.y === "number" &&
      typeof v.width === "number" &&
      typeof v.height === "number" &&
      v.width >= MIN_ZOOM_WIDTH &&
      Number.isFinite(v.x + v.y + v.width + v.height)
    ) {
      return { x: v.x, y: v.y, width: v.width, height: v.height };
    }
  } catch {
    /* private window / blocked storage — fall through to the default view */
  }
  return null;
}

function writeSavedView(mapId: string, v: ViewBox): void {
  try {
    window.localStorage.setItem(VIEW_KEY_PREFIX + mapId, JSON.stringify(v));
  } catch {
    /* ignore — panning still works this session */
  }
}

/** A fixed-magnification view centred on the map's content. `pxW/pxH` are the real container
 * pixel size when known (so the zoom is genuinely constant across screens); before the
 * container is measured, nominal values keep the first paint sensible. Centres on the author-set
 * `bundle.homePoint` (owner request, 2026-09-16 — "used when you click on the map from the home
 * page") when set, falling back to the bounding-box centre otherwise. */
function defaultView(bundle: CompiledMapBundle, pxW = 1200, pxH = 700): ViewBox {
  const { minX, minY, maxX, maxY } = bundle.boundingBox;
  const cx = bundle.homePoint?.x ?? (minX + maxX) / 2;
  const cy = bundle.homePoint?.y ?? (minY + maxY) / 2;
  const width = Math.max(pxW * DEFAULT_UNITS_PER_PX, MIN_ZOOM_WIDTH);
  const height = Math.max(pxH * DEFAULT_UNITS_PER_PX, MIN_ZOOM_WIDTH);
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/** A fixed-magnification view centred on an arbitrary point rather than the map's bounding box —
 * used for Milestone 31's "jump to this place from search" click-through. Same magnification
 * convention as `defaultView`. */
function pointCenteredView(x: number, y: number, pxW = 1200, pxH = 700): ViewBox {
  const width = Math.max(pxW * DEFAULT_UNITS_PER_PX, MIN_ZOOM_WIDTH);
  const height = Math.max(pxH * DEFAULT_UNITS_PER_PX, MIN_ZOOM_WIDTH);
  return { x: x - width / 2, y: y - height / 2, width, height };
}

/** The single (x, y) point of an element that has one. A points-based element (trackPath,
 * platform, and Milestone 55's tunnel/viaduct/water) has no single point, so it can't be
 * centred on — tested structurally rather than against a type list, which had already fallen
 * out of date once. Exported for Milestone 31's centering logic and unit tests. */
export function elementCenterPoint(
  element: MapElement | undefined,
): { x: number; y: number } | null {
  if (!element) return null;
  if ("points" in element) return null;
  return { x: element.x, y: element.y };
}

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

/** Basic SVG public map renderer (docs/IMPLEMENTATION_PLAN.md Milestone 5,
 * docs/MAP_EDITOR_SPEC.md §12): plain SVG, pan/zoom via viewBox manipulation, semantic style
 * tokens for signals. The full train/run popup needs the resolver (Milestone 9) — clicking a
 * berth here only shows the raw description/berth id as a stub. */
export function MapRenderer({
  bundle,
  berths,
  signals,
  crossings = {},
  showEmptyBerths = true,
  centerElementId,
  atIso = null,
}: MapRendererProps): JSX.Element {
  // `useRef`'s initial value is only ever evaluated on the first render, which is exactly "look
  // at this once, at mount" — a later change to `centerElementId` (or the visitor panning away)
  // must not keep re-centering the view underneath them.
  const initialCenterPoint = useRef<{ x: number; y: number } | null>(
    centerElementId ? elementCenterPoint(bundle.elementsById[centerElementId]) : null,
  );
  const [viewBox, setViewBox] = useState<ViewBox>(() =>
    initialCenterPoint.current
      ? pointCenteredView(initialCenterPoint.current.x, initialCenterPoint.current.y)
      : (readSavedView(bundle.mapId) ?? defaultView(bundle)),
  );
  // True if the first paint came from a remembered view (or a search jump-to-element) — the
  // mount effect then leaves it alone; false means "first ever visit", so the effect snaps it to
  // the fixed default zoom sized to the real container.
  const restoredFromStorage = useRef<boolean>(
    initialCenterPoint.current !== null || readSavedView(bundle.mapId) !== null,
  );
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

  // For a combined berth (docs/MAP_EDITOR_SPEC.md's berth section) more than one key maps to the
  // same elementId — the click-a-berth run popup shows every member's detail (Milestone 50), so
  // this collects all of them per element, sorted into combinedOrder.
  const elementIdToMembers = useMemo(() => {
    const byElement = new Map<string, Array<{ tdArea: string; berth: string; order: number }>>();
    for (const [key, elementId] of Object.entries(bundle.berthBindingIndex)) {
      const [tdArea, berth] = key.split("|");
      const list = byElement.get(elementId) ?? [];
      list.push({
        tdArea: tdArea ?? "",
        berth: berth ?? "",
        order: bundle.berthBindingOrder?.[key] ?? 1,
      });
      byElement.set(elementId, list);
    }
    const map = new Map<string, Array<{ tdArea: string; berth: string }>>();
    for (const [elementId, members] of byElement) {
      map.set(
        elementId,
        [...members]
          .sort((a, b) => a.order - b.order)
          .map(({ tdArea, berth }) => ({ tdArea, berth })),
      );
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

  function centredDefaultView(): ViewBox {
    const svg = svgRef.current;
    return defaultView(bundle, svg?.clientWidth || 1200, svg?.clientHeight || 700);
  }

  // First-ever visit to this map: once the container is measured, snap to the fixed default
  // zoom (constant magnification) centred on the content. A remembered view is left untouched.
  useEffect(() => {
    if (restoredFromStorage.current) return;
    setViewBox(centredDefaultView());
  }, [bundle.mapId]);

  // Remember where the viewer is looking, per map (traksy.uk behaviour). Debounced so a drag
  // doesn't hammer localStorage.
  useEffect(() => {
    const id = window.setTimeout(
      () => writeSavedView(bundle.mapId, viewBox),
      VIEW_SAVE_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(id);
  }, [bundle.mapId, viewBox]);

  function resetView(): void {
    try {
      window.localStorage.removeItem(VIEW_KEY_PREFIX + bundle.mapId);
    } catch {
      /* ignore */
    }
    setViewBox(centredDefaultView());
  }

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

  const selectedMembers = selectedElementId ? elementIdToMembers.get(selectedElementId) : undefined;
  const selectedElement = selectedElementId ? bundle.elementsById[selectedElementId] : undefined;

  return (
    <div className="map-frame">
      <svg
        ref={svgRef}
        role="img"
        aria-label={`${bundle.mapName} schematic map`}
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        preserveAspectRatio="xMidYMid meet"
        style={{
          background: "#0d1117",
          cursor: drag || pinch ? "grabbing" : "grab",
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
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
            const lines = element.name.split("\n");
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
                {lines.map((line, i) => (
                  <tspan key={i} x={element.x} dy={i === 0 ? 0 : "1.2em"}>
                    {line}
                    {i === lines.length - 1 && element.crs ? ` [${element.crs}]` : ""}
                  </tspan>
                ))}
              </text>
            );
          }
          if (element.type === "berth") {
            const rawBerthState = berths[element.id];
            const inhibitingState = element.inhibitedBy ? berths[element.inhibitedBy] : undefined;
            // Opt-in TD-area fringe pairs (2026-09-11 owner request, BerthElementSchema.inhibitedBy):
            // when the berth this one is inhibited by currently shows the identical description,
            // render this berth exactly as if vacant. Purely cosmetic — `berths` (live state),
            // history, and playback all keep this berth's real data untouched; only what gets
            // drawn here changes.
            const isInhibited =
              Boolean(rawBerthState?.description) &&
              rawBerthState?.description === inhibitingState?.description;
            const berthState = isInhibited ? undefined : rawBerthState;
            const colors = berthColors(berthState);
            // An empty berth has nothing to show a popup for — only occupied berths respond to
            // clicks (docs/PROJECT_SPEC.md §5: "click a populated berth").
            const isOccupied = Boolean(berthState?.description);
            // Re-enabled (Milestone 34, docs/adr/0006) — was temporarily disabled 2026-09-12
            // pending the resolver rebuild the popup depends on; that's what `resolveRunMatch`/
            // the position-scoped `currentRun.ts` now is.
            const clickEnabled = true;
            // ADR 0004 D5: a vacant berth can be hidden entirely (berthmaps style).
            if (!isOccupied && !showEmptyBerths) return null;
            // ADR 0004 D1: centre the box on its bound track rather than trusting the authored
            // top-left y.
            const rect = berthRenderRect(element, bundle.elementsById);
            return (
              <g
                key={element.id}
                onClick={
                  isOccupied && clickEnabled ? () => setSelectedElementId(element.id) : undefined
                }
                style={{ cursor: isOccupied && clickEnabled ? "pointer" : "default" }}
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
            // Labels wrap on explicit newlines (`\n`) — each becomes a <tspan> on the next line.
            const lines = element.text.split("\n");
            // Milestone 32 (folded into `label` 2026-09-13): a label carrying `adjacentMapSlug`
            // is a boundary link — clickable, normal label style (owner preference), no circle
            // marker the old standalone `boundary` type drew.
            const handleClick = boundaryClickHandler(
              element.adjacentMapSlug,
              element.adjacentBoundaryName,
              element.text,
            );
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
                onClick={handleClick}
                style={{ cursor: handleClick ? "pointer" : undefined }}
              >
                {lines.map((line, i) => (
                  <tspan key={i} x={element.x} dy={i === 0 ? 0 : "1.2em"}>
                    {line === "" ? " " : line}
                  </tspan>
                ))}
              </text>
            );
          }
          if (element.type === "neutralSection") {
            return renderNeutralSection(element);
          }
          if (element.type === "tunnel") {
            return renderTunnel(element);
          }
          if (element.type === "viaduct") {
            return renderViaduct(element);
          }
          if (element.type === "water") {
            return renderWater(element);
          }
          if (element.type === "levelCrossing") {
            return renderLevelCrossing(element, crossings[element.id]?.state ?? "blank");
          }
          if (element.type === "switchedDiamond") {
            return renderSwitchedDiamond(element);
          }
          if (element.type === "boundary") {
            // Legacy — superseded by `label`'s adjacent* fields (see boundaryClickHandler);
            // kept rendering only for already-published immutable versions that still have one.
            const handleClick = boundaryClickHandler(
              element.adjacentMapSlug,
              element.adjacentBoundaryName,
              element.name,
            );
            return (
              <g
                key={element.id}
                onClick={handleClick}
                style={{ cursor: handleClick ? "pointer" : "default" }}
              >
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

      <button
        type="button"
        className="map-frame__reset"
        onClick={resetView}
        title="Reset to the default view"
      >
        Reset view
      </button>

      {selectedElementId && selectedMembers && selectedMembers.length > 0 ? (
        // docs/PROJECT_SPEC.md §5: "Click a populated berth to open a train/run popup".
        <RunPopup
          key={selectedElementId}
          elementId={selectedElementId}
          displayName={
            selectedElement?.type === "berth" ? selectedElement.displayName : selectedElementId
          }
          tdArea={selectedMembers[0]!.tdArea}
          berth={selectedMembers[0]!.berth}
          members={selectedMembers}
          atIso={atIso}
          onClose={() => setSelectedElementId(null)}
        />
      ) : null}
    </div>
  );
}
