import { useEffect, useState } from "react";

interface AreasResponse {
  areas: Array<{ tdArea: string }>;
}
interface BerthsResponse {
  berths: Array<{ berthCode: string }>;
}

/** docs/MAP_EDITOR_SPEC.md §7/§9: binding autocomplete against "any observed nationwide TD
 * area/berth" — reuses the existing nationwide discovery endpoints
 * (`GET /api/v1/td/areas`, `GET /api/v1/td/areas/{area}/berths`) built for Milestone 4,
 * exactly as `docs/API_CONTRACT.md` §1 already documents them as feeding "map-authoring and
 * diagnostics." No new backend endpoint needed for the autocomplete list itself — only the
 * per-binding diagnostics detail (`bindingDiagnostics.ts`) is new. */
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

export function useObservedBerths(tdArea: string | null): string[] {
  const [berths, setBerths] = useState<string[]>([]);

  useEffect(() => {
    if (!tdArea) {
      setBerths([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/v1/td/areas/${encodeURIComponent(tdArea)}/berths?limit=200`)
      .then((response) => (response.ok ? (response.json() as Promise<BerthsResponse>) : null))
      .then((body) => {
        if (!cancelled && body) setBerths(body.berths.map((b) => b.berthCode));
      })
      .catch(() => {
        // Same as above — best-effort autocomplete.
      });
    return () => {
      cancelled = true;
    };
  }, [tdArea]);

  return berths;
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
