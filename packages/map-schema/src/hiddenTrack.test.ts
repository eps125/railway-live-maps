import { describe, expect, it } from "vitest";
import type { TrackPathElement } from "./document.js";
import { hiddenTracks, visibleRouteRuns } from "./hiddenTrack.js";

const track = (id: string, pts: Array<[number, number]>, hidden?: boolean): TrackPathElement => ({
  id,
  layerId: "track",
  zIndex: 0,
  type: "trackPath",
  points: pts.map(([x, y]) => ({ x, y })),
  ...(hidden ? { hidden } : {}),
});
const pts = (list: Array<[number, number]>) => list.map(([x, y]) => ({ x, y }));

describe("visibleRouteRuns (hidden track under a flyover)", () => {
  it("leaves a route whole when no hidden track is in the way", () => {
    const route = pts([
      [0, 0],
      [100, 0],
    ]);
    expect(visibleRouteRuns(route, [])).toEqual([route]);
    expect(
      visibleRouteRuns(route, [
        track(
          "h",
          [
            [0, 30],
            [100, 30],
          ],
          true,
        ),
      ]),
    ).toEqual([route]);
  });

  it("splits a route where it runs along a hidden track, drawing both sides", () => {
    // 0495 -> 0493 along y = 657, passing under the flyover between x = 955 and 1017.
    const route = pts([
      [1050, 657],
      [800, 657],
    ]);
    const under = track(
      "under",
      [
        [955, 657],
        [1017, 657],
      ],
      true,
    );
    expect(visibleRouteRuns(route, [under])).toEqual([
      pts([
        [1050, 657],
        [1017, 657],
      ]),
      pts([
        [955, 657],
        [800, 657],
      ]),
    ]);
  });

  it("hides whole segments and keeps bends either side joined", () => {
    const route = pts([
      [0, 0],
      [50, 0],
      [100, 50],
      [150, 50],
      [200, 50],
    ]);
    const under = track(
      "under",
      [
        [100, 50],
        [150, 50],
      ],
      true,
    );
    expect(visibleRouteRuns(route, [under])).toEqual([
      pts([
        [0, 0],
        [50, 0],
        [100, 50],
      ]),
      pts([
        [150, 50],
        [200, 50],
      ]),
    ]);
  });

  it("ignores a hidden track that only crosses the route", () => {
    const route = pts([
      [0, 0],
      [100, 0],
    ]);
    const crossing = track(
      "x",
      [
        [50, -20],
        [50, 20],
      ],
      true,
    );
    expect(visibleRouteRuns(route, [crossing])).toEqual([route]);
  });

  it("finds only the tracks marked hidden", () => {
    const visible = track("v", [
      [0, 0],
      [1, 0],
    ]);
    const hidden = track(
      "h",
      [
        [0, 0],
        [1, 0],
      ],
      true,
    );
    expect(hiddenTracks([visible, hidden]).map((t) => t.id)).toEqual(["h"]);
  });
});
