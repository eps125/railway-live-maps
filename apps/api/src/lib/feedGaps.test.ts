import { describe, expect, it } from "vitest";
import { qualityForViewer } from "./feedGaps.js";

const quality = {
  status: "stale" as const,
  gaps: [
    "TD feed gap 2026-10-08T02:53:02.769Z–2026-10-08T02:59:15.021Z (unknown; td_receive_silence)",
  ],
  incomplete: true,
};

describe("qualityForViewer (owner, 2026-10-10: outage details are admin-only)", () => {
  it("gives an admin the full list", () => {
    expect(qualityForViewer(quality, { user: { role: "admin" } })).toEqual(quality);
  });

  it.each([
    ["a guest", null],
    ["an access-code viewer", { user: null }],
    ["an editor", { user: { role: "editor" } }],
    ["a viewer account", { user: { role: "viewer" } }],
  ])("gives %s only the status and the incomplete flag", (_who, viewer) => {
    expect(qualityForViewer(quality, viewer)).toEqual({
      status: "stale",
      gaps: [],
      incomplete: true,
    });
  });
});
