import { useEffect, useState } from "react";
import type { MapDefinitionResponse, MapStateResponse } from "./types.js";
import { useLiveMapSocket, type LiveConnectionStatus } from "./useLiveMapSocket.js";

const STATE_POLL_INTERVAL_MS = 5000;
const DEFINITION_RETRY_INTERVAL_MS = 5000;

export interface UseMapDataResult {
  definition: MapDefinitionResponse | null;
  state: MapStateResponse | null;
  error: string | null;
  loading: boolean;
  connectionStatus: LiveConnectionStatus;
}

/** Fetches the map definition once (structure/bindings, which only change on republish) and
 * sources live berth/signal/quality state from the WebSocket (Milestone 6) whenever it's
 * connected, falling back to the Milestone 5 REST `/state` poll otherwise — on initial connect,
 * on a socket drop, and while reconnecting. */
export function useMapData(slug: string): UseMapDataResult {
  const [definition, setDefinition] = useState<MapDefinitionResponse | null>(null);
  const [restState, setRestState] = useState<MapStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const live = useLiveMapSocket(slug);

  useEffect(() => {
    let cancelled = false;

    async function loadDefinition(): Promise<void> {
      try {
        const response = await fetch(`/api/v1/maps/${slug}/definition`);
        if (!response.ok) {
          throw new Error(`Failed to load map definition (${response.status})`);
        }
        const body = (await response.json()) as MapDefinitionResponse;
        if (cancelled) return;
        setDefinition(body);
        setError(null);
        // A published map's compiled bundle for "now" is stable — stop retrying once it loads.
        clearInterval(retryTimer);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load map definition");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadDefinition();
    // Not published yet (or a transient failure) when this page loaded is a normal race, not a
    // permanent state — keep retrying rather than getting stuck on the first failure forever.
    const retryTimer = setInterval(() => void loadDefinition(), DEFINITION_RETRY_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(retryTimer);
    };
  }, [slug]);

  // REST state polling is the fallback path — paused whenever the live socket is actually
  // delivering state, resumed the moment it isn't (initial connect, drop, reconnect backoff).
  useEffect(() => {
    if (live.connectionStatus === "live") return;

    let cancelled = false;

    async function loadState(): Promise<void> {
      try {
        const response = await fetch(`/api/v1/maps/${slug}/state`);
        if (!response.ok) {
          throw new Error(`Failed to load map state (${response.status})`);
        }
        const body = (await response.json()) as MapStateResponse;
        if (cancelled) return;
        setRestState(body);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load map state");
        }
      }
    }

    void loadState();
    const interval = setInterval(() => void loadState(), STATE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [slug, live.connectionStatus]);

  const state: MapStateResponse | null =
    live.connectionStatus === "live" && live.berths
      ? {
          mapSlug: slug,
          mapVersion: restState?.mapVersion ?? definition?.mapVersion ?? 0,
          asOf: new Date().toISOString(),
          sourceSequence: live.sequence ?? 0,
          mode: "live",
          quality: live.quality ?? { status: "unknown", gaps: [] },
          berths: live.berths,
          signals: live.signals ?? {},
        }
      : restState;

  return { definition, state, error, loading, connectionStatus: live.connectionStatus };
}
