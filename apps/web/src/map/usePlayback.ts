import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BerthState,
  MapEventsResponse,
  MapStateResponse,
  PlaybackDelta,
  SignalState,
} from "./types.js";

/** docs/PROJECT_SPEC.md §5 "Playback" — the speed multipliers a visitor can pick. 20×/60× are
 * for scrubbing across hours; the event buffer refills as the clock runs, so if the network
 * can't keep up the map briefly holds at the buffer edge then catches up. */
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 5, 10, 20, 60] as const;

/** Step sizes (ms) — backward/forward by 10 seconds, 1 minute and 10 minutes. */
export const PLAYBACK_STEPS_MS = [
  { label: "-10m", ms: -600_000 },
  { label: "-1m", ms: -60_000 },
  { label: "-10s", ms: -10_000 },
  { label: "+10s", ms: 10_000 },
  { label: "+1m", ms: 60_000 },
  { label: "+10m", ms: 600_000 },
] as const;

// Wide enough that even 200× (30 min of playback ≈ 9 s real) needs a refill only every few
// seconds; a Lancaster-sized 30-min window is well under the /events default page size.
const BUFFER_WINDOW_MS = 30 * 60_000;
const REFILL_WHEN_REMAINING_MS = 10 * 60_000;
const TICK_MS = 200;
/** Never let the playback clock run into the live present. */
const LIVE_EDGE_MS = 5_000;

type Berths = Record<string, BerthState>;
type Signals = Record<string, SignalState>;
type Quality = { status: "ok" | "stale" | "unknown"; gaps: string[] };

/** Pure: apply one compact event to a berth map (same semantics as the live WS client). */
export function applyPlaybackDelta(berths: Berths, delta: PlaybackDelta): Berths {
  if (delta.type === "berth.cleared") {
    return { ...berths, [delta.elementId]: { description: null, enteredAt: null } };
  }
  return {
    ...berths,
    [delta.elementId]: { description: delta.description, enteredAt: delta.enteredAt },
  };
}

export interface UsePlaybackResult {
  /** Current playback position, ms epoch. */
  clock: number;
  atIso: string;
  playing: boolean;
  speed: number;
  loading: boolean;
  error: string | null;
  berths: Berths;
  signals: Signals;
  quality: Quality;
  /** True once the clock has reached the live edge — further forward play is capped. */
  atLiveEdge: boolean;
  play: () => void;
  pause: () => void;
  setSpeed: (speed: number) => void;
  /** Jump to an absolute time (ms epoch), re-seeding state there. */
  jumpTo: (atMs: number) => void;
  /** Move by a relative amount (ms), re-seeding state at the target. */
  step: (deltaMs: number) => void;
}

/**
 * Milestone 10 playback (docs/API_CONTRACT.md §3): seed state from `/state?at=`, buffer forward
 * events from `/events`, advance a local clock and apply buffered events as it passes their
 * `eventAt`, refill the buffer before it runs out. Any `jumpTo`/`step` re-seeds at the target
 * (cheap — two small requests) rather than trying to unwind applied deltas.
 */
