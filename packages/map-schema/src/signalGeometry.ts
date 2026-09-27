import type { MapElement, SignalElement } from "./document.js";
import { stopBoardParts, type DrawPrimitive } from "./drawing.js";
import { berthRenderRect, type Rect } from "./geometry.js";
import { MAP_STYLE } from "./style.js";

/**
 * ADR 0017: signal types, the L-shaped post, the signal number's default place, and the rules the
 * bulk signal tool applies. Pure and shared by the public renderer and the editor canvas, so both
 * draw exactly the same shapes (CLAUDE.md rule 13).
 *
 * Coordinates are relative to the signal's own (x, y), which sits on the track centre line. Map
 * y grows downwards, so "above" the track is negative y.
 */

export type SignalType = "main" | "subsidiary" | "distant" | "stopBoard";
export type SignalDisplayState = "blank" | "on" | "off";

/** The colour a signal of `type` is drawn in for `state` — only ever the bound bit's on/off. */
export function signalColor(type: SignalType | undefined, state: SignalDisplayState): string {
  // A depot stop board has no state: it is always its board's red.
  if (type === "stopBoard") return MAP_STYLE.signal.stopBoard.red;
  return MAP_STYLE.signal.typeColors[type ?? "main"][state];
}

export type SignalHead =
  | { kind: "circle"; cx: number; cy: number; r: number }
  /** `path` is SVG path data (also accepted by Konva's `Path`). */
  | { kind: "quadrant"; path: string }
  /** A stop board: draw `parts` translated to (x, y) and turned by `rotation` degrees. */
  | { kind: "board"; x: number; y: number; rotation: number; parts: DrawPrimitive[] };

export interface SignalPostGeometry {
  appliesTo: "right" | "left";
  side: "above" | "below";
  /** The post as a polyline: track edge → top of the stem → end of the arm. Null for a stop
   * board, which has no post. */
  post: [number, number, number, number, number, number] | null;
  head: SignalHead;
  /** Where the head is centred (for the editor's bound-state ring). */
  headCentre: { x: number; y: number };
  /** 2026-09-27 (owner): a thin gap in the map's background colour round the post and head, so a
   * signal stands out over a platform. Draw the post polyline `postWidth` wide and the head
   * stroked `headStroke` wide, both in `color`, before the real post and head. (A board carries
   * its own cut-out as its first part.) */
  cutout: { color: string; postWidth: number; headStroke: number };
  /** The number's default anchor point and text alignment (the number runs back along the berth
   * the signal protects, ending at the post). */
  label: { x: number; y: number; anchor: "start" | "end" };
}

/** Which side the post stands when only the direction is known: the owner's default rule. */
export function defaultSideFor(appliesTo: "right" | "left"): "above" | "below" {
  return appliesTo === "right" ? "above" : "below";
}

/**
 * The post, head and default number position for a signal that has a direction, or null for one
 * that doesn't (it keeps drawing as it did before ADR 0017).
 */
export function signalPostGeometry(
  signal: Pick<SignalElement, "appliesTo" | "side" | "signalType">,
): SignalPostGeometry | null {
  // A stop board is only drawn beside the track; one not yet given a direction faces right.
  if (!signal.appliesTo && signal.signalType !== "stopBoard") return null;
  const appliesTo = signal.appliesTo ?? "right";
  const side = signal.side ?? defaultSideFor(appliesTo);
  // f: along the track in the direction of travel; a: away from the track.
  const f = appliesTo === "right" ? 1 : -1;
  const a = side === "above" ? -1 : 1;
  const { rise, arm } = MAP_STYLE.signal.post;
  const edge = MAP_STYLE.track.strokeWidth / 2;
  const armY = a * (edge + rise);
  const armX = f * arm;
  const cut = MAP_STYLE.signal.cutout;
  const cutout = {
    color: cut.color,
    postWidth: MAP_STYLE.signal.post.width + 2 * cut.width,
    headStroke: 2 * cut.width,
  };
  const label = {
    x: -f * 1,
    y: a * MAP_STYLE.signal.number.labelBand,
    anchor: f > 0 ? ("end" as const) : ("start" as const),
  };

  if (signal.signalType === "stopBoard") {
    // 2026-09-27 (owner): no post — the board lies along the track `gap` from its edge, as long
    // as a post and head, turned so its red disc leads in the direction of travel.
    const b = MAP_STYLE.signal.stopBoard;
    const centre = { x: (f * b.length) / 2, y: a * (edge + b.gap + b.depth / 2) };
    return {
      appliesTo,
      side,
      post: null,
      head: { kind: "board", ...centre, rotation: 90 * f, parts: stopBoardParts() },
      headCentre: centre,
      cutout,
      label,
    };
  }

  const post: [number, number, number, number, number, number] = [0, a * edge, 0, armY, armX, armY];

  let head: SignalHead;
  let headCentre: { x: number; y: number };
  if (signal.signalType === "subsidiary") {
    // Quarter-circle as wide as a main head: its flat edge faces the track, the arm meets the
    // middle of the other flat edge, and the curve leads in the direction of travel.
    const r = MAP_STYLE.signal.subsidiaryRadius;
    const half = r / 2;
    const cornerY = armY - a * half; // the corner nearest the track
    const farY = armY + a * half; // the end of the flat edge away from the track
    const tipX = armX + f * r;
    // Mirroring one axis reverses the arc's direction; mirroring both (a 180° turn) doesn't.
    const sweep = f * a < 0 ? 1 : 0;
    head = {
      kind: "quadrant",
      path: `M ${armX} ${cornerY} L ${armX} ${farY} A ${r} ${r} 0 0 ${sweep} ${tipX} ${cornerY} Z`,
    };
    headCentre = { x: armX + f * half, y: armY };
  } else {
    const r = MAP_STYLE.signal.radius;
    head = { kind: "circle", cx: armX + f * r, cy: armY, r };
    headCentre = { x: head.cx, y: head.cy };
  }

  return { appliesTo, side, post, head, headCentre, cutout, label };
}

