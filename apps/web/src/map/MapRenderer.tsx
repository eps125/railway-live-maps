import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  type RouteElement,
  type SignalElement,
  type SwitchedDiamondElement,
  type TrackPathElement,
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
  /** Milestone 64 / ADR 0016: each route's state. Only a route that is `set` is drawn; a route
   * missing from this record draws nothing. */
  routes?: Record<string, { state: "blank" | "set" | "unset" }>;
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
  /** Milestone 65: elements to mark on the map for the admin S-Class mini explorer — an amber
   * ring round a signal, crossing or other point element, an amber band under a route. A visual
   * reference only; it never changes any element's state. */
  highlightElementIds?: ReadonlyArray<string>;
  /** Milestone 65: in playback, the position a boundary link carries to the adjacent map so it
   * opens in playback at the same moment, instead of going back to live. Null or absent: live. */
  playbackLink?: { atIso: string; speed: number; playing: boolean } | null;
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
  playbackLink: MapRendererProps["playbackLink"] = null,
): (() => void) | undefined {
  if (!adjacentMapSlug) return undefined;
  return () => {
    navigate(boundaryLinkUrl(adjacentMapSlug, adjacentBoundaryName ?? ownName, playbackLink));
  };
}

/** Milestone 65 (owner request 2026-09-22): the adjacent map's URL for a boundary link. In
 * playback it carries the clock (`at`), `speed` and whether it was playing, so the adjacent map
 * opens in playback at the same moment rather than dropping back to live. */
export function boundaryLinkUrl(
  adjacentMapSlug: string,
  boundaryName: string,
  playbackLink: MapRendererProps["playbackLink"] = null,
): string {
  // Built by hand rather than with URLSearchParams, which would write spaces as "+": existing
  // links (and bookmarks of them) use %20.
  let url = `/map/${encodeURIComponent(adjacentMapSlug)}?boundary=${encodeURIComponent(boundaryName)}`;
  if (playbackLink) {
    url += `&at=${encodeURIComponent(playbackLink.atIso)}&speed=${playbackLink.speed}`;
    if (playbackLink.playing) url += "&play=1";
  }
  return url;
}

/** Occupied vs vacant. Every occupied berth is the one light blue — run-match colouring was
 * removed with the berth-run resolver (ADR 0002) and there's no matched/ambiguous distinction
 * worth showing until run↔schedule correlation is rebuilt. */
