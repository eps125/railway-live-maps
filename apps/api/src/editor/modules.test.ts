import { describe, expect, it } from "vitest";
import { moduleChangeStatus } from "./modules.js";
import { parsePublishModules } from "../routes/editor/publish.js";

/** Milestone 96 (docs/adr/0019 amendment): what publishing an assembled map offers to publish. */
describe("moduleChangeStatus", () => {
  const doc = { elements: [{ id: "up" }] };

  it("is missing for no module, or one with neither a draft nor a version", () => {
    expect(moduleChangeStatus({ exists: false, draft: doc, published: doc })).toBe("missing");
    expect(moduleChangeStatus({ exists: true, draft: null, published: null })).toBe("missing");
  });

  it("is never_published for a draft with no published version", () => {
    expect(moduleChangeStatus({ exists: true, draft: doc, published: null })).toBe(
      "never_published",
    );
  });

  it("compares the draft with the latest published version", () => {
    expect(moduleChangeStatus({ exists: true, draft: doc, published: { ...doc } })).toBe(
      "unchanged",
    );
    expect(moduleChangeStatus({ exists: true, draft: { elements: [] }, published: doc })).toBe(
      "changed",
    );
  });

  it("is unchanged for a published module with no draft row", () => {
    expect(moduleChangeStatus({ exists: true, draft: null, published: doc })).toBe("unchanged");
  });
});

describe("parsePublishModules", () => {
  it("treats a missing list as the map only", () => {
    expect(parsePublishModules(undefined)).toEqual([]);
    expect(parsePublishModules(null)).toEqual([]);
  });

  it("accepts distinct slugs with revisions", () => {
    expect(
      parsePublishModules([
        { slug: "a", expectedRevision: 3 },
        { slug: "b", expectedRevision: 1 },
      ]),
    ).toEqual([
      { slug: "a", expectedRevision: 3 },
      { slug: "b", expectedRevision: 1 },
    ]);
  });

  it("rejects malformed entries and duplicates", () => {
    expect(parsePublishModules("a")).toBeNull();
    expect(parsePublishModules([{ slug: "a" }])).toBeNull();
    expect(parsePublishModules([{ slug: 1, expectedRevision: 1 }])).toBeNull();
    expect(parsePublishModules([null])).toBeNull();
    expect(
      parsePublishModules([
        { slug: "a", expectedRevision: 1 },
        { slug: "a", expectedRevision: 2 },
      ]),
    ).toBeNull();
  });
});
