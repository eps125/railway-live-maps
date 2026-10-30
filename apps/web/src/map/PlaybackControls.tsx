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
}

const CLOCK_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const CLOCK_DATE = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

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
 * ±10s/±1m/±10m, pick a speed, and a warning wherever the recorder had a feed gap. The persistent
 * "Historical playback" indicator and the way back to live are the toolbar's Live / Playback
 * switch (MapView), with the status also announced here.
 *
 * 2026-10-30 (owner: the controls took half a phone's screen): one compact bar — play/pause, the
 * clock in large type, speed and a calendar button, then the step buttons; "Go to" opens from the
 * calendar button. On a phone the bar sits under the map; on a computer it is one line above it.
 *
 * Owner, 2026-10-10: the list of outages is for admins only (the API sends `gaps` to no one
 * else), behind a toggle they can minimise (remembered in this browser); everyone else sees one
 * small orange warning that data may be incomplete, with no details.
 */
export function PlaybackControls(props: PlaybackControlsProps): JSX.Element {
  const [pending, setPending] = useState<string | null>(null);
  const [goToOpen, setGoToOpen] = useState(false);
  const [gapsOpen, setGapsOpen] = useState<boolean>(readGapsOpen);
  const gapCount = props.quality.gaps.length;

  function toggleGaps(): void {
    setGapsOpen((open) => {
      writeGapsOpen(!open);
      return !open;
    });
  }
  const inputValue = pending ?? toLocalInputValue(props.atIso);
  const at = new Date(props.atIso);

  return (
    <div className="playback" aria-label="Historical playback controls">
      <span className="visually-hidden" role="status">
        Historical playback
      </span>
      <div className="playback__main">
        <button
          type="button"
          className="playback__play"
          onClick={props.playing ? props.onPause : props.onPlay}
          disabled={props.loading || (props.atLiveEdge && !props.playing)}
          aria-pressed={props.playing}
          aria-label={props.playing ? "Pause" : "Play"}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {props.playing ? (
              <path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor" />
            ) : (
              <path d="M4.5 2.5v11l9-5.5z" fill="currentColor" />
            )}
          </svg>
        </button>
        <div className="playback__clock" aria-live="polite">
          <span className="playback__time">
            {Number.isNaN(at.getTime()) ? props.atIso : CLOCK_TIME.format(at)}
          </span>
          <span className="playback__date">
            {Number.isNaN(at.getTime()) ? "" : CLOCK_DATE.format(at)}
            {props.atLiveEdge ? " · caught up to live" : ""}
          </span>
        </div>
        <select
          className="playback__speed"
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
        <button
          type="button"
          className="playback__btn playback__icon-btn"
          aria-label="Go to a time"
          aria-expanded={goToOpen}
          onClick={() => setGoToOpen((open) => !open)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect
              x="2"
              y="3"
              width="12"
              height="11"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="playback__steps">
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
      </div>

      {goToOpen ? (
        <div className="playback__row playback__goto">
          <input
            type="datetime-local"
            value={inputValue}
            onChange={(e) => setPending(e.target.value)}
            aria-label="Playback date and time"
          />
          <button
            type="button"
            className="playback__btn"
            disabled={!pending}
            onClick={() => {
              if (!pending) return;
              const ms = new Date(pending).getTime();
              if (!Number.isNaN(ms)) props.onJump(ms);
              setPending(null);
              setGoToOpen(false);
            }}
          >
            Jump
          </button>
        </div>
      ) : null}

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