/** Where a signal's number is drawn, relative to the signal: its dragged offset, or the default. */
export function signalLabelPosition(
  signal: Pick<SignalElement, "labelOffset">,
  geometry: SignalPostGeometry,
): { x: number; y: number } {
  return signal.labelOffset ?? { x: geometry.label.x, y: geometry.label.y };
}

/** How far a signal may be from a berth box edge on its own track and still count as next to it. */
export const SIGNAL_BERTH_SEARCH = 40;
/** How far a berth box's centre may be from the signal's y and still be on the same track. */
const SAME_TRACK_TOLERANCE = 4;

export type SignalDirectionDecision =
  | { ok: true; appliesTo: "right" | "left"; side: "above" | "below" }
  | { ok: false; reason: "no-berth-nearby" | "between-two-berths" | "inside-a-berth" };

/** Every berth's drawn box, worked out once for a whole map (a berth with no bound track searches
 * all tracks for its row, so this must not run per signal). */
export function berthBoxes(elements: ReadonlyArray<MapElement>): Rect[] {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const boxes: Rect[] = [];
  for (const element of elements) {
    if (element.type === "berth") boxes.push(berthRenderRect(element, byId));
  }
  return boxes;
}

/**
 * The owner's default rule (2026-09-27): a signal to the right of a berth on its own track stands
 * above the track and applies to right-running trains; one to the left of a berth stands below and
 * applies to left-running trains. "Next to" is the nearest berth box edge on the same track within
 * `SIGNAL_BERTH_SEARCH`. A signal exactly between two, or with none near, is left for the author.
 */
export function defaultSignalDirection(
  signal: Pick<SignalElement, "x" | "y">,
  boxes: ReadonlyArray<Rect>,
): SignalDirectionDecision {
  let after = Infinity; // distance from the end of a berth on the left
  let before = Infinity; // distance to the start of a berth on the right
  for (const rect of boxes) {
    if (Math.abs(rect.y + rect.height / 2 - signal.y) > SAME_TRACK_TOLERANCE) continue;
    const right = rect.x + rect.width;
    if (signal.x > rect.x && signal.x < right) return { ok: false, reason: "inside-a-berth" };
    if (signal.x >= right) after = Math.min(after, signal.x - right);
    if (signal.x <= rect.x) before = Math.min(before, rect.x - signal.x);
  }
  const a = after <= SIGNAL_BERTH_SEARCH ? after : Infinity;
  const b = before <= SIGNAL_BERTH_SEARCH ? before : Infinity;
  if (a === Infinity && b === Infinity) return { ok: false, reason: "no-berth-nearby" };
  if (a === b) return { ok: false, reason: "between-two-berths" };
  return a < b
    ? { ok: true, appliesTo: "right", side: "above" }
    : { ok: true, appliesTo: "left", side: "below" };
}

/**
 * The bulk tool's prefix rule (owner, 2026-09-27): the prefix replaces the label's leading
 * letters — `S001` with `CE` is `CE001`. No prefix, or a label with no leading letters, is
 * returned unchanged.
 */
export function applySignalNamePrefix(label: string, prefix: string | undefined): string {
  const trimmed = prefix?.trim();
  if (!trimmed) return label;
  const match = /^([A-Za-z]+)(.*)$/.exec(label);
  if (!match) return label;
  return `${trimmed}${match[2]}`;
}
