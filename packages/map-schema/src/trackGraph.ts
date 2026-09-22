/**
 * Milestone 64 / ADR 0016 decision 4: an authoring-time graph of the track **as drawn**, used to
 * trace a route along existing track, and to check a stored route still lies on it.
 *
 * Built from `trackPath` geometry only, and never written back as `topology`:
 *
 * - every vertex of every track is a node, joined to the next vertex along the same track;
 * - an endpoint of one track lying on another track (at a vertex, at its end, or part-way along a
 *   segment) joins the two there. That is how a crossover, a turnout or two welded pieces of line
 *   meet in a hand-drawn map;
 * - two tracks whose *interiors* merely cross are **not** joined: that is a diamond (or a flyover),
 *   and a train goes straight over it, never round the corner.
 *
 * The tracer is a shortest-path search over that graph that refuses to turn back on itself: at a
 * node, the next edge must continue in broadly the same direction as the one it arrived on (less
 * than 90° of turn). Without that, the shortest way from a main line onto a crossover that leaves
 * it the other way would be to run past the turnout and reverse into it, which no route does.
 */

export interface GraphPoint {
  x: number;
  y: number;
}

export interface TrackLike {
  id: string;
  points: ReadonlyArray<GraphPoint>;
}

/** A point on a track: which track, where on it, and how far along its polyline. */
export interface TrackPosition {
  trackId: string;
  point: GraphPoint;
  /** Distance along the track's polyline from its first vertex. */
  along: number;
  /** Distance from the queried point to `point`. */
  distance: number;
}

export interface TracedRoute {
  points: GraphPoint[];
  /** Every track the route runs along, in the order it first reaches each. */
  trackIds: string[];
}

/** Endpoints within this distance of another track are joined to it (`MAP_STYLE.weldTolerance`). */
export const DEFAULT_JOIN_TOLERANCE = 6;

function distance(a: GraphPoint, b: GraphPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The nearest point on `track` to `p`, with how far along the track it is. */
export function nearestPositionOnTrack(track: TrackLike, p: GraphPoint): TrackPosition | null {
  let best: TrackPosition | null = null;
  let travelled = 0;
  for (let i = 0; i + 1 < track.points.length; i++) {
    const a = track.points[i]!;
    const b = track.points[i + 1]!;
    const length = distance(a, b);
    const t =
      length === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length ** 2),
          );
    const point = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    const d = distance(point, p);
    if (best === null || d < best.distance) {
      best = { trackId: track.id, point, along: travelled + t * length, distance: d };
    }
    travelled += length;
  }
  if (best === null && track.points.length === 1) {
    const point = track.points[0]!;
    best = { trackId: track.id, point, along: 0, distance: distance(point, p) };
  }
  return best;
}

/** The nearest point on any of `tracks` to `p`, if one is within `maxDistance`. */
export function snapToTrack(
  tracks: ReadonlyArray<TrackLike>,
  p: GraphPoint,
  maxDistance: number,
  preferTrackId?: string,
): TrackPosition | null {
  if (preferTrackId !== undefined) {
    const preferred = tracks.find((track) => track.id === preferTrackId);
    const position = preferred ? nearestPositionOnTrack(preferred, p) : null;
    if (position && position.distance <= maxDistance) return position;
  }
  let best: TrackPosition | null = null;
  for (const track of tracks) {
    const position = nearestPositionOnTrack(track, p);
    if (
      position &&
      position.distance <= maxDistance &&
      (!best || position.distance < best.distance)
    ) {
      best = position;
    }
  }
  return best;
}

interface Station {
  key: number;
  along: number;
  point: GraphPoint;
}

interface Edge {
  from: number;
  to: number;
  trackId: string;
  a: GraphPoint;
  b: GraphPoint;
  length: number;
}

interface Graph {
  /** Station key -> its merged node id. */
  nodeOf: (key: number) => number;
  edges: Edge[];
  /** Node id -> indexes into `edges`. */
  adjacency: Map<number, number[]>;
}

