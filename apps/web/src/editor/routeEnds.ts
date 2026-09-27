import type { MapElement, RouteElement } from "@railway/map-schema";

/**
 * 2026-09-27 (owner: "moving the signals needs to move all the routes too — else they end up
 * off"): a route's traced line starts at its entry signal and ends at its exit signal (ADR 0016),
 * so when a signal moves, its routes' ends must move with it.
 *
 * Only an end on a level stretch of line is slid: its neighbouring point shares its y, the move is
 * along the track, and the segment keeps its direction and some length. Anything else — a signal
 * moved to another track, an end on a diagonal — is left for the author to re-trace, never bent.
 */

type Point = { x: number; y: number };

/** How far a route end may be from its signal and still be treated as attached to it (drifted). */
export const ROUTE_END_TOLERANCE = 20;

/** Slides `points[index]` (an end: 0 or last) to x = `targetX`, if that is a safe slide along a
 * level segment. Returns the new points, or null if it can't be done safely. */
function slideEnd(points: readonly Point[], index: number, targetX: number): Point[] | null {
  const end = points[index]!;
  const neighbour = points[index === 0 ? 1 : points.length - 2]!;
  if (end.y !== neighbour.y) return null; // not a level segment
  const before = Math.sign(neighbour.x - end.x);
  const after = Math.sign(neighbour.x - targetX);
  if (before === 0 || after !== before) return null; // would collapse or reverse the segment
  const next = points.map((p) => ({ ...p }));
  next[index] = { x: targetX, y: end.y };
  return next;
}

/**
 * For a signal moved by `dx` along its track: the new points of every route whose end sat exactly
 * on the signal's old position, moved with it. Routes being moved themselves are skipped.
 */
export function routesFollowingSignal(
  elements: readonly MapElement[],
  signal: { id: string; x: number; y: number },
  dx: number,
  skip: ReadonlySet<string> = new Set(),
): Array<{ routeId: string; points: Point[] }> {
  if (dx === 0) return [];
  const moved: Array<{ routeId: string; points: Point[] }> = [];
  for (const element of elements) {
    if (element.type !== "route" || skip.has(element.id)) continue;
    let points: Point[] | null = element.points.map((p) => ({ ...p }));
    let changed = false;
    for (const [index, id] of [
      [0, element.entrySignalId],
      [element.points.length - 1, element.exitSignalId],
    ] as const) {
      if (id !== signal.id || !points) continue;
      const end = points[index]!;
      if (end.x !== signal.x || end.y !== signal.y) continue; // not attached exactly
      const slid = slideEnd(points, index, signal.x + dx);
      if (slid) {
        points = slid;
        changed = true;
      }
    }
    if (changed && points) moved.push({ routeId: element.id, points });
  }
  return moved;
}

export type RouteEndCheck =
  { status: "attached" } | { status: "realign"; points: Point[] } | { status: "needs-retrace" };

/**
 * Whether a route's ends meet its signals as they now stand (after any moves `signalX` gives),
 * and if an end has drifted a short way along a level segment, the points that re-attach it. A
 * route end with no signal (a boundary or buffer stop) is never touched.
 */
export function checkRouteEnds(
  route: RouteElement,
  signalAt: (id: string) => { x: number; y: number } | undefined,
): RouteEndCheck {
  let points: Point[] = route.points.map((p) => ({ ...p }));
  let changed = false;
  for (const [index, id] of [
    [0, route.entrySignalId],
    [route.points.length - 1, route.exitSignalId],
  ] as const) {
    if (!id) continue;
    const signal = signalAt(id);
    if (!signal) continue;
    const end = points[index]!;
    if (end.x === signal.x && end.y === signal.y) continue;
    if (end.y !== signal.y || Math.abs(end.x - signal.x) > ROUTE_END_TOLERANCE) {
      return { status: "needs-retrace" };
    }
    const slid = slideEnd(points, index, signal.x);
    if (!slid) return { status: "needs-retrace" };
    points = slid;
    changed = true;
  }
  return changed ? { status: "realign", points } : { status: "attached" };
}
