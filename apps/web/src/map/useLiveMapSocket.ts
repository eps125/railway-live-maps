import { useEffect, useMemo, useRef, useState } from "react";
import type { BerthDelay, LiveWsMessage } from "@railway/protocol";
import type { BerthState, CrossingState, RouteState, SignalState, TrtsState } from "./types.js";
import { patchInPlace } from "./recordChanges.js";

export type LiveConnectionStatus = "connecting" | "live" | "stale" | "reconnecting";

export interface UseLiveMapSocketResult {
  connectionStatus: LiveConnectionStatus;
  sequence: number | null;
  berths: Record<string, BerthState> | null;
  signals: Record<string, SignalState> | null;
  crossings: Record<string, CrossingState> | null;
  routes: Record<string, RouteState> | null;
  /** Milestone 92: each starting signal's TRTS state, keyed by signal. */
  trts: Record<string, TrtsState> | null;
  quality: {
    status: "ok" | "stale" | "unknown";
    gaps: string[];
    incomplete?: boolean | undefined;
  } | null;
  /** Milestone 82: banded berths — the snapshot's list, kept current by `delay.updated` pushes
   * (sent only when openrail-eps reports on a train on this map). Null until a snapshot. */
  delays: BerthDelay[] | null;
  /** Milestone 94: changes whenever a frame's deltas are patched into the records above, which
   * keep their identity (see recordChanges.ts) — anything derived from them depends on this. */
  revision: number;
}

/** Apply one `delay.updated`: it re-states a run's band wherever the train now is, so it
 * replaces that run's entry; `none` removes it. Exported for tests. */
export function applyDelayUpdate(
  current: Record<string, BerthDelay>,
  update: BerthDelay | { runKey: string; band: "none" },
): Record<string, BerthDelay> {
  const next = { ...current };
  if (update.band === "none") delete next[update.runKey];
  else next[update.runKey] = update;
  return next;
}

/** Milestone 94: the live per-element deltas waiting for the next frame, latest per element. */
interface PendingDeltas {
  berths: Record<string, BerthState>;
  signals: Record<string, SignalState>;
  crossings: Record<string, CrossingState>;
  routes: Record<string, RouteState>;
  trts: Record<string, TrtsState>;
}

function emptyPending(): PendingDeltas {
  return { berths: {}, signals: {}, crossings: {}, routes: {}, trts: {} };
}

function hasAny(record: Record<string, unknown>): boolean {
  for (const _ in record) return true;
  return false;
}

/** Same shape/parameters as apps/worker/src/td/connection/backoff.ts's `computeBackoffDelayMs`
 * — duplicated here deliberately (web can't import worker code, and it's a few lines). */
function computeBackoffDelayMs(attempt: number): number {
  const base = 500;
  const max = 15_000;
  const jitterRatio = 0.2;
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt));
  const jitter = exponential * jitterRatio * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}

