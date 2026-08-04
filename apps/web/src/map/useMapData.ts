import { useEffect, useState } from "react";
import type { MapDefinitionResponse, MapStateResponse } from "./types.js";

const STATE_POLL_INTERVAL_MS = 5000;

export interface UseMapDataResult {
  definition: MapDefinitionResponse | null;
  state: MapStateResponse | null;
  error: string | null;
  loading: boolean;
}

/** Fetches the map definition once and polls state on an interval — a true live push over
 * WebSocket is Milestone 6; this is the MVP data source for the Milestone 5 "basic renderer". */
export function useMapData(slug: string): UseMapDataResult {
  const [definition, setDefinition] = useState<MapDefinitionResponse | null>(null);
  const [state, setState] = useState<MapStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadDefinition(): Promise<void> {
      try {
        const response = await fetch(`/api/v1/maps/${slug}/definition`);
        if (!response.ok) {
          throw new Error(`Failed to load map definition (${response.status})`);
        }
        const body = (await response.json()) as MapDefinitionResponse;
        if (!cancelled) setDefinition(body);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load map definition");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadDefinition();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    let cancelled = false;

    async function loadState(): Promise<void> {
      try {
        const response = await fetch(`/api/v1/maps/${slug}/state`);
        if (!response.ok) {
          throw new Error(`Failed to load map state (${response.status})`);
        }
        const body = (await response.json()) as MapStateResponse;
        if (!cancelled) setState(body);
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
  }, [slug]);

  return { definition, state, error, loading };
}
