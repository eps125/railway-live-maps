import { describe, expect, it } from "vitest";
import { qualityForViewer } from "./feedGaps.js";

const quality = {
  status: "stale" as const,
  gaps: [
    "TD feed gap 2026-10-08T02:53:02.769Z–2026-10-08T02:59:15.021Z (unknown; td_receive_silence)",
  ],
  incomplete: true,
};

describe("qualityForViewer (owner, 2026-10-10; Milestone 99: map.feed_gap_details)", () => {
  it("gives a viewer with map.feed_gap_details the full list", () => {
    expect(qualityForViewer(quality, { permissions: new Set(["map.feed_gap_details"]) })).toEqual(
      quality,
    );
  });

  it.each([
    ["a guest", null],
    ["a viewer with no permissions", { permissions: new Set<string>() }],
    ["an editor without it", { permissions: new Set(["editor.view", "maps.edit"]) }],
  ])("gives %s only the status and the incomplete flag", (_who, viewer) => {
    expect(qualityForViewer(quality, viewer)).toEqual({
      status: "stale",
      gaps: [],
      incomplete: true,
    });
  });
});
