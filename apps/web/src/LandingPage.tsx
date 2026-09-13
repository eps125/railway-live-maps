import { useEffect, useState } from "react";
import { readApiJson } from "./editor/apiJson.js";
import { navigate } from "./useRoute.js";

interface MapListEntry {
  slug: string;
  name: string;
  mapVersion: number;
  liveDataStatus: "ok" | "stale" | "unknown";
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

export interface LandingPageProps {
  /** Only an admin session sees the "+ New map" control (Milestone 30's create route is
   * admin-only, unlike the rest of the editor API). */
  canCreateMap: boolean;
  /** Any editor-or-admin session gets a per-row "Edit" link straight into that map's editor. */
  canEdit: boolean;
}

/**
 * Milestone 30: the new default page — every current map in a left-hand list, replacing the old
 * hardcoded-to-Lancaster `/` route. The right-hand CRS/TIPLOC/STANOX search box is Milestone 31;
 * not built here since there is nothing for it to search yet (`GET /api/v1/places/search` doesn't
 * exist until that milestone lands).
 */
export function LandingPage({ canCreateMap, canEdit }: LandingPageProps): JSX.Element {
  const [maps, setMaps] = useState<MapListEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);

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
    </div>
  );
}