function berthColors(description: string | undefined): { fill: string; stroke: string } {
  if (!description) return { fill: "#161d27", stroke: "#2d3644" };
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
 * Milestone 63 (revised): a switched diamond's marks — a filled knuckle or blade ticks in each
 * switched obtuse corner — fitted to the crossing from the drawn tracks (`switchedDiamondGeometry`,
 * shared with the editor). Not on a crossing: nothing. Static: it says the diamond has movable
 * blades, never which way they lie.
 */
function renderSwitchedDiamond(
  element: SwitchedDiamondElement,
  tracks: ReadonlyArray<{ points: ReadonlyArray<{ x: number; y: number }> }>,
): JSX.Element | null {
  const geometry = switchedDiamondGeometry(element, tracks);
  if (!geometry) return null;
  const color = MAP_STYLE.track.color;
  return (
    <g key={element.id} data-testid={`switched-diamond-${element.id}`}>
      {geometry.knuckles.map((knuckle, index) => (
        <polygon
          key={index}
          points={knuckle.map((p) => `${p.x},${p.y}`).join(" ")}
          fill={color}
          shapeRendering="geometricPrecision"
        />
      ))}
      {geometry.ticks.map((tick, index) => (
        <line
          key={index}
          x1={tick.x1}
          y1={tick.y1}
          x2={tick.x2}
          y2={tick.y2}
          stroke={color}
          strokeWidth={MAP_STYLE.switchedDiamond.tickWidth}
          strokeLinecap="butt"
        />
      ))}
    </g>
  );
}

/**
 * Milestone 64 / ADR 0016 decision 5: a set route, laid over its track as a solid off-white line
 * with a dark dash on top, the width of the track — green-and-black dashes along the rail. Pure
 * display of the traced line; the renderer does no path-finding.
 */
function renderSetRoute(element: RouteElement): JSX.Element {
  const points = element.points.map((p) => `${p.x},${p.y}`).join(" ");
  const style = MAP_STYLE.route;
  return (
    <g key={element.id} data-testid={`route-${element.id}`}>
      <polyline
        points={points}
        fill="none"
        stroke={style.color}
        strokeWidth={MAP_STYLE.track.strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="butt"
      />
      <polyline
        points={points}
        fill="none"
        stroke={style.dashColor}
        strokeWidth={MAP_STYLE.track.strokeWidth}
        strokeDasharray={style.dash.join(" ")}
        strokeLinejoin="round"
        strokeLinecap="butt"
      />
    </g>
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

/** Milestone 73: nominal container size used before the real one is measured (first render, and
 * a hidden or zero-size container, where dividing by the real width would give NaN). */
const NOMINAL_WIDTH = 1200;
const NOMINAL_HEIGHT = 700;
/** How far out the viewer may zoom, as a fraction of "the whole map fits the window". */
const MIN_FIT_FRACTION = 0.25;

/** Milestone 73: the view as the renderer tracks it — the map point at the middle of the window,
 * and the magnification in CSS pixels per map unit. */
export interface MapView {
  cx: number;
  cy: number;
  scale: number;
}

/** Pure: the map-unit rectangle a view shows in a window of `w` × `h` pixels. This is also the
 * shape the remembered view is stored in, so views saved before Milestone 73 still restore. */
export function viewToViewBox(view: MapView, w: number, h: number): ViewBox {
  const width = w / view.scale;
  const height = h / view.scale;
  return { x: view.cx - width / 2, y: view.cy - height / 2, width, height };
}

/** Pure: the view that shows `box` in a `w` × `h` window — centred on it, fitted the way SVG's
 * `xMidYMid meet` fitted the old viewBox. */
export function viewBoxToView(box: ViewBox, w: number, h: number): MapView {
  return {
    cx: box.x + box.width / 2,
    cy: box.y + box.height / 2,
    scale: Math.min(w / box.width, h / box.height),
  };
}

/** Pure: keep the magnification between "`MIN_ZOOM_WIDTH` map units fill the window" and "the
 * whole map fits in `MIN_FIT_FRACTION` of it". */
export function clampScale(
  scale: number,
  w: number,
  h: number,
  world: { width: number; height: number },
): number {
  const max = Math.min(w, h) / MIN_ZOOM_WIDTH;
  const fit = Math.min(w / Math.max(world.width, 1), h / Math.max(world.height, 1));
  const min = Math.min(fit * MIN_FIT_FRACTION, max);
  if (!Number.isFinite(scale)) return Math.min(Math.max(fit, min), max);
  return Math.min(Math.max(scale, min), max);
}

/** Pure: how much one wheel event zooms, as a factor on the magnification (> 1 zooms in). In
 * proportion to the distance scrolled, so a mouse notch (~100 px) zooms about 10% and a
 * touchpad's small deltas zoom smoothly; a touchpad pinch (reported as ctrl+wheel) is more
 * sensitive. Line- and page-mode deltas are converted to pixels. Capped per event. */
export function wheelZoomFactor(
  event: { deltaY: number; deltaMode: number; ctrlKey: boolean },
  pageHeight: number,
): number {
  const px =
    event.deltaMode === 1
      ? event.deltaY * 16
      : event.deltaMode === 2
        ? event.deltaY * pageHeight
        : event.deltaY;
  const factor = Math.exp(-px * (event.ctrlKey ? 0.01 : 0.001));
  return Math.min(Math.max(factor, 0.5), 2);
}

/** Pure: the view after zooming to `scale`, keeping the map point `(dx, dy)` pixels from the
 * middle of the window where it is — zoom towards the pointer. */
export function zoomAroundPoint(view: MapView, dx: number, dy: number, scale: number): MapView {
  const x = view.cx + dx / view.scale;
  const y = view.cy + dy / view.scale;
  return { cx: x - dx / scale, cy: y - dy / scale, scale };
}

const EMPTY_RECORD = {};
const EMPTY_IDS: ReadonlyArray<string> = [];

/** Milestone 73: one berth, memoised so a live update only re-renders the berths whose display
 * actually changed. `description` is what is shown (already blanked if inhibited). */
const BerthNode = memo(function BerthNode({
  id,
  rect,
  description,
  fontSize,
  onSelect,
}: {
  id: string;
  rect: { x: number; y: number; width: number; height: number };
  description: string | undefined;
  fontSize: number;
  onSelect: (id: string) => void;
}): JSX.Element {
  const colors = berthColors(description);
  // An empty berth has nothing to show a popup for — only occupied berths respond to clicks
  // (docs/PROJECT_SPEC.md §5: "click a populated berth"). Re-enabled in Milestone 34 (ADR 0006).
  const isOccupied = Boolean(description);
  return (
    <g
      onClick={isOccupied ? () => onSelect(id) : undefined}
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
        fontSize={fontSize}
        fill={description ? "#04101f" : "#8b96a5"}
        fontWeight={description ? 700 : 400}
      >
        {description ?? ""}
      </text>
    </g>
  );
});

/** Milestone 73: one signal, memoised on its state. */
const SignalNode = memo(function SignalNode({
  element,
  state,
}: {
  element: SignalElement;
  state: SignalState["state"];
}): JSX.Element {
  return renderSignal(element, state);
});

/** An element that never changes while the map is shown — drawn once per bundle. Anything with
 * live state (berths, signals, crossings, routes) or a playback-dependent click (labels,
 * boundaries) is drawn separately. Returns `undefined` for those. */
function renderStaticElement(
  element: MapElement,
  elementsById: Record<string, MapElement>,
  trackPaths: ReadonlyArray<TrackPathElement>,
): JSX.Element | null | undefined {
  switch (element.type) {
    case "trackPath":
      // ADR 0004 D2/D4: the compiler has already welded topology-joined segments into single
      // polylines, so a round `stroke-linejoin` closes every diagonal↔horizontal corner — no
      // junction dots, matching OpenTrainTimes. Caps stay `butt`.
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
    case "platform":
      return renderPlatform(element, elementsById);
    case "platformNumber":
      return renderPlatformNumber(element);
    case "station": {
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
    case "neutralSection":
      return renderNeutralSection(element);
    case "tunnel":
      return renderTunnel(element);
    case "viaduct":
      return renderViaduct(element);
    case "water":
      return renderWater(element);
    case "switchedDiamond":
      return renderSwitchedDiamond(element, trackPaths);
    default:
      return undefined;
  }
}

/** Basic SVG public map renderer (docs/IMPLEMENTATION_PLAN.md Milestone 5,
 * docs/MAP_EDITOR_SPEC.md §12): plain SVG, semantic style tokens for signals.
 *
 * Milestone 73 (owner report 2026-09-26: "scrolling is very slow, particularly on Carlisle"):
 * the map is drawn once, at a fixed `viewBox` covering the whole map, inside a native scroll
 * container — the way traksy.uk does it. Panning is the browser's own scrolling (a drag just sets
 * `scrollLeft`/`scrollTop`), so it runs no React at all; zooming changes only the SVG's pixel
 * size. Previously every mouse move re-rendered and re-measured all ~1,400 elements (measured
 * ~380 ms per step on Carlisle). Static elements are now drawn once per bundle, and berths and
 * signals are memoised so a live update re-renders only what changed.
 *
 * The canvas is padded by half the window on every side, so any map point can be scrolled to
 * the middle, and a view maps to the scroll position exactly: `scrollLeft = (cx − minX) × scale`.
 */
export function MapRenderer({
  bundle,
  berths,
  signals,
  crossings = EMPTY_RECORD,
  routes = EMPTY_RECORD,
  showEmptyBerths = true,
  centerElementId,
  atIso = null,
  highlightElementIds = EMPTY_IDS,
  playbackLink = null,
}: MapRendererProps): JSX.Element {
  const world = useMemo(() => {
    const { minX, minY, maxX, maxY } = bundle.boundingBox;
    return { x: minX, y: minY, width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
  }, [bundle]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  /** The real window size, or the nominal one while it can't be measured. */
  function windowSize(): { w: number; h: number } {
    const el = scrollRef.current;
    return { w: el?.clientWidth || NOMINAL_WIDTH, h: el?.clientHeight || NOMINAL_HEIGHT };
  }

  /** Where to start: an explicit element to centre on (Milestone 31), else the remembered view,
   * else the fixed-magnification default. Worked out for a given window size. */
  function startingView(w: number, h: number): { view: MapView; remembered: boolean } {
    const centre = centerElementId
      ? elementCenterPoint(bundle.elementsById[centerElementId])
      : null;
    if (centre)
      return {
        view: viewBoxToView(pointCenteredView(centre.x, centre.y, w, h), w, h),
        remembered: true,
      };
    const saved = readSavedView(bundle.mapId);
    if (saved) return { view: viewBoxToView(saved, w, h), remembered: true };
    return { view: viewBoxToView(defaultView(bundle, w, h), w, h), remembered: false };
  }

  const view = useRef<MapView | null>(null);
  if (view.current === null) {
    view.current = startingView(NOMINAL_WIDTH, NOMINAL_HEIGHT).view;
  }
  const [scale, setScale] = useState(view.current.scale);
  const [windowPx, setWindowPx] = useState({ w: NOMINAL_WIDTH, h: NOMINAL_HEIGHT });
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);

  const gesture = useRef<
    | { kind: "drag"; startX: number; startY: number; origin: MapView }
    | { kind: "pinch"; startDistance: number; origin: MapView }
    | null
  >(null);
  const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const saveTimer = useRef<number | undefined>(undefined);

  /** Publishes the current view (for tests and debugging) and remembers it, debounced so a drag
   * doesn't hammer localStorage (traksy.uk behaviour). */
  function viewChanged(): void {
    const { w, h } = windowSize();
    const box = viewToViewBox(view.current!, w, h);
    svgRef.current?.setAttribute("data-view", `${box.x} ${box.y} ${box.width} ${box.height}`);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(
      () => writeSavedView(bundle.mapId, box),
      VIEW_SAVE_DEBOUNCE_MS,
    );
  }

  /** Scrolls the window to the current view. The browser clamps at the edges; the scroll event
   * that follows reads the clamped position back into the view. */
  function applyScroll(): void {
    const el = scrollRef.current;
    const v = view.current!;
    if (el) {
      el.scrollLeft = (v.cx - world.x) * v.scale;
      el.scrollTop = (v.cy - world.y) * v.scale;
    }
    viewChanged();
  }

  function setView(next: MapView): void {
    const { w, h } = windowSize();
    view.current = { ...next, scale: clampScale(next.scale, w, h, world) };
    if (view.current.scale !== scale) setScale(view.current.scale);
    else applyScroll();
  }

  // Once mounted: measure the real window, and settle the starting view for it (a first-ever
  // visit snaps to the fixed default zoom sized to the real window; a remembered view keeps its
  // magnification). Then keep the window size current.
  useLayoutEffect(() => {
    const { w, h } = windowSize();
    setWindowPx({ w, h });
    const start = startingView(w, h);
    view.current = { ...start.view, scale: clampScale(start.view.scale, w, h, world) };
    setScale(view.current.scale);
    applyScroll();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const size = windowSize();
      setWindowPx((current) => (current.w === size.w && current.h === size.h ? current : size));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      window.clearTimeout(saveTimer.current);
    };
  }, [bundle.mapId]);

  // Whenever the magnification or the window changes, the canvas has been resized: scroll so the
  // same map point stays in the middle.
  const renderedScale = useRef(scale);
  useLayoutEffect(() => {
    renderedScale.current = scale;
    applyScroll();
  }, [scale, windowPx.w, windowPx.h]);

  function onScroll(): void {
    const el = scrollRef.current;
    const v = view.current;
    if (!el || !v || gesture.current?.kind === "pinch") return;
    // A zoom is waiting to be drawn: this scroll position belongs to the old size, so reading it
    // at the new scale would move the view. The zoom's own scroll follows once it is drawn.
    if (v.scale !== renderedScale.current) return;
    v.cx = world.x + el.scrollLeft / v.scale;
    v.cy = world.y + el.scrollTop / v.scale;
    viewChanged();
  }

  function resetView(): void {
    try {
      window.localStorage.removeItem(VIEW_KEY_PREFIX + bundle.mapId);
    } catch {
      /* ignore */
    }
    const { w, h } = windowSize();
    setView(viewBoxToView(defaultView(bundle, w, h), w, h));
  }

  // The wheel zooms towards the mouse pointer (2026-09-26: zooming round the middle of the window
  // made the map seem to jump about on a PC). Each event zooms in proportion to how far the wheel
  // or touchpad actually moved, and events are gathered into one zoom per animation frame, so a
  // touchpad's stream of tiny events is smooth rather than a queue of full-map redraws. A mainly
  // sideways swipe (or shift+wheel) is left to the browser, so it scrolls natively. A real,
  // non-passive listener, because React's synthetic onWheel is passive and can't preventDefault.
  const pendingZoom = useRef<{ factor: number; dx: number; dy: number } | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    function applyZoom(): void {
      frame = 0;
      const pending = pendingZoom.current;
      pendingZoom.current = null;
      if (!pending) return;
      const v = view.current!;
      const { w, h } = windowSize();
      const target = clampScale(v.scale * pending.factor, w, h, world);
      setView(zoomAroundPoint(v, pending.dx, pending.dy, target));
    }
    function onWheel(event: WheelEvent): void {
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      const rect = el!.getBoundingClientRect();
      const { w, h } = windowSize();
      const factor = wheelZoomFactor(event, h);
      // The pointer's offset from the middle of the window (0 when it can't be measured).
      const dx = rect.width > 0 ? event.clientX - rect.left - w / 2 : 0;
      const dy = rect.height > 0 ? event.clientY - rect.top - h / 2 : 0;
      pendingZoom.current = {
        factor: (pendingZoom.current?.factor ?? 1) * factor,
        dx: Number.isFinite(dx) ? dx : 0,
        dy: Number.isFinite(dy) ? dy : 0,
      };
      if (!frame) frame = requestAnimationFrame(applyZoom);
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (frame) cancelAnimationFrame(frame);
    };
  });

  function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function setGrabbing(on: boolean): void {
    if (scrollRef.current) scrollRef.current.style.cursor = on ? "grabbing" : "grab";
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    // Deliberately no setPointerCapture here (tried it, reverted 2026-08-11): capturing on
    // every pointerdown — including a plain tap that lands on a berth — broke the click event a
    // berth's own onClick depends on to open the popup.
    activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.current.size === 2) {
      // A second finger landing supersedes any single-finger pan already in progress.
      const [a, b] = [...activePointers.current.values()];
      gesture.current = {
        kind: "pinch",
        startDistance: pointerDistance(a!, b!),
        origin: { ...view.current! },
      };
    } else if (activePointers.current.size === 1) {
      gesture.current = {
        kind: "drag",
        startX: event.clientX,
        startY: event.clientY,
        origin: { ...view.current! },
      };
      setGrabbing(true);
    }
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    if (!activePointers.current.has(event.pointerId)) return;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const g = gesture.current;
    if (g?.kind === "pinch" && activePointers.current.size === 2) {
      const [a, b] = [...activePointers.current.values()];
      const { w, h } = windowSize();
      const next = viewBoxAfterPinch(
        { startDistance: g.startDistance, origin: viewToViewBox(g.origin, w, h) },
        pointerDistance(a!, b!),
      );
      if (next) setView({ ...g.origin, scale: viewBoxToView(next, w, h).scale });
      return;
    }
    if (g?.kind === "drag" && activePointers.current.size === 1) {
      // Pixels map straight onto scroll: no React render, just a scroll position.
      view.current = {
        ...g.origin,
        cx: g.origin.cx - (event.clientX - g.startX) / g.origin.scale,
        cy: g.origin.cy - (event.clientY - g.startY) / g.origin.scale,
      };
      applyScroll();
    }
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    activePointers.current.delete(event.pointerId);
    gesture.current = null;
    setGrabbing(false);
    // One finger still down after the other lifts — resume panning from where it is now rather
    // than jumping back to wherever the very first pointerdown in this gesture happened.
    if (activePointers.current.size === 1) {
      const [remaining] = [...activePointers.current.values()];
      gesture.current = {
        kind: "drag",
        startX: remaining!.x,
        startY: remaining!.y,
        origin: { ...view.current! },
      };
    }
  }

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
  // public renderer and editor preview share the same domain model/state semantics) — paint
  // order is computed explicitly via the same shared function EditorCanvas.tsx uses. A layer with
  // no explicit `visible: false` (including one this bundle doesn't list at all) still renders.
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
  // Milestone 63: switched diamonds fit themselves to the crossing of the drawn tracks.
  const trackPaths = useMemo(
    () =>
      Object.values(bundle.elementsById).filter(
        (element): element is TrackPathElement => element.type === "trackPath",
      ),
    [bundle],
  );

  // Milestone 73: everything that can't change while the map is shown, drawn once per bundle.
  const staticNodes = useMemo(() => {
    const nodes = new Map<string, JSX.Element | null>();
    for (const element of elements) {
      const node = renderStaticElement(element, bundle.elementsById, trackPaths);
      if (node !== undefined) nodes.set(element.id, node);
    }
    return nodes;
  }, [elements, bundle, trackPaths]);

  // ADR 0004 D1: each berth is centred on its bound track rather than trusting the authored top-
  // left y. Worked out once per bundle — for a berth with no bound track it searches every track.
  const berthRects = useMemo(() => {
    const rects = new Map<string, ReturnType<typeof berthRenderRect>>();
    for (const element of elements) {
      if (element.type === "berth")
        rects.set(element.id, berthRenderRect(element, bundle.elementsById));
    }
    return rects;
  }, [elements, bundle]);

  const selectBerth = useCallback((id: string) => setSelectedElementId(id), []);

  // The map's content. Re-evaluated only when live state (or the bundle) changes — never on a
  // scroll or zoom — and even then static elements are reused as-is.
  const content = useMemo(
    () =>
      elements.map((element) => {
        if (staticNodes.has(element.id)) return staticNodes.get(element.id)!;
        if (element.type === "berth") {
          const rawDescription = berths[element.id]?.description;
          // Opt-in TD-area fringe pairs (2026-09-11 owner request, BerthElementSchema.inhibitedBy):
          // when the berth this one is inhibited by currently shows the identical description,
          // render this berth exactly as if vacant. Purely cosmetic — live state, history and
          // playback all keep this berth's real data untouched; only what gets drawn changes.
          const inhibiting = element.inhibitedBy ? berths[element.inhibitedBy] : undefined;
          const description =
            rawDescription && rawDescription === inhibiting?.description
              ? undefined
              : rawDescription || undefined;
          // ADR 0004 D5: a vacant berth can be hidden entirely (berthmaps style).
          if (!description && !showEmptyBerths) return null;
          return (
            <BerthNode
              key={element.id}
              id={element.id}
              rect={berthRects.get(element.id)!}
              description={description}
              fontSize={element.fontSize}
              onSelect={selectBerth}
            />
          );
        }
        if (element.type === "signal") {
          return (
            <SignalNode
              key={element.id}
              element={element}
              state={signals[element.id]?.state ?? "blank"}
            />
          );
        }
        if (element.type === "label") {
          // Labels wrap on explicit newlines (`\n`) — each becomes a <tspan> on the next line.
          const lines = element.text.split("\n");
          // Milestone 32 (folded into `label` 2026-09-13): a label carrying `adjacentMapSlug`
          // is a boundary link — clickable, normal label style (owner preference).
          const handleClick = boundaryClickHandler(
            element.adjacentMapSlug,
            element.adjacentBoundaryName,
            element.text,
            playbackLink,
          );
          return (
            <text
              key={element.id}
              x={element.x}
              y={element.y}
              textAnchor={
                element.align === "center" ? "middle" : element.align === "right" ? "end" : "start"
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
        if (element.type === "levelCrossing") {
          return renderLevelCrossing(element, crossings[element.id]?.state ?? "blank");
        }
        if (element.type === "route") {
          // Milestone 64 / ADR 0016: drawn only while its bound bit says it is set. Blank and
          // unset draw nothing — the plain track underneath is the "no route" picture.
          return routes[element.id]?.state === "set" ? renderSetRoute(element) : null;
        }
        if (element.type === "boundary") {
          // Legacy — superseded by `label`'s adjacent* fields (see boundaryClickHandler);
          // kept rendering only for already-published immutable versions that still have one.
          const handleClick = boundaryClickHandler(
            element.adjacentMapSlug,
            element.adjacentBoundaryName,
            element.name,
            playbackLink,
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
      }),
    [
      elements,
      staticNodes,
      berthRects,
      berths,
      signals,
      crossings,
      routes,
      showEmptyBerths,
      playbackLink?.atIso,
      playbackLink?.speed,
      playbackLink?.playing,
      selectBerth,
    ],
  );

  const highlight = useMemo(
    () =>
      highlightElementIds.length > 0 ? (
        <g className="map-highlight" data-testid="map-highlight" pointerEvents="none">
          {highlightElementIds.map((id) => {
            const element = bundle.elementsById[id];
            if (!element) return null;
            if ("points" in element) {
              return (
                <polyline
                  key={id}
                  points={element.points.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke="#f0b429"
                  strokeWidth={MAP_STYLE.track.strokeWidth + 6}
                  strokeOpacity={0.55}
                  strokeLinejoin="round"
                />
              );
            }
            return (
              <circle
                key={id}
                cx={element.x}
                cy={element.y}
                r={14}
                fill="none"
                stroke="#f0b429"
                strokeWidth={2.5}
              />
            );
          })}
        </g>
      ) : null,
    [highlightElementIds, bundle],
  );

  const selectedMembers = selectedElementId ? elementIdToMembers.get(selectedElementId) : undefined;
  const selectedElement = selectedElementId ? bundle.elementsById[selectedElementId] : undefined;

  return (
    <div className="map-frame">
      <div
        ref={scrollRef}
        className="map-frame__scroll"
        style={{ cursor: "grab", touchAction: "none" }}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <div
          className="map-frame__canvas"
          style={{ padding: `${windowPx.h / 2}px ${windowPx.w / 2}px` }}
        >
          <svg
            ref={svgRef}
            role="img"
            aria-label={`${bundle.mapName} schematic map`}
            viewBox={`${world.x} ${world.y} ${world.width} ${world.height}`}
            width={world.width * scale}
            height={world.height * scale}
            style={{ background: "#0d1117" }}
          >
            {content}
            {highlight}
          </svg>
        </div>
      </div>

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
