import { useEffect, useMemo, useState } from "react";
import { readApiJson } from "./editor/apiJson.js";
import { navigate } from "./useRoute.js";
import {
  filterMaps,
  groupMaps,
  loadMapListSort,
  saveMapListSort,
  type MapListEntry,
  type MapListSort,
} from "./mapList.js";

interface PlaceMap {
  slug: string;
  name: string;
  elementId: string;
}

interface PlaceSearchResult {
  tiploc: string | null;
  stanox: string | null;
  crs: string | null;
  name: string;
  /** Milestone 83: every map with this place that the viewer may see, by name. */
  maps: PlaceMap[];
}

/** The editor's view of a map (`GET /api/v1/editor/maps`), for the "Unpublished maps" list. */
interface EditorMapEntry {
  slug: string;
  name: string;
  publishedVersion: number | null;
}

interface ErrorBody {
  error?: { message?: string };
}

async function extractError(response: Response, fallback: string): Promise<string> {
  const body = await readApiJson<ErrorBody>(response);
  return body.error?.message ?? fallback;
}

/** Debounce delay for the place search box, matching the editor's own autosave debounce
 * convention (`useDraftSync.ts`) rather than firing a request on every keystroke. */
const SEARCH_DEBOUNCE_MS = 300;
/** Below this many maps a filter box is clutter. */
const FILTER_THRESHOLD = 8;

const STATUS_LABEL: Record<MapListEntry["liveDataStatus"], string> = {
  ok: "Live",
  stale: "Stale",
  unknown: "No data",
};

export interface LandingPageProps {
  /** Any editor-or-admin session gets a per-map "Edit" link and the "Unpublished maps" list. */
  canEdit: boolean;
  /** An admin also gets a link to Admin › Maps, where maps are created, renamed and deleted. */
  isAdmin: boolean;
}

function linkTo(path: string) {
  return {
    href: path,
    onClick: (e: React.MouseEvent) => {
      e.preventDefault();
      navigate(path);
    },
  };
}

/**
 * Milestone 30's default page — every map the visitor may see, with Milestone 31's nationwide
 * place search beside it. Milestone 83 (docs/adr/0018): maps are cards sorted by name, grouped
 * by region when the admin has turned grouping on (the visitor can switch to A–Z), with a filter
 * box once the list is long. Map management moved to Admin › Maps.
 */
