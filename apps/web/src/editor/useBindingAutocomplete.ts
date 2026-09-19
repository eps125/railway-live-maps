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

interface PlaceSearchResponse {
  results: Array<{ stanox: string | null; name: string }>;
}

/** docs/adr/0012: STANOX autocomplete for a virtual berth's binding, reusing the existing public
 * `GET /api/v1/places/search` (Milestone 31) rather than a new endpoint — it already searches
 * `location_reference` by name/TIPLOC/CRS/STANOX nationwide. Debounced since (unlike the TD
 * area/berth lists) this is a live text search, not a small fixed list fetched once. */
export function useStanoxSuggestions(query: string): string[] {
  const [stanoxes, setStanoxes] = useState<string[]>([]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setStanoxes([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      fetch(`/api/v1/places/search?q=${encodeURIComponent(trimmed)}&limit=20`)
        .then((response) =>
          response.ok ? (response.json() as Promise<PlaceSearchResponse>) : null,
        )
        .then((body) => {
          if (cancelled || !body) return;
          const unique = [
            ...new Set(body.results.map((r) => r.stanox).filter((s): s is string => !!s)),
          ];
          setStanoxes(unique);
        })
        .catch(() => {
          // Autocomplete is a convenience, not a correctness requirement — silently empty on failure.
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  return stanoxes;
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
