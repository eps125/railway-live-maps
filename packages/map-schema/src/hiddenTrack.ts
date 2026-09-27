import type { MapElement, TrackPathElement } from "./document.js";

/**
 * 2026-09-27 (owner): a track can be marked `hidden` — typically the piece of a line that passes
 * under a flyover, between the two viaduct marks. It is never drawn on the public map, but it is
 * still track: the route tracer crosses it, so a route runs through the gap. The part of a route
 * lying along a hidden track is not drawn either, so the route shows on the track either side of
 * the flyover and not across the line going over it.
 *
 * Worked out at draw time from the geometry, so ticking or unticking Hidden also changes routes
 * traced before it. Shared by the public renderer and the editor canvas (CLAUDE.md rule 13).
 */

type Point = { x: number; y: number };

/** How far a hidden track may be from a route segment and still count as lying along it. */
const ON_LINE_TOLERANCE = 0.5;

export function hiddenTracks(elements: Iterable<MapElement>): TrackPathElement[] {
  const hidden: TrackPathElement[] = [];
  for (const element of elements) {
    if (element.type === "trackPath" && element.hidden) hidden.push(element);
  }
  return hidden;
}

/** The stretch of segment a→b (as parameters 0..1) that the hidden segment c→d lies along, or
 * null if it doesn't run along it. */
function coveredInterval(a: Point, b: Point, c: Point, d: Point): [number, number] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return null;
  const length = Math.sqrt(lengthSq);
  // Both ends of c→d must lie on the line through a→b.
  const offLine = (p: Point): number => Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / length;
  if (offLine(c) > ON_LINE_TOLERANCE || offLine(d) > ON_LINE_TOLERANCE) return null;
  const t = (p: Point): number => ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  const from = Math.max(0, Math.min(t(c), t(d)));
  const to = Math.min(1, Math.max(t(c), t(d)));
  return to - from > 1e-9 ? [from, to] : null;
}

/**
 * The parts of a route's polyline to draw: each run is a polyline, split wherever the route runs
 * along a hidden track. With no hidden track in the way, it is the route's own points, unsplit.
 */
export function visibleRouteRuns(
  points: ReadonlyArray<Point>,
  hidden: ReadonlyArray<TrackPathElement>,
): Point[][] {
  if (hidden.length === 0) return [points.map((p) => ({ ...p }))];
  const runs: Point[][] = [];
  let current: Point[] = [];
  // Rounded, so a split lands exactly on the hidden track's end rather than a hair past it.
  const round = (v: number): number => Math.round(v * 1e6) / 1e6;
  const at = (a: Point, b: Point, t: number): Point => ({
    x: round(a.x + (b.x - a.x) * t),
    y: round(a.y + (b.y - a.y) * t),
  });
  const extend = (p: Point): void => {
    const last = current[current.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) current.push(p);
  };
  const close = (): void => {
    if (current.length >= 2) runs.push(current);
    current = [];
  };

  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const covered: Array<[number, number]> = [];
    for (const track of hidden) {
      for (let j = 0; j + 1 < track.points.length; j += 1) {
        const interval = coveredInterval(a, b, track.points[j]!, track.points[j + 1]!);
        if (interval) covered.push(interval);
      }
    }
    covered.sort((x, y) => x[0] - y[0]);
    // Walk the segment, drawing the stretches between covered intervals.
    let t = 0;
    for (const [from, to] of covered) {
      if (from > t) {
        extend(at(a, b, t));
        extend(at(a, b, from));
        close();
      } else if (t === 0) {
        close();
      }
      t = Math.max(t, to);
    }
    if (t < 1) {
      extend(at(a, b, t));
      extend(b);
    } else {
      close();
    }
  }
  close();
  return runs;
}
