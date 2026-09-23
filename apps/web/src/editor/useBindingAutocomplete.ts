import { useEffect, useState } from "react";

interface AreasResponse {
  areas: Array<{ tdArea: string }>;
}
/** docs/MAP_EDITOR_SPEC.md §7/§9: TD area autocomplete from `GET /api/v1/td/areas` (reads the
 * `td_area_summary` rollup, so it's cheap). There is deliberately no berth autocomplete: its
 * endpoint grouped an area's entire `td_berth_event` history, and one editor visit on
 * 2026-09-23 ran it for ~14 minutes, starving TD ingest until every map went stale. The owner
 * confirmed the berth list wasn't needed, so both it and the endpoint were removed. */
export function useObservedAreas(): string[] {
  const [areas, setAreas] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/td/areas")
      .then((response) => (response.ok ? (response.json() as Promise<AreasResponse>) : null))
      .then((body) => {
        if (!cancelled && body) setAreas(body.areas.map((a) => a.tdArea));
      })
      .catch(() => {
        // Autocomplete is a convenience, not a correctness requirement — silently empty on failure.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return areas;
}

/** Milestone 36c: TD areas with decoded S-Class data (for binding a signal). */
export function useSClassAreas(): string[] {
  const [areas, setAreas] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/editor/s-class/areas")
      .then((response) => (response.ok ? (response.json() as Promise<{ areas: string[] }>) : null))
      .then((body) => {
        if (!cancelled && body) setAreas(body.areas);
      })
      .catch(() => {
        // Best-effort autocomplete.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return areas;
}

export interface SClassDefinitionOption {
  address: string;
  bit: number;
  kind: string;
  label: string | null;
  destination: string | null;
}

/** Milestone 36c: an area's S-Class definitions (so a signal can be bound by label). */
export function useSClassDefinitions(tdArea: string | null): SClassDefinitionOption[] {
  const [definitions, setDefinitions] = useState<SClassDefinitionOption[]>([]);
  useEffect(() => {
    if (!tdArea || !/^[A-Z0-9]{2}$/.test(tdArea)) {
      setDefinitions([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/v1/editor/s-class/areas/${encodeURIComponent(tdArea)}/definitions`)
      .then((response) =>
        response.ok
          ? (response.json() as Promise<{ definitions: SClassDefinitionOption[] }>)
          : null,
      )
      .then((body) => {
        if (!cancelled && body) setDefinitions(body.definitions);
      })
      .catch(() => {
        // Best-effort autocomplete.
      });
    return () => {
      cancelled = true;
    };
  }, [tdArea]);
  return definitions;
}
