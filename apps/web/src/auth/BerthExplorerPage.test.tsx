import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BerthExplorerPage } from "./BerthExplorerPage.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const berths = {
  tdArea: "M9",
  days: 7,
  sinceDate: "2026-09-19",
  coverageFromDate: "2026-08-07",
  berths: [
    {
      berth: "3879",
      eventsIn: 12,
      eventsOut: 11,
      activeDays: 7,
      firstSeenAt: "2026-09-19T05:00:00.000Z",
      lastSeenAt: "2026-09-25T17:05:09.000Z",
      lastSeenEverAt: null,
      allocations: [
        {
          kind: "published",
          mapSlug: "m9",
          mapName: "M9 test",
          elementId: "e1",
          displayName: null,
          combinedOrder: 1,
          combinedMembers: [
            { tdArea: "M9", berth: "3879" },
            { tdArea: "M9", berth: "3881" },
          ],
        },
      ],
    },
    {
      berth: "9878",
      eventsIn: 1,
      eventsOut: 0,
      activeDays: 1,
      firstSeenAt: "2026-09-20T10:00:00.000Z",
      lastSeenAt: "2026-09-20T10:00:00.000Z",
      lastSeenEverAt: null,
      allocations: [],
    },
    {
      berth: "0001",
      eventsIn: 0,
      eventsOut: 0,
      activeDays: 0,
      firstSeenAt: null,
      lastSeenAt: null,
      lastSeenEverAt: null,
      allocations: [
        {
          kind: "draft",
          mapSlug: "m9",
          mapName: "M9 test",
          elementId: "d1",
          displayName: "Siding",
          combinedOrder: null,
          combinedMembers: null,
        },
      ],
    },
  ],
};

function stubApi(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string) => {
    if (url === "/api/v1/admin/berth-explorer/areas") {
      return Promise.resolve(jsonResponse({ areas: [{ tdArea: "M9", lastEventAt: null }] }));
    }
    if (url.startsWith("/api/v1/admin/berth-explorer/areas/M9/berths?")) {
      return Promise.resolve(jsonResponse(berths));
    }
    if (url.includes("/berths/3879/steps")) {
      return Promise.resolve(
        jsonResponse(
          url.includes("before=")
            ? {
                steps: [
                  {
                    id: "5",
                    eventAt: "2026-09-24T08:00:00.000Z",
                    description: "2F11",
                    messageType: "CC",
                    fromBerth: null,
                    toBerth: "3879",
                  },
                ],
                next: null,
              }
            : {
                steps: [
                  {
                    id: "9",
                    eventAt: "2026-09-25T17:05:09.000Z",
                    description: "2F19",
                    messageType: "CA",
                    fromBerth: "3879",
                    toBerth: "3881",
                  },
                ],
                next: { before: "2026-09-25T17:05:09.000Z", beforeId: "9" },
              },
        ),
      );
    }
    return Promise.resolve(jsonResponse({ error: { message: "unexpected" } }, 404));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("BerthExplorerPage (Milestone 72)", () => {
  it("lists the area's berths with their map allocations, and filters them", async () => {
    const fetchMock = stubApi();
    render(<BerthExplorerPage />);
    await screen.findByRole("option", { name: "M9" });
    fireEvent.change(screen.getByLabelText("TD area"), { target: { value: "M9" } });

    const table = await screen.findByRole("table", { name: "M9 berths" });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/admin/berth-explorer/areas/M9/berths?days=7");
    expect(table).toHaveTextContent("M9 test (published) · combined: 3879 + 3881");
    expect(table).toHaveTextContent("not on a map");
    expect(table).toHaveTextContent("M9 test (draft) — Siding");
    expect(table).toHaveTextContent("never seen");
    expect(screen.getByText(/2 berths seen in M9 since 2026-09-19/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "unallocated" } });
    expect(within(table).getAllByRole("row")).toHaveLength(2); // header + 9878
    expect(table).toHaveTextContent("9878");

    fireEvent.change(screen.getByLabelText("Show"), { target: { value: "unseen" } });
    expect(table).toHaveTextContent("0001");
    expect(table).not.toHaveTextContent("9878");

    fireEvent.change(screen.getByLabelText("Window"), { target: { value: "90" } });
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/admin/berth-explorer/areas/M9/berths?days=90",
      ),
    );
  });

  it("shows a berth's latest steps in UK time when clicked, and loads more", async () => {
    stubApi();
    render(<BerthExplorerPage />);
    await screen.findByRole("option", { name: "M9" });
    fireEvent.change(screen.getByLabelText("TD area"), { target: { value: "M9" } });
    await screen.findByRole("table", { name: "M9 berths" });

    fireEvent.click(screen.getByRole("button", { name: "3879" }));
    const steps = await screen.findByRole("table", { name: "Steps at 3879" });
    // 17:05:09 UTC is 18:05:09 in the UK in September (BST).
    expect(steps).toHaveTextContent("18:05:09");
    expect(steps).toHaveTextContent("Step");

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await vi.waitFor(() => expect(steps).toHaveTextContent("2F11"));
    expect(steps).toHaveTextContent("Interpose");
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });
});
