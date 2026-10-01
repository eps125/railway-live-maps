import { describe, expect, it } from "vitest";
import { filterMaps, groupMaps, type MapListEntry } from "./mapList.js";

function entry(name: string, region: MapListEntry["region"] = null): MapListEntry {
  return {
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    description: null,
    visibility: "public",
    region,
    publishedAt: null,
    mapVersion: 1,
    liveDataStatus: "ok",
  };
}

const A = { id: "1", name: "Scotland", sortOrder: 30 };
const B = { id: "2", name: "North West", sortOrder: 10 };

describe("groupMaps", () => {
  it("sorts A–Z case-insensitively and numerically", () => {
    const groups = groupMaps(
      [entry("carlisle"), entry("Map 10"), entry("Map 2"), entry("Bay")],
      "az",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.title).toBeNull();
    expect(groups[0]!.maps.map((m) => m.name)).toEqual(["Bay", "carlisle", "Map 2", "Map 10"]);
  });

  it("orders regions by their sort order, puts region-less maps last as Other", () => {
    const groups = groupMaps(
      [entry("Glasgow", A), entry("Zed"), entry("Preston", B), entry("Carlisle", B)],
      "region",
    );
    expect(groups.map((g) => g.title)).toEqual(["North West", "Scotland", "Other"]);
    expect(groups[0]!.maps.map((m) => m.name)).toEqual(["Carlisle", "Preston"]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupMaps([], "az")).toEqual([]);
    expect(groupMaps([], "region")).toEqual([]);
  });
});

describe("filterMaps", () => {
  it("matches name, description and region name, ignoring case", () => {
    const maps = [{ ...entry("Carlisle", B), description: "Border city" }, entry("Glasgow", A)];
    expect(filterMaps(maps, "BORDER").map((m) => m.name)).toEqual(["Carlisle"]);
    expect(filterMaps(maps, "scot").map((m) => m.name)).toEqual(["Glasgow"]);
    expect(filterMaps(maps, "  ")).toHaveLength(2);
  });
});