export function LandingPage({ canEdit, isAdmin }: LandingPageProps): JSX.Element {
  const [maps, setMaps] = useState<MapListEntry[] | null>(null);
  const [regionGrouping, setRegionGrouping] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sort, setSort] = useState<MapListSort>(() => loadMapListSort());
  const [filter, setFilter] = useState("");
  const [unpublished, setUnpublished] = useState<EditorMapEntry[]>([]);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceSearchResult[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/v1/maps");
        if (!response.ok) {
          setLoadError(await extractError(response, `Failed to load maps (${response.status})`));
          return;
        }
        const body = await readApiJson<{ maps: MapListEntry[]; regionGrouping?: boolean }>(
          response,
        );
        setMaps(body.maps);
        setRegionGrouping(body.regionGrouping === true);
        setLoadError(null);
      } catch {
        setLoadError("Failed to load maps.");
      }
    })();
  }, []);

  // Editors also see maps that have never been published, so a new map is reachable without
  // remembering its address.
  useEffect(() => {
    if (!canEdit) return;
    void (async () => {
      try {
        const response = await fetch("/api/v1/editor/maps");
        if (!response.ok) return;
        const body = await readApiJson<{ maps: EditorMapEntry[] }>(response);
        setUnpublished(body.maps.filter((map) => map.publishedVersion === null));
      } catch {
        // The public list still works; the unpublished list just stays empty.
      }
    })();
  }, [canEdit]);

  // Milestone 31: debounced as-you-type place search. A trimmed-empty query just clears the
  // results rather than searching — `GET /api/v1/places/search` requires a non-empty `q`.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/v1/places/search?q=${encodeURIComponent(trimmed)}`);
        if (!response.ok) {
          setSearchError(await extractError(response, `Search failed (${response.status})`));
          setResults(null);
          return;
        }
        const body = await readApiJson<{ results: PlaceSearchResult[] }>(response);
        setResults(body.results);
        setSearchError(null);
      } catch {
        setSearchError("Search failed.");
        setResults(null);
      } finally {
        setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const effectiveSort: MapListSort = regionGrouping ? sort : "az";
  const groups = useMemo(
    () => (maps ? groupMaps(filterMaps(maps, filter), effectiveSort) : []),
    [maps, filter, effectiveSort],
  );

  function chooseSort(next: MapListSort): void {
    setSort(next);
    saveMapListSort(next);
  }

  if (loadError) {
    return (
      <p role="alert" className="app-error">
        {loadError}
      </p>
    );
  }
  if (!maps) {
    return <p className="app-loading">Loading maps…</p>;
  }

  return (
    <div className="landing-page">
      <div className="landing-page__list">
        <div className="landing-page__list-header">
          <h2>Maps</h2>
          {regionGrouping && maps.length > 0 && (
            <div className="btn-group" role="group" aria-label="Sort maps">
              <button
                type="button"
                className="btn"
                aria-pressed={sort === "region"}
                onClick={() => chooseSort("region")}
              >
                By region
              </button>
              <button
                type="button"
                className="btn"
                aria-pressed={sort === "az"}
                onClick={() => chooseSort("az")}
              >
                A–Z
              </button>
            </div>
          )}
          {isAdmin && (
            <a className="landing-page__manage-link" {...linkTo("/admin/maps")}>
              Manage maps
            </a>
          )}
        </div>

        {maps.length > FILTER_THRESHOLD && (
          <label className="field">
            Filter maps
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Name, description or region"
            />
          </label>
        )}

        {maps.length === 0 ? (
          <p className="panel-card panel-card--empty">No maps published yet.</p>
        ) : groups.length === 0 ? (
          <p className="panel-card panel-card--empty">No maps match “{filter.trim()}”.</p>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="map-group" aria-label={group.title ?? "Maps"}>
              {group.title && <h3 className="map-group__title">{group.title}</h3>}
              <ul className="map-cards">
                {group.maps.map((map) => (
                  <li key={map.slug} className="map-card">
                    <div className="map-card__head">
                      <a
                        className="map-card__name"
                        {...linkTo(`/map/${encodeURIComponent(map.slug)}`)}
                      >
                        {map.name}
                      </a>
                      <span
                        className={`map-card__status map-card__status--${map.liveDataStatus}`}
                        title="Live train describer data for this map's areas"
                      >
                        {STATUS_LABEL[map.liveDataStatus]}
                      </span>
                    </div>
                    {map.description && <p className="map-card__description">{map.description}</p>}
                    {(map.visibility === "restricted" || canEdit) && (
                      <div className="map-card__meta">
                        {map.visibility === "restricted" && (
                          <span
                            className="map-card__badge"
                            title="Only some signed-in users can see this map"
                          >
                            Not public
                          </span>
                        )}
                        {canEdit && (
                          <a
                            className="map-card__edit"
                            {...linkTo(`/editor/${encodeURIComponent(map.slug)}`)}
                          >
                            Edit
                          </a>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}

        {canEdit && unpublished.length > 0 && (
          <section className="map-group" aria-label="Unpublished maps">
            <h3 className="map-group__title">Unpublished maps</h3>
            <ul className="map-cards">
              {unpublished.map((map) => (
                <li key={map.slug} className="map-card map-card--draft">
                  <div className="map-card__head">
                    <a
                      className="map-card__name"
                      {...linkTo(`/editor/${encodeURIComponent(map.slug)}`)}
                    >
                      {map.name}
                    </a>
                    <span className="map-card__status">Draft</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="landing-page__search">
        <h2>Find a place</h2>
        <label className="field">
          Name, CRS, TIPLOC or STANOX
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. Lancaster, LAN, LANCSTR"
          />
        </label>

        {searchError && (
          <p role="alert" className="login-form__error">
            {searchError}
          </p>
        )}

        {searching && <p className="app-loading">Searching…</p>}

        {!searching && results !== null && results.length === 0 && (
          <p className="panel-card panel-card--empty">No matches.</p>
        )}

        {!searching && results !== null && results.length > 0 && (
          <ul className="landing-page__places">
            {results.map((place, index) => (
              <PlaceResult
                key={`${place.tiploc ?? place.crs ?? place.stanox ?? index}`}
                place={place}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function placeHref(map: PlaceMap): string {
  return `/map/${encodeURIComponent(map.slug)}?center=${encodeURIComponent(map.elementId)}`;
}

/** One place: its name links straight to the map when exactly one map has it; with several, the
 * maps are listed underneath for the visitor to choose; with none, it says so. */
function PlaceResult({ place }: { place: PlaceSearchResult }): JSX.Element {
  const identifiers = [place.crs, place.tiploc, place.stanox]
    .filter((v): v is string => Boolean(v))
    .join(" / ");
  const only = place.maps.length === 1 ? place.maps[0]! : null;
  return (
    <li className="landing-page__place-row">
      <div className="landing-page__place-head">
        {only ? (
          <a {...linkTo(placeHref(only))}>{place.name}</a>
        ) : (
          <span className="landing-page__place-name">{place.name}</span>
        )}
        {identifiers && <span className="landing-page__place-identifiers">{identifiers}</span>}
      </div>
      {only && <span className="landing-page__place-maps-label">on {only.name}</span>}
      {place.maps.length > 1 && (
        <div className="landing-page__place-maps">
          <span className="landing-page__place-maps-label">On {place.maps.length} maps:</span>
          <ul>
            {place.maps.map((map) => (
              <li key={map.slug}>
                <a {...linkTo(placeHref(map))}>{map.name}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {place.maps.length === 0 && (
        <span className="landing-page__place-inert">not on any map yet</span>
      )}
    </li>
  );
}
