import { useState } from "react";
import { PLAYBACK_SPEEDS, PLAYBACK_STEPS_MS } from "./usePlayback.js";

export interface PlaybackControlsProps {
  atIso: string;
  playing: boolean;
  speed: number;
  loading: boolean;
  atLiveEdge: boolean;
  quality: { status: "ok" | "stale" | "unknown"; gaps: string[] };
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

/**
 * docs/PROJECT_SPEC.md §5 "Playback": choose a date/time and jump to it, pause/resume, step
 * ±10s/±1m/±10m, pick a speed, a persistent "Historical playback" indicator, return to live, and
 * a visible warning wherever the recorder had a feed gap.
 */
export function PlaybackControls(props: PlaybackControlsProps): JSX.Element {
  const [pending, setPending] = useState<string | null>(null);
  const inputValue = pending ?? toLocalInputValue(props.atIso);

  return (
    <div className="playback" aria-label="Historical playback controls">
      <div className="playback__row">
        <span className="playback__badge" role="status">
          Historical playback
        </span>
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
        <button
          type="button"
          className="playback__btn"
          onClick={props.playing ? props.onPause : props.onPlay}
          disabled={props.loading || (props.atLiveEdge && !props.playing)}
          aria-pressed={props.playing}
        >
          {props.playing ? "Pause" : "Play"}
        </button>
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

      <div className="playback__clock" aria-live="polite">
        {new Date(props.atIso).toLocaleString("en-GB", { timeZone: "Europe/London" })}
        {props.atLiveEdge ? " — caught up to live" : ""}
      </div>

      {props.quality.gaps.length > 0 && (
        <ul className="playback__gaps" aria-label="Feed gap warnings">
          {props.quality.gaps.map((gap) => (
            <li key={gap} className="playback__gap">
              ⚠ {gap}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