function buildGraph(
  tracks: ReadonlyArray<TrackLike>,
  extra: ReadonlyArray<TrackPosition>,
  tolerance: number,
): { graph: Graph; extraKeys: number[] } {
  const parent: number[] = [];
  const find = (key: number): number => {
    while (parent[key] !== key) {
      parent[key] = parent[parent[key]!]!;
      key = parent[key]!;
    }
    return key;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const stationsByTrack = new Map<string, Station[]>();
  const addStation = (trackId: string, along: number, point: GraphPoint): number => {
    const key = parent.length;
    parent.push(key);
    const list = stationsByTrack.get(trackId) ?? [];
    list.push({ key, along, point });
    stationsByTrack.set(trackId, list);
    return key;
  };

  const endpointKeys = new Map<string, [number, number]>();
  for (const track of tracks) {
    let along = 0;
    let first = -1;
    let last = -1;
    track.points.forEach((point, index) => {
      if (index > 0) along += distance(track.points[index - 1]!, point);
      last = addStation(track.id, along, point);
      if (index === 0) first = last;
    });
    endpointKeys.set(track.id, [first, last]);
  }

  // Join each track's endpoints to any other track they touch.
  for (const track of tracks) {
    const keys = endpointKeys.get(track.id)!;
    const ends = [track.points[0]!, track.points[track.points.length - 1]!];
    ends.forEach((end, which) => {
      for (const other of tracks) {
        if (other.id === track.id) continue;
        const position = nearestPositionOnTrack(other, end);
        if (!position || position.distance > tolerance) continue;
        union(keys[which]!, addStation(other.id, position.along, position.point));
      }
    });
  }

  const extraKeys = extra.map((position) =>
    addStation(position.trackId, position.along, position.point),
  );

  const edges: Edge[] = [];
  for (const [trackId, stations] of stationsByTrack) {
    stations.sort((a, b) => a.along - b.along);
    for (let i = 0; i + 1 < stations.length; i++) {
      const a = stations[i]!;
      const b = stations[i + 1]!;
      if (b.along - a.along < 1e-6) {
        union(a.key, b.key);
        continue;
      }
      edges.push({
        from: a.key,
        to: b.key,
        trackId,
        a: a.point,
        b: b.point,
        length: b.along - a.along,
      });
    }
  }

  const adjacency = new Map<number, number[]>();
  edges.forEach((edge, index) => {
    for (const end of [find(edge.from), find(edge.to)]) {
      const list = adjacency.get(end) ?? [];
      list.push(index);
      adjacency.set(end, list);
    }
  });

  return { graph: { nodeOf: find, edges, adjacency }, extraKeys };
}

interface Step {
  edge: number;
  /** true = traversed from `edge.from` to `edge.to`. */
  forward: boolean;
}

function direction(edge: Edge, forward: boolean): GraphPoint {
  const dx = (edge.b.x - edge.a.x) / edge.length;
  const dy = (edge.b.y - edge.a.y) / edge.length;
  return forward ? { x: dx, y: dy } : { x: -dx, y: -dy };
}

/** Shortest non-reversing path from node `start` to node `goal`, optionally continuing the
 * direction of an arriving step. Null when there is none. */
function shortestLeg(
  graph: Graph,
  start: number,
  goal: number,
  arriving: Step | null,
): Step[] | null {
  if (start === goal) return [];
  const stateKey = (step: Step): string => `${step.edge}:${step.forward ? 1 : 0}`;
  const best = new Map<string, number>();
  const previous = new Map<string, Step | null>();
  const queue: Array<{ cost: number; step: Step }> = [];

  const push = (step: Step, cost: number, from: Step | null): void => {
    const key = stateKey(step);
    if ((best.get(key) ?? Infinity) <= cost) return;
    best.set(key, cost);
    previous.set(key, from);
    queue.push({ cost, step });
  };
  const departures = (node: number, from: Step | null, cost: number): void => {
    const heading = from ? direction(graph.edges[from.edge]!, from.forward) : null;
    for (const index of graph.adjacency.get(node) ?? []) {
      const edge = graph.edges[index]!;
      const forward = graph.nodeOf(edge.from) === node;
      if (from && from.edge === index) continue;
      if (heading) {
        const next = direction(edge, forward);
        if (heading.x * next.x + heading.y * next.y <= 0) continue;
      }
      push({ edge: index, forward }, cost + edge.length, from);
    }
  };

  departures(start, arriving, 0);
  while (queue.length > 0) {
    let lowest = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i]!.cost < queue[lowest]!.cost) lowest = i;
    const { cost, step } = queue.splice(lowest, 1)[0]!;
    if (cost > (best.get(stateKey(step)) ?? Infinity)) continue;
    const edge = graph.edges[step.edge]!;
    const reached = graph.nodeOf(step.forward ? edge.to : edge.from);
    if (reached === goal) {
      const path: Step[] = [];
      let at: Step | null = step;
      while (at && at !== arriving) {
        path.unshift(at);
        at = previous.get(stateKey(at)) ?? null;
      }
      return path;
    }
    departures(reached, step, cost);
  }
  return null;
}