function liveWsUrl(slug: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/v1/maps/${encodeURIComponent(slug)}/live`;
}

/** Milestone 6: connects to `GET /api/v1/maps/{slug}/live`, applies the snapshot-then-deltas
 * protocol (docs/API_CONTRACT.md §2), and reconnects with exponential backoff on close/error.
 * A `resync.required` message or a `sequence` that goes backwards (this server's sequences are
 * only ever non-decreasing — a decrease means something upstream reset) triggers a full
 * reconnect rather than trying to patch state in place, since only a fresh snapshot can be
 * trusted at that point. */
export function useLiveMapSocket(slug: string): UseLiveMapSocketResult {
  const [connectionStatus, setConnectionStatus] = useState<LiveConnectionStatus>("connecting");
  const [sequence, setSequence] = useState<number | null>(null);
  const [berths, setBerths] = useState<Record<string, BerthState> | null>(null);
  const [signals, setSignals] = useState<Record<string, SignalState> | null>(null);
  const [crossings, setCrossings] = useState<Record<string, CrossingState> | null>(null);
  const [routes, setRoutes] = useState<Record<string, RouteState> | null>(null);
  const [trts, setTrts] = useState<Record<string, TrtsState> | null>(null);
  const [quality, setQuality] = useState<{
    status: "ok" | "stale" | "unknown";
    gaps: string[];
    incomplete?: boolean | undefined;
  } | null>(null);
  const [delays, setDelays] = useState<Record<string, BerthDelay> | null>(null);
  // Milestone 94: the records above are patched in place once per frame (see recordChanges.ts);
  // `revision` changes with every patch so the map re-renders, and `records` is the copy of the
  // current objects the frame's patch is applied to.
  const [revision, setRevision] = useState(0);
  const records = useRef<{
    berths: Record<string, BerthState> | null;
    signals: Record<string, SignalState> | null;
    crossings: Record<string, CrossingState> | null;
    routes: Record<string, RouteState> | null;
    trts: Record<string, TrtsState> | null;
  }>({ berths: null, signals: null, crossings: null, routes: null, trts: null });
  const lastSequenceRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    // Milestone 94: deltas are gathered and applied once per animation frame — one state copy
    // and one render per frame however many messages arrived, rather than one per message. Only
    // the latest value per element is kept, so the queue is bounded by the map's size even in a
    // background tab (where frames stop and only the timer fallback runs, throttled).
    let pending = emptyPending();
    let frame = 0;
    let fallback: ReturnType<typeof setTimeout> | null = null;
    let pendingSequence: number | null = null;

    function flush(): void {
      if (frame) cancelAnimationFrame(frame);
      if (fallback) clearTimeout(fallback);
      frame = 0;
      fallback = null;
      const batch = pending;
      pending = emptyPending();
      if (pendingSequence !== null) setSequence(pendingSequence);
      pendingSequence = null;
      let patched = false;
      function apply<K extends keyof PendingDeltas>(
        kind: K,
        setRecord: (record: PendingDeltas[K]) => void,
      ): void {
        const patch = batch[kind];
        if (!hasAny(patch)) return;
        const current = records.current[kind] as PendingDeltas[K] | null;
        if (current) {
          patchInPlace(current as Record<string, unknown>, patch as Record<string, unknown>);
          patched = true;
        } else {
          const created = { ...patch } as PendingDeltas[K];
          (records.current[kind] as PendingDeltas[K] | null) = created;
          setRecord(created);
        }
      }
      apply("berths", setBerths);
      apply("signals", setSignals);
      apply("crossings", setCrossings);
      apply("routes", setRoutes);
      apply("trts", setTrts);
      if (patched) setRevision((r) => r + 1);
    }

    function queue<K extends keyof PendingDeltas>(
      kind: K,
      elementId: string,
      value: PendingDeltas[K][string],
    ): void {
      (pending[kind] as Record<string, unknown>)[elementId] = value;
      schedule();
    }

    function schedule(): void {
      if (frame || fallback) return;
      if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(flush);
      // Frames stop in a background tab; the timer still drains the queue there.
      fallback = setTimeout(flush, 250);
    }

    function scheduleReconnect(): void {
      if (cancelled) return;
      setConnectionStatus("reconnecting");
      const delay = computeBackoffDelayMs(attempt);
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    }

    function handleMessage(event: MessageEvent<string>): void {
      let message: LiveWsMessage;
      try {
        message = JSON.parse(event.data) as LiveWsMessage;
      } catch {
        return; // malformed frame — ignore, next message (or a reconnect) will recover
      }

      if (message.type === "resync.required") {
        socket?.close();
        return;
      }
      if (message.type === "heartbeat") {
        return;
      }
      // Milestone 82: not part of the TD berth stream — no sequence, applied as it arrives.
      if (message.type === "delay.updated") {
        const { runKey, elementId, description, band, matchConfidence } = message;
        setDelays((current) =>
          applyDelayUpdate(
            current ?? {},
            band === "none"
              ? { runKey, band }
              : { runKey, elementId, description, band, matchConfidence },
          ),
        );
        return;
      }

      if (lastSequenceRef.current !== null && message.sequence < lastSequenceRef.current) {
        // A sequence regression — this stream's guarantee is non-decreasing, so something
        // upstream reset. Discard and force a fresh snapshot via reconnect.
        socket?.close();
        return;
      }
      lastSequenceRef.current = message.sequence;

      if (message.type === "snapshot") {
        // Anything still queued came before this snapshot, which supersedes it.
        pending = emptyPending();
        pendingSequence = null;
        setSequence(message.sequence);
        records.current = {
          berths: message.state.berths,
          signals: message.state.signals,
          // A server that predates crossings sends no record at all; treat that as "none",
          // never as stale state carried over from a previous snapshot.
          crossings: message.state.crossings ?? {},
          // Likewise routes (Milestone 64): none recorded means none set.
          routes: message.state.routes ?? {},
          // And TRTS (Milestone 92): none recorded means none lit.
          trts: message.state.trts ?? {},
        };
        setBerths(records.current.berths);
        setSignals(records.current.signals);
        setCrossings(records.current.crossings);
        setRoutes(records.current.routes);
        setTrts(records.current.trts);
        setQuality(message.state.quality);
        // A server without Milestone 82 sends none: no colours, never stale ones.
        setDelays(Object.fromEntries((message.state.delays ?? []).map((d) => [d.runKey, d])));
        setConnectionStatus("live");
        return;
      }
      // Every other message's sequence is published with the next frame's batch.
      pendingSequence = message.sequence;
      schedule();
      if (message.type === "berth.updated") {
        queue("berths", message.elementId, {
          description: message.description,
          enteredAt: message.enteredAt,
        });
        return;
      }
      if (message.type === "berth.cleared") {
        queue("berths", message.elementId, { description: null, enteredAt: null });
        return;
      }
      if (message.type === "trts.updated") {
        queue("trts", message.elementId, { state: message.state });
        return;
      }
      if (message.type === "route.updated") {
        queue("routes", message.elementId, { state: message.state });
        return;
      }
      if (message.type === "crossing.updated") {
        queue("crossings", message.elementId, { state: message.state });
        return;
      }
      if (message.type === "signal.updated") {
        queue("signals", message.elementId, { state: message.state });
        return;
      }
      if (message.type === "quality.updated") {
        setQuality(message.quality);
        return;
      }
      // `run.resolution.updated` was removed with the berth-run resolver (ADR 0002).
    }

    function connect(): void {
      if (cancelled) return;
      setConnectionStatus((prev) => (prev === "live" ? prev : "connecting"));
      lastSequenceRef.current = null;
      socket = new WebSocket(liveWsUrl(slug));

      socket.addEventListener("message", handleMessage);
      socket.addEventListener("open", () => {
        attempt = 0;
      });
      socket.addEventListener("close", () => {
        if (cancelled) return;
        scheduleReconnect();
      });
      socket.addEventListener("error", () => {
        socket?.close();
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (frame) cancelAnimationFrame(frame);
      if (fallback) clearTimeout(fallback);
      socket?.close();
    };
  }, [slug]);

  const delayList = useMemo(() => (delays ? Object.values(delays) : null), [delays]);
  return {
    connectionStatus,
    sequence,
    berths,
    signals,
    crossings,
    routes,
    trts,
    quality,
    delays: delayList,
    revision,
  };
}
