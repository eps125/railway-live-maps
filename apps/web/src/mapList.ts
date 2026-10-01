/**
 * Milestone 83 (docs/adr/0018): how the landing page orders and groups the map list. Pure, so the
 * ordering rules are tested without rendering.
 */

export interface MapListRegion {
  id: string;
  name: string;
  sortOrder: number;
}

export interface MapListEntry {
  slug: string;
  name: string;
  description: string | null;
  visibility: "public" | "restricted";
  region: MapListRegion | null;
  publishedAt: string | null;
  mapVersion: number;
  liveDataStatus: "ok" | "stale" | "unknown";
}

export type MapListSort = "region" | "az";

export interface MapListGroup {
  /** Region id, `other`, or `all` for the A–Z list. */
  key: string;
  /** Heading; null for the A–Z list (no heading). */
  title: string | null;
  maps: MapListEntry[];
}

const collator = new Intl.Collator("en-GB", { sensitivity: "base", numeric: true });

export function compareMapNames(
  a: { name: string; slug: string },
  b: { name: string; slug: string },
): number {
  return collator.compare(a.name, b.name) || collator.compare(a.slug, b.slug);
}

/** Case-insensitive match on name, description or region name. */
export function filterMaps(maps: MapListEntry[], query: string): MapListEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return maps;
  return maps.filter((map) =>
    [map.name, map.description ?? "", map.region?.name ?? ""].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  );
}

/**
 * `az`: one unheaded group, every map by name. `region`: one group per region in the admin's
 * region order (ties by name), then "Other" for maps with no region; maps by name within each;
 * empty groups are left out.
 */
export function groupMaps(maps: MapListEntry[], sort: MapListSort): MapListGroup[] {
  const sorted = [...maps].sort(compareMapNames);
  if (sort === "az") return sorted.length > 0 ? [{ key: "all", title: null, maps: sorted }] : [];

  const regions = new Map<string, { region: MapListRegion; maps: MapListEntry[] }>();
  const other: MapListEntry[] = [];
  for (const map of sorted) {
    if (!map.region) {
      other.push(map);
      continue;
    }
    const entry = regions.get(map.region.id) ?? { region: map.region, maps: [] };
    entry.maps.push(map);
    regions.set(map.region.id, entry);
  }
  const groups: MapListGroup[] = [...regions.values()]
    .sort(
      (a, b) =>
        a.region.sortOrder - b.region.sortOrder || collator.compare(a.region.name, b.region.name),
    )
    .map(({ region, maps: regionMaps }) => ({
      key: region.id,
      title: region.name,
      maps: regionMaps,
    }));
  if (other.length > 0) groups.push({ key: "other", title: "Other", maps: other });
  return groups;
}

const SORT_STORAGE_KEY = "rlm.mapListSort";

/** The visitor's last choice when grouping is available; `region` by default. Storage can be
 * unavailable (private window, blocked site data) — that just means the default. */
export function loadMapListSort(): MapListSort {
  try {
    return window.localStorage.getItem(SORT_STORAGE_KEY) === "az" ? "az" : "region";
  } catch {
    return "region";
  }
}

export function saveMapListSort(sort: MapListSort): void {
  try {
    window.localStorage.setItem(SORT_STORAGE_KEY, sort);
  } catch {
    // Not remembered — harmless.
  }
}
