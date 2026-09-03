import { useState } from "react";
import type { CompiledMapBundle } from "@railway/map-schema";
import { useMapData } from "./useMapData.js";
import { MapRenderer } from "./MapRenderer.js";
import { LiveStatusBanner } from "./LiveStatusBanner.js";
import { PlaybackControls } from "./PlaybackControls.js";
import { usePlayback } from "./usePlayback.js";

export interface MapViewProps {
  slug: string;
}

/** docs/PROJECT_SPEC.md §5: the public map shows live berth activity with a clear
 * connected/stale/data-gap status, and (Milestone 10) can switch to historical playback of a
 * chosen time. */
export function MapView({ slug }: MapViewProps): JSX.Element {
  const { definition, state, error, loading, connectionStatus } = useMapData(slug);
  const [playbackFrom, setPlaybackFrom] = useState<number | null>(null);

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
      </div>

      {playbackFrom === null ? (
        <MapRenderer
          bundle={definition.definition}
          berths={state?.berths ?? {}}
          signals={state?.signals ?? {}}
        />
      ) : (
        <PlaybackView
          slug={slug}
          fromMs={playbackFrom}
          bundle={definition.definition}
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
  onReturnToLive: () => void;
}

function PlaybackView({ slug, fromMs, bundle, onReturnToLive }: PlaybackViewProps): JSX.Element {
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
      <MapRenderer bundle={bundle} berths={pb.berths} signals={pb.signals} />
    </>
  );
}