/** Drop repeated points and the middle of any three collinear points. */
function simplify(points: GraphPoint[]): GraphPoint[] {
  const deduped: GraphPoint[] = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (!last || distance(last, point) > 0.01) deduped.push(point);
  }
  const out: GraphPoint[] = [];
  for (const point of deduped) {
    while (out.length >= 2) {
      const a = out[out.length - 2]!;
      const b = out[out.length - 1]!;
      const cross = (b.x - a.x) * (point.y - b.y) - (b.y - a.y) * (point.x - b.x);
      const dot = (b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y);
      if (Math.abs(cross) < 1e-6 && dot > 0) out.pop();
      else break;
    }
    out.push(point);
  }
  return out;
}

/**
 * Trace a route along the drawn track through `waypoints` — each a position on a track (see
 * `snapToTrack`), the first being where the route starts (its entry signal) and the last where it
 * ends. Between each pair it takes the shortest path that never turns back on itself, carrying
 * the direction of travel through every intermediate waypoint. Returns null, with the index of
 * the leg that could not be traced, when no such path exists.
 */
export function traceRoute(
  tracks: ReadonlyArray<TrackLike>,
  waypoints: ReadonlyArray<TrackPosition>,
  tolerance = DEFAULT_JOIN_TOLERANCE,
): { route: TracedRoute } | { failedLeg: number } {
  if (waypoints.length < 2) return { failedLeg: 0 };
  const { graph, extraKeys } = buildGraph(tracks, waypoints, tolerance);
  const nodes = extraKeys.map((key) => graph.nodeOf(key));
  const steps: Step[] = [];
  for (let leg = 0; leg + 1 < nodes.length; leg++) {
    const arriving = steps.length > 0 ? steps[steps.length - 1]! : null;
    const path = shortestLeg(graph, nodes[leg]!, nodes[leg + 1]!, arriving);
    if (path === null) return { failedLeg: leg };
    steps.push(...path);
  }
  const points: GraphPoint[] = [];
  const trackIds: string[] = [];
  for (const step of steps) {
    const edge = graph.edges[step.edge]!;
    points.push(step.forward ? edge.a : edge.b, step.forward ? edge.b : edge.a);
    if (!trackIds.includes(edge.trackId)) trackIds.push(edge.trackId);
  }
  if (points.length === 0) return { failedLeg: 0 };
  return { route: { points: simplify(points), trackIds } };
}

/**
 * Points of a stored route that no longer lie on any track: each vertex, and the midpoint of each
 * segment, further than `tolerance` from every track. Empty when the route is still on the track.
 */
export function routePointsOffTrack(
  routePoints: ReadonlyArray<GraphPoint>,
  tracks: ReadonlyArray<TrackLike>,
  tolerance = DEFAULT_JOIN_TOLERANCE,
): GraphPoint[] {
  const samples: GraphPoint[] = [];
  routePoints.forEach((point, index) => {
    samples.push(point);
    const next = routePoints[index + 1];
    if (next) samples.push({ x: (point.x + next.x) / 2, y: (point.y + next.y) / 2 });
  });
  return samples.filter((sample) => snapToTrack(tracks, sample, tolerance) === null);
}
