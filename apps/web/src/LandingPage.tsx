import { useEffect, useState } from "react";
import { readApiJson } from "./editor/apiJson.js";
import { navigate } from "./useRoute.js";

interface MapListEntry {
  slug: string;
  name: string;
  mapVersion: number;
  liveDataStatus: "ok" | "stale" | "unknown";
}

interface PlaceSearchResult {
  tiploc: string | null;
  stanox: string | null;
  crs: string | null;
  name: string;
  mapSlug: string | null;
  elementId: string | null;
}

interface ErrorBody {
  error?: { message?: string };
}

async function extractError(response: Response, fallback: string): Promise<string> {
  const body = await readApiJson<ErrorBody>(response);
  return body.error?.message ?? fallback;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Debounce delay for the place search box, matching the editor's own autosave debounce
 * convention (`useDraftSync.ts`) rather than firing a request on every keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

export interface LandingPageProps {
  /** Only an admin session sees the "+ New map" control (Milestone 30's create route is
   * admin-only, unlike the rest of the editor API). */
  canCreateMap: boolean;
  /** Any editor-or-admin session gets a per-row "Edit" link straight into that map's editor. */
  canEdit: boolean;
}

/**
 * Milestone 30: the new default page — every current map in a left-hand list, replacing the old
 * hardcoded-to-Lancaster `/` route. Milestone 31 adds the right-hand nationwide place search.
 */
export function LandingPage({ canCreateMap, canEdit }: LandingPageProps): JSX.Element {
  const [maps, setMaps] = useState<MapListEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceSearchResult[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  async function load(): Promise<void> {
    try {
      const response = await fetch("/api/v1/maps");
      if (!response.ok) {
        setLoadError(await extractError(response, `Failed to load maps (${response.status})`));
        return;
      }
      const body = await readApiJson<{ maps: MapListEntry[] }>(response);
      setMaps(body.maps);
      setLoadError(null);
    } catch {
      setLoadError("Failed to load maps.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

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

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const response = await fetch("/api/v1/editor/maps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: newSlug, name: newName }),
      });
      if (!response.ok) {
        setCreateError(await extractError(response, "Failed to create map."));
        return;
      }
      const created = await readApiJson<{ slug: string }>(response);
      navigate(`/editor/${encodeURIComponent(created.slug)}`);
    } finally {
      setCreating(false);
    }
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
        <h2>Maps</h2>
        {maps.length === 0 ? (
          <p className="panel-card panel-card--empty">No maps published yet.</p>
        ) : (
          <ul className="landing-page__maps">
            {maps.map((map) => (
              <li key={map.slug} className="landing-page__map-row">
                <a
                  href={`/map/${encodeURIComponent(map.slug)}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/map/${encodeURIComponent(map.slug)}`);
                  }}
                >
                  {map.name}
                </a>
                <span
                  className={`landing-page__status landing-page__status--${map.liveDataStatus}`}
                >
                  {map.liveDataStatus}
                </span>
                {canEdit && (
                  <a
                    className="landing-page__edit-link"
                    href={`/editor/${encodeURIComponent(map.slug)}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/editor/${encodeURIComponent(map.slug)}`);
                    }}
                  >
                    Edit
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}

        {canCreateMap && (
          <form className="panel-card" onSubmit={(e) => void handleCreate(e)}>
            <h3>New map</h3>
            {createError && (
              <p role="alert" className="login-form__error">
                {createError}
              </p>
            )}
            <label className="field">
              Name
              <input
                type="text"
                value={newName}
                onChange={(e) => {
                  const name = e.target.value;
                  setNewName(name);
                  if (!slugEdited) setNewSlug(slugify(name));
                }}
                required
              />
            </label>
            <label className="field">
              Slug
              <input
                type="text"
                value={newSlug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setNewSlug(e.target.value);
                }}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                required
              />
            </label>
            <button type="submit" className="btn btn--primary" disabled={creating}>
              {creating ? "Creating…" : "Create map"}
            </button>
          </form>
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
            {results.map((place, index) => {
              const identifiers = [place.crs, place.tiploc, place.stanox]
                .filter((v): v is string => Boolean(v))
                .join(" / ");
              const href =
                place.mapSlug && place.elementId
                  ? `/map/${encodeURIComponent(place.mapSlug)}?center=${encodeURIComponent(place.elementId)}`
                  : null;
              return (
                <li
                  key={`${place.tiploc ?? place.crs ?? place.stanox ?? index}`}
                  className="landing-page__place-row"
                >
                  {href ? (
                    <a
                      href={href}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(href);
                      }}
                    >
                      {place.name}
                    </a>
                  ) : (
                    <span className="landing-page__place-name">{place.name}</span>
                  )}
                  {identifiers && (
                    <span className="landing-page__place-identifiers">{identifiers}</span>
                  )}
                  {!href && (
                    <span className="landing-page__place-inert">not on any published map yet</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