export function usePlayback(slug: string, initialAtMs: number): UsePlaybackResult {
  const [clock, setClock] = useState(initialAtMs);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [berths, setBerths] = useState<Berths>({});
  const [signals, setSignals] = useState<Signals>({});
  const [quality, setQuality] = useState<Quality>({ status: "unknown", gaps: [] });

  // Refs the interval tick reads without forcing itself to re-subscribe.
  const clockRef = useRef(clock);
  const playingRef = useRef(playing);
  const speedRef = useRef(speed);
  const berthsRef = useRef(berths);
  const bufferRef = useRef<PlaybackDelta[]>([]);
  const bufferIdxRef = useRef(0);
  const bufferedToRef = useRef(initialAtMs);
  const cursorRef = useRef<string | null>(null);
  const seekIdRef = useRef(0);
  const refillingRef = useRef(false);

  clockRef.current = clock;
  playingRef.current = playing;
  speedRef.current = speed;
  berthsRef.current = berths;

  const seed = useCallback(
    async (atMs: number) => {
      const seekId = ++seekIdRef.current;
      setLoading(true);
      setError(null);
      const atIso = new Date(atMs).toISOString();
      try {
        const [stateRes, eventsRes] = await Promise.all([
          fetch(`/api/v1/maps/${slug}/state?at=${encodeURIComponent(atIso)}`),
          fetch(
            `/api/v1/maps/${slug}/events?from=${encodeURIComponent(atIso)}&to=${encodeURIComponent(
              new Date(atMs + BUFFER_WINDOW_MS).toISOString(),
            )}`,
          ),
        ]);
        if (seekId !== seekIdRef.current) return;
        if (!stateRes.ok) throw new Error(`state ${stateRes.status}`);
        if (!eventsRes.ok) throw new Error(`events ${eventsRes.status}`);
        const state = (await stateRes.json()) as MapStateResponse;
        const events = (await eventsRes.json()) as MapEventsResponse;
        if (seekId !== seekIdRef.current) return;
        setBerths(state.berths);
        setSignals(state.signals);
        setQuality(state.quality);
        bufferRef.current = events.events;
        bufferIdxRef.current = 0;
        bufferedToRef.current = atMs + BUFFER_WINDOW_MS;
        cursorRef.current = events.nextCursor;
        setClock(atMs);
      } catch (err) {
        if (seekId === seekIdRef.current) {
          setError(err instanceof Error ? err.message : "Failed to load playback state");
        }
      } finally {
        if (seekId === seekIdRef.current) setLoading(false);
      }
    },
    [slug],
  );

  const refill = useCallback(async () => {
    if (refillingRef.current || cursorRef.current === null) return;
    refillingRef.current = true;
    const seekId = seekIdRef.current;
    const from = new Date(bufferedToRef.current).toISOString();
    const to = new Date(bufferedToRef.current + BUFFER_WINDOW_MS).toISOString();
    try {
      const res = await fetch(
        `/api/v1/maps/${slug}/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(
          to,
        )}&after=${encodeURIComponent(cursorRef.current)}`,
      );
      if (!res.ok || seekId !== seekIdRef.current) return;
      const page = (await res.json()) as MapEventsResponse;
      if (seekId !== seekIdRef.current) return;
      bufferRef.current = bufferRef.current.concat(page.events);
      bufferedToRef.current += BUFFER_WINDOW_MS;
      cursorRef.current = page.nextCursor;
    } catch {
      // A failed refill just means the clock will stall at the buffer edge; the next tick retries.
    } finally {
      refillingRef.current = false;
    }
  }, [slug]);

  // Initial seed, and a re-seed if the map (→ `seed` identity) changes. `initialAtMs` is the
  // starting position only; later moves go through jumpTo/step, so it's captured once here.
  const initialAtRef = useRef(initialAtMs);
  useEffect(() => {
    void seed(initialAtRef.current);
  }, [seed]);

  // The clock/apply loop.
  useEffect(() => {
    let last = Date.now();
    const id = window.setInterval(() => {
      const now = Date.now();
      const realElapsed = now - last;
      last = now;
      if (!playingRef.current) return;

      const liveEdge = now - LIVE_EDGE_MS;
      let next = clockRef.current + realElapsed * speedRef.current;
      if (next >= liveEdge) {
        next = liveEdge;
        setPlaying(false);
      }

      // Apply every buffered delta the clock has now passed.
      const buffer = bufferRef.current;
      let applied: Berths | null = null;
      while (bufferIdxRef.current < buffer.length) {
        const delta = buffer[bufferIdxRef.current];
        if (!delta || Date.parse(delta.eventAt) > next) break;
        applied = applyPlaybackDelta(applied ?? berthsRef.current, delta);
        bufferIdxRef.current += 1;
      }
      if (applied) setBerths(applied);
      clockRef.current = next;
      setClock(next);

      if (bufferedToRef.current - next < REFILL_WHEN_REMAINING_MS) void refill();
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [refill]);

  const play = useCallback(() => setPlaying(true), []);
  const pause = useCallback(() => setPlaying(false), []);
  const setSpeed = useCallback((s: number) => setSpeedState(s), []);
  const jumpTo = useCallback(
    (atMs: number) => {
      const capped = Math.min(atMs, Date.now() - LIVE_EDGE_MS);
      setPlaying(false);
      void seed(capped);
    },
    [seed],
  );
  const step = useCallback(
    (deltaMs: number) => {
      const capped = Math.min(clockRef.current + deltaMs, Date.now() - LIVE_EDGE_MS);
      setPlaying(false);
      void seed(capped);
    },
    [seed],
  );

  return {
    clock,
    atIso: new Date(clock).toISOString(),
    playing,
    speed,
    loading,
    error,
    berths,
    signals,
    quality,
    atLiveEdge: clock >= Date.now() - LIVE_EDGE_MS - TICK_MS,
    play,
    pause,
    setSpeed,
    jumpTo,
    step,
  };
}
