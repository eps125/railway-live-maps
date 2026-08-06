import type { LiveConnectionStatus } from "./useLiveMapSocket.js";

export interface LiveStatusBannerProps {
  connectionStatus: LiveConnectionStatus;
  qualityStatus: "ok" | "stale" | "unknown";
}

/** docs/PROJECT_SPEC.md §5 "Live map": show a clear connected/stale/data-gap status alongside
 * the map, never silently render as if data were fresh.
 *
 * `qualityStatus` (the nationwide feed's own health, reported by the server) takes priority
 * over `connectionStatus` (this browser tab's WebSocket transport) whenever it's known: the
 * REST poll fallback keeps `qualityStatus` meaningful even while the socket is reconnecting, so
 * a transient WS drop shouldn't flash "Reconnecting…" over otherwise-healthy data. The
 * transport's own state only surfaces once there's no quality signal to show yet — i.e. before
 * the very first snapshot/poll response has arrived. */
export function LiveStatusBanner({
  connectionStatus,
  qualityStatus,
}: LiveStatusBannerProps): JSX.Element {
  let text: string;
  let modifier: string;
  if (qualityStatus === "ok") {
    text = "Live";
    modifier = "ok";
  } else if (qualityStatus === "stale") {
    text = "Data may be stale";
    modifier = "stale";
  } else if (connectionStatus === "reconnecting") {
    text = "Reconnecting…";
    modifier = "connecting";
  } else if (connectionStatus === "connecting") {
    text = "Connecting…";
    modifier = "connecting";
  } else {
    text = "Live data status unknown";
    modifier = "unknown";
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={`status-banner status-banner--${modifier}`}
    >
      <span className="status-banner__dot" aria-hidden="true" />
      {text}
    </div>
  );
}
