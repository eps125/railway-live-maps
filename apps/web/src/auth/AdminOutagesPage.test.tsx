import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminOutagesPage,
  formatDuration,
  newestGapId,
  type OutageView,
} from "./AdminOutagesPage.js";
import { OUTAGES_SEEN_EVENT, outagePillCount } from "./useOutageSummary.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function outage(overrides: Partial<OutageView>): OutageView {
  return {
    id: "12",
    feed: "TD",
    tdArea: null,
    start: "2026-10-29T11:08:28.693Z",
    end: "2026-10-29T11:20:48.398Z",
    durationSeconds: 740,
    reason: "td_receive_silence",
    recoverability: "unrecoverable",
    note: "auth: nothing for this period was ever received",
    recordedAt: "2026-10-29T11:21:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("formatDuration", () => {
  it("reads naturally at each scale", () => {
    expect(formatDuration(48)).toBe("48 s");
    expect(formatDuration(740)).toBe("12 min 20 s");
    expect(formatDuration(3900)).toBe("1 h 05 min");
    expect(formatDuration(null)).toBe("ongoing");
  });
});

describe("newestGapId", () => {
  it("compares ids as numbers, not strings", () => {
    expect(newestGapId([outage({ id: "9" }), outage({ id: "12" })])).toBe("12");
    expect(newestGapId([])).toBeNull();
  });
});

describe("outagePillCount", () => {
  it("adds one for an outage happening now", () => {
    expect(outagePillCount(null)).toBe(0);
    expect(outagePillCount({ unseen: 2, ongoing: false })).toBe(2);
    expect(outagePillCount({ unseen: 0, ongoing: true })).toBe(1);
  });
});

describe("AdminOutagesPage", () => {
  it("lists outages, flags the unseen ones and marks them seen", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/v1/admin/outages?")) {
        return jsonResponse({
          days: 30,
          outages: [outage({}), outage({ id: "11", recoverability: "recoverable", note: null })],
          liveTd: { lastFrameAt: "2026-10-30T18:00:00.000Z", silentForSeconds: 2, ongoing: false },
          seenThroughGapId: "11",
        });
      }
      if (url === "/api/v1/admin/outages/seen" && init?.method === "POST") {
        return { ok: true, status: 204 } as Response;
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const seen = vi.fn();
    window.addEventListener(OUTAGES_SEEN_EVENT, seen);

    render(<AdminOutagesPage />);

    expect(await screen.findAllByText("12 min 20 s")).toHaveLength(2);
    expect(screen.getByText("Lost — never sent")).toBeTruthy();
    expect(screen.getByText("Recovered — arrived late")).toBeTruthy();
    expect(screen.getAllByText("New")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toMatch(/receiving normally/);

    await waitFor(() => expect(seen).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([url]) => url === "/api/v1/admin/outages/seen");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ throughGapId: "12" });
    window.removeEventListener(OUTAGES_SEEN_EVENT, seen);
  });

  it("says when TD is down right now, and posts nothing when all is seen", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        days: 30,
        outages: [outage({})],
        liveTd: { lastFrameAt: "2026-10-30T17:50:00.000Z", silentForSeconds: 600, ongoing: true },
        seenThroughGapId: "12",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminOutagesPage />);

    expect((await screen.findByRole("status")).textContent).toMatch(
      /TD outage now: nothing received for 10 min 00 s/,
    );
    expect(screen.queryByText("New")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
