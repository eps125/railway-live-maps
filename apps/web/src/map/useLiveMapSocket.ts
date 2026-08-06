import { useEffect, useRef, useState } from "react";
import type { LiveWsMessage } from "@railway/protocol";
import type { BerthState, SignalState } from "./types.js";

export type LiveConnectionStatus = "connecting" | "live" | "stale" | "reconnecting";

export interface UseLiveMapSocketResult {
  connectionStatus: LiveConnectionStatus;
  sequence: number | null;
  berths: Record<string, BerthState> | null;
  signals: Record<string, SignalState> | null;
  quality: { status: "ok" | "stale" | "unknown"; gaps: string[] } | null;
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
  const [quality, setQuality] = useState<{
    status: "ok" | "stale" | "unknown";
    gaps: string[];
  } | null>(null);
  const lastSequenceRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

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

      if (lastSequenceRef.current !== null && message.sequence < lastSequenceRef.current) {
        // A sequence regression — this stream's guarantee is non-decreasing, so something
        // upstream reset. Discard and force a fresh snapshot via reconnect.
        socket?.close();
        return;
      }
      lastSequenceRef.current = message.sequence;
      setSequence(message.sequence);

      if (message.type === "snapshot") {
        setBerths(message.state.berths);
        setSignals(message.state.signals);
        setQuality(message.state.quality);
        setConnectionStatus("live");
        return;
      }
      if (message.type === "berth.updated") {
        setBerths((prev) => ({
          ...prev,
          [message.elementId]: {
            description: message.description,
            enteredAt: message.enteredAt,
            runSummary: message.runSummary,
          },
        }));
        return;
      }
      if (message.type === "berth.cleared") {
        setBerths((prev) => ({
          ...prev,
          [message.elementId]: { description: null, enteredAt: null, runSummary: null },
        }));
        return;
      }
      if (message.type === "quality.updated") {
        setQuality(message.quality);
      }
      // run.resolution.updated: no rendering consumer until Milestone 9 — safely ignored.
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
      socket?.close();
    };
  }, [slug]);

  return { connectionStatus, sequence, berths, signals, quality };
}
