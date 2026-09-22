import {
  snapToTrack,
  traceRoute,
  type GraphPoint,
  type MapDocument,
  type RouteElement,
  type SignalElement,
  type TrackLike,
  type TrackPosition,
  type TracedRoute,
  type TrackPathElement,
} from "@railway/map-schema";
import type { RouteTrace } from "./EditorState.js";

/**
 * Milestone 64 / ADR 0016 decision 4: turning the author's clicks into a route, over the track as
 * drawn. Pure, so the canvas preview and the committed route are computed the same way.
 */

/** How far a signal may sit from the track it belongs to and still start or end a route on it.
 * An offset-mode signal's head is drawn `MAP_STYLE.signal.offset` away, but its x/y is on or near
 * the track; this allows for signals placed by hand a little off the line. */
export const SIGNAL_TRACK_SNAP = 30;
/** How close a click has to be to a track to add a waypoint on it. */
export const WAYPOINT_TRACK_SNAP = 12;

export function drawnTracks(doc: MapDocument): TrackLike[] {
  return doc.elements.filter(
    (element): element is TrackPathElement => element.type === "trackPath",
  );
}

/** Where a signal meets its track: its own `trackElementId` when that is close enough, otherwise
 * the nearest track. */
export function signalTrackPosition(
  tracks: ReadonlyArray<TrackLike>,
  signal: SignalElement,
): TrackPosition | null {
  return snapToTrack(tracks, signal, SIGNAL_TRACK_SNAP, signal.trackElementId);
}

export type TraceResult =
  | { status: "noSignal" }
  /** The entry signal is not near any track, so no route can start from it. */
  | { status: "signalOffTrack"; signalId: string }
  /** Nothing to draw yet beyond the start point. */
  | { status: "started"; start: GraphPoint }
  /** Leg `failedLeg` (0 = from the entry signal) has no path that doesn't reverse. */
  | { status: "noPath"; start: GraphPoint; failedLeg: number }
  | { status: "traced"; route: TracedRoute };

/**
 * The route so far: from the entry signal, through each clicked waypoint, and — when finishing —
 * to `exitSignalId`'s point on the track.
 */
export function computeRouteTrace(
  doc: MapDocument,
  trace: RouteTrace,
  exitSignalId?: string,
): TraceResult {
  const signals = new Map(
    doc.elements
      .filter((element): element is SignalElement => element.type === "signal")
      .map((signal) => [signal.id, signal]),
  );
  const entry = signals.get(trace.signalId);
  if (!entry) return { status: "noSignal" };
  const tracks = drawnTracks(doc);
  const start = signalTrackPosition(tracks, entry);
  if (!start) return { status: "signalOffTrack", signalId: entry.id };

  const positions: TrackPosition[] = [start];
  for (const point of trace.waypoints) {
    const position = snapToTrack(tracks, point, WAYPOINT_TRACK_SNAP);
    if (position) positions.push(position);
  }
  if (exitSignalId !== undefined) {
    const exit = signals.get(exitSignalId);
    const end = exit ? signalTrackPosition(tracks, exit) : null;
    if (!end) return { status: "signalOffTrack", signalId: exitSignalId };
    positions.push(end);
  }
  if (positions.length < 2) return { status: "started", start: start.point };

  const result = traceRoute(tracks, positions);
  if ("failedLeg" in result) {
    return { status: "noPath", start: start.point, failedLeg: result.failedLeg };
  }
  return { status: "traced", route: result.route };
}

/** The document change that commits a finished trace: a new route, or a re-trace of one. */
export function routeFromTrace(
  doc: MapDocument,
  trace: RouteTrace,
  route: TracedRoute,
  exitSignalId: string | undefined,
  layerId: string,
  newId: string,
):
  | { kind: "add"; element: RouteElement }
  | { kind: "patch"; elementId: string; patch: Record<string, unknown> } {
  if (trace.routeId !== null && doc.elements.some((element) => element.id === trace.routeId)) {
    return {
      kind: "patch",
      elementId: trace.routeId,
      patch: { points: route.points, trackIds: route.trackIds, exitSignalId },
    };
  }
  return {
    kind: "add",
    element: {
      id: newId,
      layerId,
      // Above the rails (0) and switched diamonds (1) within the Track layer; signals and berths
      // are on layers above it, so the route paints under them (ADR 0016 decision 5).
      zIndex: 2,
      type: "route",
      entrySignalId: trace.signalId,
      ...(exitSignalId !== undefined ? { exitSignalId } : {}),
      points: route.points,
      trackIds: route.trackIds,
    },
  };
}

/** A route's name for lists and messages: its label, else "from → to" by signal labels. */
export function routeDisplayName(doc: MapDocument, route: RouteElement): string {
  if (route.label) return route.label;
  const name = (id: string | undefined): string => {
    if (id === undefined) return "end of line";
    const signal = doc.elements.find((element) => element.id === id);
    return signal?.type === "signal" && signal.label ? signal.label : id;
  };
  return `${name(route.entrySignalId)} → ${name(route.exitSignalId)}`;
}
