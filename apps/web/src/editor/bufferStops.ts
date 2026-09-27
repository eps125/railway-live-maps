import type { MapElement } from "@railway/map-schema";

/** How far from a track end a click may be and still place the buffer stop on it. */
export const BUFFER_STOP_SNAP = 30;

type Point = { x: number; y: number };

/**
 * 2026-09-27 (owner): a buffer stop goes at the end of a line — a platform road, a headshunt.
 * The nearest dead track end to `point` within `maxDistance` (an end no other track starts or
 * finishes at), and which way it faces: an end reached from the left faces left, so trains
 * running right meet its face.
 */
export function nearestTrackEnd(
  elements: ReadonlyArray<MapElement>,
  point: Point,
  maxDistance: number = BUFFER_STOP_SNAP,
): { point: Point; facing: "left" | "right" } | null {
  const ends: Array<{ end: Point; neighbour: Point }> = [];
  const count = new Map<string, number>();
  const key = (p: Point): string => `${p.x},${p.y}`;
  for (const element of elements) {
    if (element.type !== "trackPath" || element.points.length < 2) continue;
    const pts = element.points;
    for (const [end, neighbour] of [
      [pts[0]!, pts[1]!],
      [pts[pts.length - 1]!, pts[pts.length - 2]!],
    ] as const) {
      ends.push({ end, neighbour });
      count.set(key(end), (count.get(key(end)) ?? 0) + 1);
    }
  }
  let best: { point: Point; facing: "left" | "right" } | null = null;
  let bestDistance = maxDistance;
  for (const { end, neighbour } of ends) {
    if ((count.get(key(end)) ?? 0) > 1) continue; // a joint between tracks, not a dead end
    if (neighbour.x === end.x) continue; // a vertical end has no left or right
    const distance = Math.hypot(end.x - point.x, end.y - point.y);
    if (distance > bestDistance) continue;
    bestDistance = distance;
    best = { point: { x: end.x, y: end.y }, facing: neighbour.x < end.x ? "left" : "right" };
  }
  return best;
}
