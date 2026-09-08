import { MAP_STYLE } from "@railway/map-schema";

/**
 * ADR 0005 E1 — editor-only track drawing aids. Pure geometry, unit-tested; the canvas wires
 * these into endpoint drag / draw so a hand-drawn `trackPath` can only take a standard angle
 * and its ends actually meet the neighbouring track.
 */

export interface Point {
  x: number;
  y: number;
}

/** Slopes the track tool snaps to: horizontal, the 1:2 standard diagonal (ADR 0004 D4), the
 * steeper 1:1 permitted for tight spaces, and vertical — as absolute angles in degrees, every
 * reflection included so a segment pointing in any of the eight-ish directions has a target. */
export const SNAP_ANGLES_DEG: number[] = (() => {
  const base = [0, 90, Math.atan(0.5) * (180 / Math.PI), 45];
  const all = new Set<number>();
  for (const a of base) {
    for (const q of [a, 180 - a, 180 + a, 360 - a]) {
      all.add(((q % 360) + 360) % 360);
    }
  }
  return [...all].sort((a, b) => a - b);
})();

/** Within this many degrees of a snap angle, the segment is pulled onto it. */
export const ANGLE_SNAP_THRESHOLD_DEG = 6;

function angleDeg(from: Point, to: Point): number {
  const deg = Math.atan2(to.y - from.y, to.x - from.x) * (180 / Math.PI);
  return ((deg % 360) + 360) % 360;
}

function angularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Snap the moving end of a segment to the nearest standard angle about its fixed end, keeping
 * the segment's length. Returns `to` unchanged when `bypass` is set, the ends coincide, or no
 * snap angle is within `ANGLE_SNAP_THRESHOLD_DEG`.
 */
export function snapSegmentAngle(from: Point, to: Point, bypass = false): Point {
  if (bypass) return to;
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (len === 0) return to;

  const current = angleDeg(from, to);
  let best = current;
  let bestDist: number = ANGLE_SNAP_THRESHOLD_DEG;
  for (const candidate of SNAP_ANGLES_DEG) {
    const dist = angularDistance(current, candidate);
    if (dist < bestDist) {
      best = candidate;
      bestDist = dist;
    }
  }
  if (best === current) return to;

  const rad = best * (Math.PI / 180);
  return { x: from.x + len * Math.cos(rad), y: from.y + len * Math.sin(rad) };
}

/**
 * If `point` is within `MAP_STYLE.weldTolerance` of one of `candidates`, return that candidate
 * (the nearest) so the dragged endpoint lands exactly on it; otherwise `null`. `candidates`
 * are the endpoints of every *other* track polyline.
 */
export function weldToEndpoint(point: Point, candidates: readonly Point[]): Point | null {
  let best: Point | null = null;
  let bestDist: number = MAP_STYLE.weldTolerance;
  for (const c of candidates) {
    const dist = Math.hypot(point.x - c.x, point.y - c.y);
    if (dist <= bestDist) {
      best = c;
      bestDist = dist;
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}
