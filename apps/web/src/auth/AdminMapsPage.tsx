import { useEffect, useState } from "react";
import { readApiJson } from "../editor/apiJson.js";
import { navigate } from "../useRoute.js";
import { compareMapNames } from "../mapList.js";

interface AdminMap {
  id: string;
  slug: string;
  name: string;
  /** Milestone 85. */
  kind?: "map" | "module";
  usedBy?: string[];
  description: string | null;
  visibility: "public" | "restricted";
  groupIds: string[];
  region: { id: string; name: string } | null;
  publishedVersion: number | null;
  publishedAt: string | null;
  hasUnpublishedChanges: boolean;
}

interface Region {
  id: string;
  name: string;
  sortOrder: number;
  mapCount: number;
}

interface Group {
  id: string;
  name: string;
}

interface ErrorBody {
  error?: { message?: string };
}

async function extractError(response: Response, fallback: string): Promise<string> {
  const body = await readApiJson<ErrorBody>(response);
  return body.error?.message ?? fallback;
}

async function sendJson(url: string, method: string, body?: unknown): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return fetch(url, init);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "Everyone", "Admins only", or the group names a restricted map is shared with. */
export function visibilitySummary(
  map: Pick<AdminMap, "visibility" | "groupIds">,
  groups: Group[],
): string {
  if (map.visibility === "public") return "Everyone";
  const names = map.groupIds
    .map((id) => groups.find((group) => group.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  return names.length === 0 ? "Admins only" : `Admins + ${names.join(", ")}`;
}

/**
 * Milestone 83 (docs/adr/0018): Admin › Maps — create maps, change each map's name, address,
 * description, region and who can see it, delete maps, keep the region list, and choose whether
 * the public map list is grouped by region. Only rendered for admins; the API enforces the same.
 */
export function AdminMapsPage(): JSX.Element {
  const [maps, setMaps] = useState<AdminMap[] | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [regionGrouping, setRegionGrouping] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [confirmDeleteSlug, setConfirmDeleteSlug] = useState<string | null>(null);

  // Milestone 85: maps and modules are listed separately.
  const [tab, setTab] = useState<"map" | "module">("map");
  const [republishing, setRepublishing] = useState(false);
  const [republished, setRepublished] = useState<Array<{
    slug: string;
    ok: boolean;
    versionNumber?: number;
    errors?: { message: string }[];
  }> | null>(null);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [creating, setCreating] = useState(false);

  const [newRegion, setNewRegion] = useState("");
  const [renamingRegionId, setRenamingRegionId] = useState<string | null>(null);
  const [regionName, setRegionName] = useState("");

  async function load(): Promise<void> {
    try {
      const [mapsRes, regionsRes, groupsRes, settingsRes] = await Promise.all([
        fetch("/api/v1/editor/maps"),
        fetch("/api/v1/admin/regions"),
        fetch("/api/v1/admin/groups"),
        fetch("/api/v1/admin/settings"),
      ]);
      for (const response of [mapsRes, regionsRes, groupsRes, settingsRes]) {
        if (!response.ok) {
          setLoadError(await extractError(response, `Failed to load (${response.status})`));
          return;
        }
      }
      setMaps((await readApiJson<{ maps: AdminMap[] }>(mapsRes)).maps.sort(compareMapNames));
      setRegions((await readApiJson<{ regions: Region[] }>(regionsRes)).regions);
      setGroups((await readApiJson<{ groups: Group[] }>(groupsRes)).groups);
      const settings = (
        await readApiJson<{ settings: { map_list_region_grouping: boolean } }>(settingsRes)
      ).settings;
      setRegionGrouping(settings.map_list_region_grouping);
      setLoadError(null);
    } catch {
      setLoadError("Failed to load maps.");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function act(response: Promise<Response>, fallback: string): Promise<boolean> {
    setActionError(null);
    const result = await response;
    if (!result.ok && result.status !== 204) {
      setActionError(await extractError(result, fallback));
      return false;
    }
    await load();
    return true;
  }

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setCreating(true);
    try {
      const response = await sendJson("/api/v1/editor/maps", "POST", {
        slug: newSlug,
        name: newName,
        kind: tab,
      });
      if (!response.ok) {
        setActionError(await extractError(response, "Failed to create map."));
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
  if (!maps) return <p className="app-loading">Loading maps…</p>;
  const shown = maps.filter((map) => (map.kind ?? "map") === tab);
  const moduleCount = maps.filter((map) => map.kind === "module").length;

  async function republishAll(): Promise<void> {
    if (
      !window.confirm(
        "Republish every published map from what it last published? Maps made from modules " +
          "pick up each module's latest published version. Drafts are not touched.",
      )
    ) {
      return;
    }
    setRepublishing(true);
    setActionError(null);
    try {
      const response = await sendJson("/api/v1/admin/maps/republish-all", "POST");
      if (!response.ok) {
        setActionError(await extractError(response, "Failed to republish."));
        return;
      }
      setRepublished((await readApiJson<{ maps: NonNullable<typeof republished> }>(response)).maps);
      await load();
    } finally {
      setRepublishing(false);
    }
  }

  return (
    <div className="admin-users-page admin-maps-page">
      <h2>Maps</h2>
      {actionError && (
        <p role="alert" className="login-form__error">
          {actionError}
        </p>
      )}

      <section className="panel-card">
        <h3>Public map list</h3>
        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={regionGrouping}
            onChange={(e) =>
              void act(
                sendJson("/api/v1/admin/settings", "PATCH", {
                  map_list_region_grouping: e.target.checked,
                }),
                "Failed to change the setting.",
              )
            }
          />
          Group maps by region (visitors can still switch to A–Z)
        </label>
        <p className="field-hint">When off, the list is A–Z only.</p>
      </section>

      <div className="btn-group" role="tablist" aria-label="Maps or modules">
        <button
          type="button"
          role="tab"
          className="btn"
          aria-selected={tab === "map"}
          aria-pressed={tab === "map"}
          onClick={() => setTab("map")}
        >
          Maps ({maps.length - moduleCount})
        </button>
        <button
          type="button"
          role="tab"
          className="btn"
          aria-selected={tab === "module"}
          aria-pressed={tab === "module"}
          onClick={() => setTab("module")}
        >
          Modules ({moduleCount})
        </button>
      </div>
      {tab === "module" ? (
        <p className="field-hint">
          A module is drawn once and used in any number of maps; it never appears on its own.
          Publishing a module republishes every map made from it.
        </p>
      ) : null}

      <ul className="admin-map-list">
        {shown.length === 0 ? (
          <li className="panel-card panel-card--empty">
            {tab === "module" ? "No modules yet." : "No maps yet."}
          </li>
        ) : null}
        {shown.map((map) => (
          <li key={map.slug} className="admin-map-row">
            <div className="admin-map-row__head">
              <div className="admin-map-row__title">
                <strong>{map.name}</strong>
                <span className="admin-map-row__slug">/{map.slug}</span>
              </div>
              <div className="admin-map-row__actions">
                <a
                  className="btn"
                  href={`/editor/${encodeURIComponent(map.slug)}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(`/editor/${encodeURIComponent(map.slug)}`);
                  }}
                >
                  Open editor
                </a>
                <button
                  type="button"
                  className="btn"
                  aria-expanded={editingSlug === map.slug}
                  onClick={() => setEditingSlug(editingSlug === map.slug ? null : map.slug)}
                >
                  Settings
                </button>
                {confirmDeleteSlug === map.slug ? (
                  <>
                    <button
                      type="button"
                      className="btn btn--danger"
                      onClick={() =>
                        void act(
                          sendJson(`/api/v1/editor/maps/${encodeURIComponent(map.slug)}`, "DELETE"),
                          "Failed to delete map.",
                        ).then(() => setConfirmDeleteSlug(null))
                      }
                    >
                      Confirm delete
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setConfirmDeleteSlug(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setConfirmDeleteSlug(map.slug)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
            <dl className="admin-map-row__facts">
              <div>
                <dt>Status</dt>
                <dd>
                  {map.publishedVersion === null
                    ? "Never published"
                    : `Published v${map.publishedVersion}${map.hasUnpublishedChanges ? " · unpublished changes" : ""}`}
                </dd>
              </div>
              {map.kind === "module" ? (
                <div>
                  <dt>Used by</dt>
                  <dd>
                    {map.usedBy && map.usedBy.length > 0 ? map.usedBy.join(", ") : "No maps yet"}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Visible to</dt>
                <dd>{visibilitySummary(map, groups)}</dd>
              </div>
              <div>
                <dt>Region</dt>
                <dd>{map.region?.name ?? "None"}</dd>
              </div>
            </dl>
            {editingSlug === map.slug && (
              <MapSettingsForm
                map={map}
                regions={regions}
                groups={groups}
                onCancel={() => setEditingSlug(null)}
                onSave={async (body) => {
                  if (
                    await act(
                      sendJson(
                        `/api/v1/editor/maps/${encodeURIComponent(map.slug)}`,
                        "PATCH",
                        body,
                      ),
                      "Failed to save map settings.",
                    )
                  ) {
                    setEditingSlug(null);
                  }
                }}
              />
            )}
          </li>
        ))}
      </ul>

      <form className="panel-card" onSubmit={(e) => void handleCreate(e)}>
        <h3>{tab === "module" ? "New module" : "New map"}</h3>
        <label className="field">
          Name
          <input
            type="text"
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              if (!slugEdited) setNewSlug(slugify(e.target.value));
            }}
            required
          />
        </label>
        <label className="field">
          Address (slug)
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
          {creating ? "Creating…" : tab === "module" ? "Create module" : "Create map"}
        </button>
      </form>

      <section className="panel-card">
        <h3>Republish all maps</h3>
        <p className="field-hint">
          Normally not needed — publishing a module republishes the maps made from it. Use this
          after a change to how maps are drawn, so every published map is rebuilt.
        </p>
        <button
          type="button"
          className="btn"
          disabled={republishing}
          onClick={() => void republishAll()}
        >
          {republishing ? "Republishing…" : "Republish all maps"}
        </button>
        {republished ? (
          <ul className="cascade-list">
            {republished.map((map) => (
              <li key={map.slug} className={map.ok ? "" : "cascade-list__failed"}>
                <strong>{map.slug}</strong>{" "}
                {map.ok
                  ? `— now version ${map.versionNumber}`
                  : `— not republished: ${(map.errors ?? []).map((e) => e.message).join("; ")}`}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="panel-card">
        <h3>Regions</h3>
        <p className="field-hint">
          The order here is the order of the groups on the public map list. Deleting a region moves
          its maps to “Other”.
        </p>
        {regions.length === 0 ? (
          <p className="field-hint">No regions yet.</p>
        ) : (
          <ol className="region-list">
            {regions.map((region, index) => (
              <li key={region.id} className="region-list__row">
                {renamingRegionId === region.id ? (
                  <form
                    className="region-list__rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(
                        sendJson(`/api/v1/admin/regions/${region.id}`, "PATCH", {
                          name: regionName,
                        }),
                        "Failed to rename region.",
                      ).then((ok) => ok && setRenamingRegionId(null));
                    }}
                  >
                    <input
                      type="text"
                      aria-label="Region name"
                      value={regionName}
                      onChange={(e) => setRegionName(e.target.value)}
                      required
                    />
                    <button type="submit" className="btn btn--primary">
                      Save
                    </button>
                    <button type="button" className="btn" onClick={() => setRenamingRegionId(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="region-list__name">{region.name}</span>
                    <span className="region-list__count">
                      {region.mapCount} {region.mapCount === 1 ? "map" : "maps"}
                    </span>
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Move ${region.name} up`}
                      disabled={index === 0}
                      onClick={() => void reorder(index, index - 1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Move ${region.name} down`}
                      disabled={index === regions.length - 1}
                      onClick={() => void reorder(index, index + 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setRenamingRegionId(region.id);
                        setRegionName(region.name);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        if (window.confirm(`Delete the region "${region.name}"?`)) {
                          void act(
                            sendJson(`/api/v1/admin/regions/${region.id}`, "DELETE"),
                            "Failed to delete region.",
                          );
                        }
                      }}
                    >
                      Delete
                    </button>
                  </>
                )}
              </li>
            ))}
          </ol>
        )}
        <form
          className="region-list__add"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              sendJson("/api/v1/admin/regions", "POST", { name: newRegion }),
              "Failed to add region.",
            ).then((ok) => ok && setNewRegion(""));
          }}
        >
          <label className="field">
            New region
            <input
              type="text"
              value={newRegion}
              onChange={(e) => setNewRegion(e.target.value)}
              placeholder="e.g. North West"
              required
            />
          </label>
          <button type="submit" className="btn btn--primary">
            Add region
          </button>
        </form>
      </section>
    </div>
  );

  async function reorder(from: number, to: number): Promise<void> {
    const ids = regions.map((region) => region.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved!);
    await act(
      sendJson("/api/v1/admin/regions/order", "PUT", { ids }),
      "Failed to reorder regions.",
    );
  }
}

interface MapSettingsBody {
  name: string;
  slug: string;
  description: string | null;
  regionId: string | null;
  visibility: "public" | "restricted";
  groupIds: string[];
}

function MapSettingsForm({
  map,
  regions,
  groups,
  onSave,
  onCancel,
}: {
  map: AdminMap;
  regions: Region[];
  groups: Group[];
  onSave: (body: MapSettingsBody) => Promise<void>;
  onCancel: () => void;
}): JSX.Element {
  const [name, setName] = useState(map.name);
  const [slug, setSlug] = useState(map.slug);
  const [description, setDescription] = useState(map.description ?? "");
  const [regionId, setRegionId] = useState(map.region?.id ?? "");
  const [visibility, setVisibility] = useState(map.visibility);
  const [groupIds, setGroupIds] = useState<string[]>(map.groupIds);
  const [saving, setSaving] = useState(false);

  return (
    <form
      className="admin-map-settings"
      onSubmit={(e) => {
        e.preventDefault();
        setSaving(true);
        void onSave({
          name,
          slug,
          description: description.trim() ? description.trim() : null,
          regionId: regionId || null,
          visibility,
          groupIds: visibility === "restricted" ? groupIds : [],
        }).finally(() => setSaving(false));
      }}
    >
      <label className="field">
        Name
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="field">
        Address (slug)
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          required
        />
      </label>
      <label className="field">
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={280}
          rows={2}
        />
      </label>
      <label className="field">
        Region
        <select value={regionId} onChange={(e) => setRegionId(e.target.value)}>
          <option value="">None (“Other”)</option>
          {regions.map((region) => (
            <option key={region.id} value={region.id}>
              {region.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="admin-map-settings__visibility">
        <legend>Who can see this map</legend>
        <label className="field field--checkbox">
          <input
            type="radio"
            name={`visibility-${map.slug}`}
            checked={visibility === "public"}
            onChange={() => setVisibility("public")}
          />
          Everyone
        </label>
        <label className="field field--checkbox">
          <input
            type="radio"
            name={`visibility-${map.slug}`}
            checked={visibility === "restricted"}
            onChange={() => setVisibility("restricted")}
          />
          Only these groups
        </label>
        {visibility === "restricted" && (
          <div className="admin-map-settings__groups">
            {groups.length === 0 && <p className="field-hint">No groups yet (Admin › Users).</p>}
            {groups.map((group) => (
              <label key={group.id} className="field field--checkbox">
                <input
                  type="checkbox"
                  checked={groupIds.includes(group.id)}
                  onChange={(e) =>
                    setGroupIds((current) =>
                      e.target.checked
                        ? [...current, group.id]
                        : current.filter((id) => id !== group.id),
                    )
                  }
                />
                {group.name}
              </label>
            ))}
            <p className="field-hint">
              Admins always see every map. With no group ticked, only admins can see it.
            </p>
          </div>
        )}
      </fieldset>
      <div className="admin-map-settings__buttons">
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
