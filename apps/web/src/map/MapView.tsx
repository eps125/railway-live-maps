import { useState } from "react";
import type { CompiledMapBundle } from "@railway/map-schema";
import { useMapData } from "./useMapData.js";
import { MapRenderer } from "./MapRenderer.js";
import { LiveStatusBanner } from "./LiveStatusBanner.js";
import { PlaybackControls } from "./PlaybackControls.js";
import { usePlayback } from "./usePlayback.js";

export interface MapViewProps {
  slug: string;
  /** Milestone 31: from a places-search click-through (`?center=<elementId>`) — jump to and
   * centre the initial view on this element instead of the remembered/default view. */
  centerElementId?: string | null;
  /** Milestone 32: from a boundary click-through on the adjacent map (`?boundary=<name>`) —
   * resolved below to this map's own boundary element of that name (if any) and passed through
   * as `centerElementId`. Unresolved (stale/renamed boundary, or no match) falls back to the
   * remembered/default view — never a hard error. */
  centerBoundaryName?: string | null;
}

const EMPTY_BERTHS_KEY = "rlm.showEmptyBerths";

/** ADR 0004 D5: per-viewer "show empty berths" preference, remembered across reloads. Reads
 * fail closed to the default (`true`) — a private window or blocked storage must not break the
 * map. */
function readShowEmptyBerths(): boolean {
  try {
    return window.localStorage.getItem(EMPTY_BERTHS_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeShowEmptyBerths(value: boolean): void {
  try {
    window.localStorage.setItem(EMPTY_BERTHS_KEY, String(value));
  } catch {
    /* ignore — the toggle still works for this session via React state */
  }
}

/** docs/PROJECT_SPEC.md §5: the public map shows live berth activity with a clear
 * connected/stale/data-gap status, and (Milestone 10) can switch to historical playback of a
 * chosen time. */
export function MapView({
  slug,
  centerElementId = null,
  centerBoundaryName = null,
}: MapViewProps): JSX.Element {
  const { definition, state, error, loading, connectionStatus } = useMapData(slug);
  const [playbackFrom, setPlaybackFrom] = useState<number | null>(null);
  const [showEmptyBerths, setShowEmptyBerths] = useState<boolean>(readShowEmptyBerths);

  function toggleEmptyBerths(): void {
    setShowEmptyBerths((prev) => {
      const next = !prev;
      writeShowEmptyBerths(next);
      return next;
    });
  }

  if (loading && !definition) {
    return <p className="app-loading">Loading map…</p>;
  }
  if (!definition) {
    return (
      <p role="alert" className="app-error">
        {error ?? "Map not available."}
      </p>
    );
  }

  // Milestone 32: `?boundary=<name>` names a boundary as authored on the *source* map — look up
  // this map's own boundary/label element with that name (folded into `label` 2026-09-13, so a
  // match can be either type). `centerElementId` (Milestone 31, an actual elementId) takes
  // priority if somehow both are present; no match just means no centering, not an error
  // (docs/IMPLEMENTATION_PLAN.md Milestone 32 acceptance).
  const resolvedCenterElementId =
    centerElementId ??
    (centerBoundaryName
      ? (Object.values(definition.definition.elementsById).find(
          (el) =>
            (el.type === "boundary" && el.name === centerBoundaryName) ||
            (el.type === "label" && el.text === centerBoundaryName),
        )?.id ?? null)
      : null);

  return (
    <section className="map-page" aria-label="Live map">
      <div className="map-page__toolbar">
        <span className="map-page__title">{definition.definition.mapName}</span>
        {playbackFrom === null ? (
          <>
            <LiveStatusBanner
              connectionStatus={connectionStatus}
              qualityStatus={state?.quality.status ?? "unknown"}
            />
            <button
              type="button"
              className="map-page__mode-btn"
              onClick={() => setPlaybackFrom(Date.now() - 15 * 60_000)}
            >
              Playback
            </button>
          </>
        ) : null}
        <label className="map-page__toggle">
          <input type="checkbox" checked={showEmptyBerths} onChange={toggleEmptyBerths} />
          Show empty berths
        </label>
      </div>

      {playbackFrom === null ? (
        <MapRenderer
          bundle={definition.definition}
          berths={state?.berths ?? {}}
          signals={state?.signals ?? {}}
          showEmptyBerths={showEmptyBerths}
          centerElementId={resolvedCenterElementId}
        />
      ) : (
        <PlaybackView
          slug={slug}
          fromMs={playbackFrom}
          bundle={definition.definition}
          showEmptyBerths={showEmptyBerths}
          onReturnToLive={() => setPlaybackFrom(null)}
        />
      )}
    </section>
  );
}

interface PlaybackViewProps {
  slug: string;
  fromMs: number;
  bundle: CompiledMapBundle;
  showEmptyBerths: boolean;
  onReturnToLive: () => void;
}

function PlaybackView({
  slug,
  fromMs,
  bundle,
  showEmptyBerths,
  onReturnToLive,
}: PlaybackViewProps): JSX.Element {
  const pb = usePlayback(slug, fromMs);
  return (
    <>
      <PlaybackControls
        atIso={pb.atIso}
        playing={pb.playing}
        speed={pb.speed}
        loading={pb.loading}
        atLiveEdge={pb.atLiveEdge}
        quality={pb.quality}
        onPlay={pb.play}
        onPause={pb.pause}
        onSpeed={pb.setSpeed}
        onJump={pb.jumpTo}
        onStep={pb.step}
        onReturnToLive={onReturnToLive}
      />
      {pb.error ? (
        <p role="alert" className="app-error">
          {pb.error}
        </p>
      ) : null}
      <MapRenderer
        bundle={bundle}
        berths={pb.berths}
        signals={pb.signals}
        showEmptyBerths={showEmptyBerths}
      />
    </>
  );
}
