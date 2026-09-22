import { useEffect } from "react";
import { useEditorState } from "./EditorState.js";
import type { RouteTrace } from "./EditorState.js";
import type { TraceResult } from "./routeTrace.js";

/**
 * Milestone 64 / ADR 0016: what to do next while tracing a route, over the canvas. Keyboard:
 * Escape cancels, Backspace removes the last point, Enter finishes at the last point. The editor's
 * own Delete/Backspace shortcut stands down while a trace is open (`Toolbar.tsx`), so Backspace
 * here can never delete the selected signal.
 */
export function RouteTraceBar({
  trace,
  result,
  onFinishHere,
  onUndoPoint,
  onCancel,
}: {
  trace: RouteTrace;
  result: TraceResult;
  onFinishHere: () => void;
  onUndoPoint: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { document: doc } = useEditorState();
  const signal = doc.elements.find((element) => element.id === trace.signalId);
  const signalName = signal?.type === "signal" && signal.label ? signal.label : trace.signalId;
  const canFinishHere = result.status === "traced" && trace.waypoints.length > 0;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        onUndoPoint();
      } else if (e.key === "Enter" && canFinishHere) {
        e.preventDefault();
        onFinishHere();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, onUndoPoint, onFinishHere, canFinishHere]);

  let message: string;
  let isError = false;
  switch (result.status) {
    case "noSignal":
      message = "The signal this route starts from no longer exists.";
      isError = true;
      break;
    case "signalOffTrack":
      message = `Signal ${result.signalId} isn't on or near a track, so a route can't start or end there.`;
      isError = true;
      break;
    case "noPath":
      message =
        result.failedLeg === 0
          ? "No way along the track from the signal to that point without reversing. Undo the point and click nearer the signal first."
          : `No way along the track to point ${result.failedLeg + 1} without reversing. Undo it, or click an earlier point on the track the route should use.`;
      isError = true;
      break;
    default:
      message =
        trace.waypoints.length === 0
          ? "Click the track in the direction the route runs, then click the exit signal."
          : "Click further along the track to steer it, then click the exit signal.";
  }

  return (
    <div className="route-trace-bar" role="status">
      <strong>
        {trace.routeId ? "Re-tracing" : "Tracing"} route from {signalName}
      </strong>
      <span
        className={isError ? "route-trace-bar__message--error" : undefined}
        data-testid="route-trace-message"
      >
        {message}
      </span>
      <button
        type="button"
        className="btn"
        onClick={onUndoPoint}
        disabled={trace.waypoints.length === 0}
      >
        Undo point
      </button>
      <button
        type="button"
        className="btn"
        onClick={onFinishHere}
        disabled={!canFinishHere}
        title="End the route at the last point, for a route to a boundary or buffer stop"
      >
        Finish here
      </button>
      <button type="button" className="btn" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
