import { useCallback, useState } from "react";
import type { CompiledMapBundle } from "@railway/map-schema";
import { useMapData } from "./useMapData.js";
import { MapRenderer } from "./MapRenderer.js";
import { LiveStatusBanner } from "./LiveStatusBanner.js";
import { PlaybackControls } from "./PlaybackControls.js";
import { PLAYBACK_SPEEDS, usePlayback } from "./usePlayback.js";
import { SClassMiniPanel } from "./SClassMiniPanel.js";

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
  /** Milestone 65: arrived by a boundary link from a map in playback — open in playback at the
   * same moment (`?at=&speed=&play=1`) rather than live. */
  initialPlayback?: { atMs: number; speed: number; playing: boolean } | null;
  /** Milestone 65: an admin gets the S-Class mini explorer button. */
  isAdmin?: boolean;
}

const S_CLASS_PANEL_KEY = "rlm.sClassPanelOpen";

/** The mini explorer stays open across maps within a tab (a boundary link remounts the view). */
function readPanelOpen(): boolean {
  try {
    return window.sessionStorage.getItem(S_CLASS_PANEL_KEY) === "true";
  } catch {
    return false;
  }
}

function writePanelOpen(open: boolean): void {
  try {
    window.sessionStorage.setItem(S_CLASS_PANEL_KEY, String(open));
  } catch {
    /* ignore — the panel still works for this page */
  }
}

/** Drop the playback position from the URL, so a refresh after returning to live stays live. */
function clearPlaybackParams(): void {
  try {
    const url = new URL(window.location.href);
    if (!["at", "speed", "play"].some((key) => url.searchParams.has(key))) return;
    for (const key of ["at", "speed", "play"]) url.searchParams.delete(key);
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    /* ignore */
  }
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
  initialPlayback = null,
  isAdmin = false,
}: MapViewProps): JSX.Element {
  const { definition, state, error, loading, connectionStatus } = useMapData(slug);
  const [playbackFrom, setPlaybackFrom] = useState<number | null>(initialPlayback?.atMs ?? null);
  const [sClassOpen, setSClassOpen] = useState<boolean>(() => isAdmin && readPanelOpen());
  const [highlight, setHighlight] = useState<string[]>([]);
  const onHighlight = useCallback((ids: string[]) => setHighlight(ids), []);

  function toggleSClass(): void {
    setSClassOpen((prev) => {
      writePanelOpen(!prev);
      return !prev;
    });
  }
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
        {isAdmin ? (
          <button
            type="button"
            className="map-page__mode-btn"
            aria-pressed={sClassOpen}
            onClick={toggleSClass}
          >
            S-Class
          </button>
        ) : null}
      </div>

      {playbackFrom === null ? (
        // Keyed by mapId (2026-09-16 fix): `navigate()` is a client-side pushState, so clicking
        // a boundary link or a places-search result from *within* an already-mounted map page
        // updates this component's props in place rather than remounting it. MapRenderer's
        // centering (and its per-map saved-view restore) is deliberately mount-only state — an
        // `useRef`/lazy `useState` initializer that intentionally does not react to a later prop
        // change, so the visitor's own panning isn't fought — so without a key tied to the map's
        // identity, navigating from one map to another left it centred on whatever the previous
        // map's mount had computed (in practice: the new map's plain bounding-box centre, not the
        // requested boundary/search point). The key forces a genuine remount on every map change.
        <MapRenderer
          key={definition.definition.mapId}
          bundle={definition.definition}
          berths={state?.berths ?? {}}
          signals={state?.signals ?? {}}
          crossings={state?.crossings ?? {}}
          routes={state?.routes ?? {}}
          showEmptyBerths={showEmptyBerths}
          centerElementId={resolvedCenterElementId}
          highlightElementIds={highlight}
        />
      ) : (
        <PlaybackView
          slug={slug}
          fromMs={playbackFrom}
          initialSpeed={initialPlayback?.speed ?? 1}
          initialPlaying={initialPlayback?.playing ?? false}
          bundle={definition.definition}
          showEmptyBerths={showEmptyBerths}
          centerElementId={resolvedCenterElementId}
          highlight={highlight}
          sClassPanel={
            isAdmin && sClassOpen
              ? (atIso) => (
                  <SClassMiniPanel
                    bundle={definition.definition}
                    atIso={atIso}
                    onHighlight={onHighlight}
                    onClose={toggleSClass}
                  />
                )
              : null
          }
          onReturnToLive={() => {
            clearPlaybackParams();
            setPlaybackFrom(null);
          }}
        />
      )}
      {playbackFrom === null && isAdmin && sClassOpen ? (
        <SClassMiniPanel
          bundle={definition.definition}
          atIso={null}
          onHighlight={onHighlight}
          onClose={toggleSClass}
        />
      ) : null}
    </section>
  );
}

interface PlaybackViewProps {
  slug: string;
  fromMs: number;
  initialSpeed: number;
  initialPlaying: boolean;
  bundle: CompiledMapBundle;
  showEmptyBerths: boolean;
  centerElementId: string | null;
  highlight: string[];
  /** The admin S-Class mini explorer, given the playback clock — or null when closed. */
  sClassPanel: ((atIso: string) => JSX.Element) | null;
  onReturnToLive: () => void;
}

function PlaybackView({
  slug,
  fromMs,
  initialSpeed,
  initialPlaying,
  bundle,
  showEmptyBerths,
  centerElementId,
  highlight,
  sClassPanel,
  onReturnToLive,
}: PlaybackViewProps): JSX.Element {
  // A speed carried in a URL is only honoured if it's one the controls offer.
  const speed = (PLAYBACK_SPEEDS as readonly number[]).includes(initialSpeed) ? initialSpeed : 1;
  const pb = usePlayback(slug, fromMs, { speed, playing: initialPlaying });
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
        key={bundle.mapId}
        bundle={bundle}
        berths={pb.berths}
        signals={pb.signals}
        crossings={pb.crossings}
        routes={pb.routes}
        showEmptyBerths={showEmptyBerths}
        atIso={pb.atIso}
        centerElementId={centerElementId}
        highlightElementIds={highlight}
        playbackLink={{ atIso: pb.atIso, speed: pb.speed, playing: pb.playing }}
      />
      {sClassPanel ? sClassPanel(pb.atIso) : null}
    </>
  );
}
