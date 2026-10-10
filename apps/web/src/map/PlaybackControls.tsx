import { useState } from "react";
import { PLAYBACK_SPEEDS, PLAYBACK_STEPS_MS } from "./usePlayback.js";

export interface PlaybackControlsProps {
  atIso: string;
  playing: boolean;
  speed: number;
  loading: boolean;
  atLiveEdge: boolean;
  quality: { status: "ok" | "stale" | "unknown"; gaps: string[]; incomplete?: boolean | undefined };
  onPlay: () => void;
  onPause: () => void;
  onSpeed: (speed: number) => void;
  onJump: (atMs: number) => void;
  onStep: (deltaMs: number) => void;
  onReturnToLive: () => void;
}

/** `datetime-local` value (no seconds, no tz) from an ISO instant, in the browser's local zone
 * — self-hosted deployments run the browser in Europe/London, matching docs' render zone. */
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

const GAPS_OPEN_KEY = "rlm.playbackGapsOpen";

/** An admin's choice to show or minimise the outage list; shown until they minimise it. */
function readGapsOpen(): boolean {
  try {
    return window.localStorage.getItem(GAPS_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeGapsOpen(value: boolean): void {
  try {
    window.localStorage.setItem(GAPS_OPEN_KEY, String(value));
  } catch {
    /* private mode: the choice just isn't remembered */
  }
}

function WarningIcon(): JSX.Element {
  return (
    <svg className="playback__warning-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.6 15 14H1L8 1.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8 6.2v3.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.9" r="0.85" fill="currentColor" />
    </svg>
  );
}

/**
 * docs/PROJECT_SPEC.md §5 "Playback": choose a date/time and jump to it, pause/resume, step
 * ±10s/±1m/±10m, pick a speed, a persistent "Historical playback" indicator, return to live, and
 * a warning wherever the recorder had a feed gap.
 *
 * Owner, 2026-10-10: the list of outages is for admins only (the API sends `gaps` to no one
 * else), behind a toggle they can minimise (remembered in this browser); everyone else sees one
 * small orange warning that data may be incomplete, with no details. On a computer the controls
 * sit on one line (see `.playback` in styles.css); phones keep the rows.
 */
export function PlaybackControls(props: PlaybackControlsProps): JSX.Element {
  const [pending, setPending] = useState<string | null>(null);
  const [gapsOpen, setGapsOpen] = useState<boolean>(readGapsOpen);
  const gapCount = props.quality.gaps.length;

  function toggleGaps(): void {
    setGapsOpen((open) => {
      writeGapsOpen(!open);
      return !open;
    });
  }
  const inputValue = pending ?? toLocalInputValue(props.atIso);

  return (
    <div className="playback" aria-label="Historical playback controls">
      <div className="playback__row">
        <span className="playback__badge" role="status">
          Historical playback
        </span>
        {/* Play/Pause sits with "Return to live" rather than the step buttons (owner,
            2026-09-30): the two controls used most, together at the top. */}
        <button
          type="button"
          className="playback__btn"
          onClick={props.playing ? props.onPause : props.onPlay}
          disabled={props.loading || (props.atLiveEdge && !props.playing)}
          aria-pressed={props.playing}
        >
          {props.playing ? "Pause" : "Play"}
        </button>
        <button type="button" className="playback__btn" onClick={props.onReturnToLive}>
          Return to live
        </button>
      </div>

      <div className="playback__row">
        <label className="playback__field">
          <span>Go to</span>
          <input
            type="datetime-local"
            value={inputValue}
            onChange={(e) => setPending(e.target.value)}
            aria-label="Playback date and time"
          />
        </label>
        <button
          type="button"
          className="playback__btn"
          disabled={!pending}
          onClick={() => {
            if (!pending) return;
            const ms = new Date(pending).getTime();
            if (!Number.isNaN(ms)) props.onJump(ms);
            setPending(null);
          }}
        >
          Jump
        </button>
      </div>

      <div className="playback__row">
        {PLAYBACK_STEPS_MS.map((s) => (
          <button
            key={s.label}
            type="button"
            className="playback__btn playback__btn--step"
            onClick={() => props.onStep(s.ms)}
            disabled={props.loading}
          >
            {s.label}
          </button>
        ))}
        <label className="playback__field">
          <span>Speed</span>
          <select
            value={props.speed}
            onChange={(e) => props.onSpeed(Number(e.target.value))}
            aria-label="Playback speed"
          >
            {PLAYBACK_SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Before the clock, so on one line it sits with the controls and the clock stays last. */}
      {gapCount === 0 && props.quality.incomplete && (
        <p className="playback__warning" role="note">
          <WarningIcon />
          Some data around this time may be incomplete.
        </p>
      )}
      {gapCount > 0 && (
        <button
          type="button"
          className="playback__warning playback__warning--toggle"
          aria-expanded={gapsOpen}
          aria-controls="playback-gaps"
          onClick={toggleGaps}
        >
          <WarningIcon />
          {gapCount} outage {gapCount === 1 ? "warning" : "warnings"}
          <span className="playback__warning-action">{gapsOpen ? "Hide" : "Show"}</span>
        </button>
      )}

      <div className="playback__clock" aria-live="polite">
        {new Date(props.atIso).toLocaleString("en-GB", { timeZone: "Europe/London" })}
        {props.atLiveEdge ? " — caught up to live" : ""}
      </div>

      {gapCount > 0 && gapsOpen && (
        <ul id="playback-gaps" className="playback__gaps" aria-label="Feed gap warnings">
          {props.quality.gaps.map((gap) => (
            <li key={gap} className="playback__gap">
              {gap}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
