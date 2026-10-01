import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminMapsPage, visibilitySummary } from "./AdminMapsPage.js";

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
  window.history.pushState(null, "", "/");
});

const GROUPS = [
  { id: "1", name: "Editors" },
  { id: "2", name: "Signallers" },
];

const MAPS = [
  {
    id: "10",
    slug: "lancaster",
    name: "Lancaster",
    description: null,
    visibility: "public",
    groupIds: [],
    region: null,
    publishedVersion: 3,
    publishedAt: "2026-09-30T12:00:00Z",
    hasUnpublishedChanges: true,
  },
  {
    id: "11",
    slug: "new-map",
    name: "New Map",
    description: null,
    visibility: "restricted",
    groupIds: [],
    region: null,
    publishedVersion: null,
    publishedAt: null,
    hasUnpublishedChanges: true,
  },
];

function stubAdminFetch(extra?: (url: string, init?: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const handled = extra?.(url, init);
    if (handled) return Promise.resolve(handled);
    if (url === "/api/v1/editor/maps" && !init?.method)
      return Promise.resolve(jsonResponse({ maps: MAPS }));
    if (url === "/api/v1/admin/regions" && !init?.method) {
      return Promise.resolve(
        jsonResponse({ regions: [{ id: "5", name: "North West", sortOrder: 10, mapCount: 0 }] }),
      );
    }
    if (url === "/api/v1/admin/groups") return Promise.resolve(jsonResponse({ groups: GROUPS }));
    if (url === "/api/v1/admin/settings" && !init?.method) {
      return Promise.resolve(jsonResponse({ settings: { map_list_region_grouping: false } }));
    }
    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("visibilitySummary", () => {
  it("names who can see a map", () => {
    expect(visibilitySummary({ visibility: "public", groupIds: [] }, GROUPS)).toBe("Everyone");
    expect(visibilitySummary({ visibility: "restricted", groupIds: [] }, GROUPS)).toBe(
      "Admins only",
    );
    expect(visibilitySummary({ visibility: "restricted", groupIds: ["2"] }, GROUPS)).toBe(
      "Admins + Signallers",
    );
  });
});

describe("AdminMapsPage", () => {
  it("shows each map's status and who can see it", async () => {
    stubAdminFetch();
    render(<AdminMapsPage />);

    expect(await screen.findByText("Published v3 · unpublished changes")).toBeInTheDocument();
    expect(screen.getByText("Never published")).toBeInTheDocument();
    expect(screen.getByText("Everyone")).toBeInTheDocument();
    expect(screen.getByText("Admins only")).toBeInTheDocument();
  });

  it("restricts a public map to a group, sending the full settings", async () => {
    const fetchMock = stubAdminFetch((url, init) =>
      url === "/api/v1/editor/maps/lancaster" && init?.method === "PATCH"
        ? jsonResponse({ slug: "lancaster" })
        : undefined,
    );
    const { container } = render(<AdminMapsPage />);
    await screen.findByText("Lancaster");

    fireEvent.click(screen.getAllByRole("button", { name: "Settings" })[0]!);
    const form = within(container.querySelector<HTMLElement>(".admin-map-settings")!);
    fireEvent.change(form.getByLabelText("Description"), { target: { value: " The PSB area " } });
    fireEvent.change(form.getByLabelText("Region"), { target: { value: "5" } });
    fireEvent.click(form.getByLabelText("Only these groups"));
    fireEvent.click(form.getByLabelText("Signallers"));
    fireEvent.click(form.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
        ),
      ).toBe(true),
    );
    const patch = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    )!;
    expect(JSON.parse((patch[1] as RequestInit).body as string)).toEqual({
      name: "Lancaster",
      slug: "lancaster",
      description: "The PSB area",
      regionId: "5",
      visibility: "restricted",
      groupIds: ["2"],
    });
  });

  it("turns region grouping on for the public list", async () => {
    const fetchMock = stubAdminFetch((url, init) =>
      url === "/api/v1/admin/settings" && init?.method === "PATCH"
        ? jsonResponse({ settings: { map_list_region_grouping: true } })
        : undefined,
    );
    render(<AdminMapsPage />);
    fireEvent.click(await screen.findByLabelText(/group maps by region/i));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => url === "/api/v1/admin/settings" && init?.method === "PATCH",
      );
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        map_list_region_grouping: true,
      });
    });
  });

  it("creates a map and opens its editor", async () => {
    stubAdminFetch((url, init) =>
      url === "/api/v1/editor/maps" && init?.method === "POST"
        ? jsonResponse({ slug: "grand-junction", name: "Grand Junction" }, 201)
        : undefined,
    );
    render(<AdminMapsPage />);
    await screen.findByText("Lancaster");

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Grand Junction" } });
    expect(screen.getByLabelText("Address (slug)")).toHaveValue("grand-junction");
    fireEvent.click(screen.getByRole("button", { name: "Create map" }));

    await waitFor(() => expect(window.location.pathname).toBe("/editor/grand-junction"));
  });

  it("deletes a map only after confirming", async () => {
    const fetchMock = stubAdminFetch((url, init) =>
      url === "/api/v1/editor/maps/lancaster" && init?.method === "DELETE"
        ? jsonResponse(null, 204)
        : undefined,
    );
    render(<AdminMapsPage />);
    await screen.findByText("Lancaster");

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === "/api/v1/editor/maps/lancaster" &&
            (init as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true),
    );
  });

  it("moves a region with the arrow buttons by sending the new order", async () => {
    const regions = [
      { id: "5", name: "North West", sortOrder: 10, mapCount: 1 },
      { id: "6", name: "Scotland", sortOrder: 20, mapCount: 0 },
    ];
    const fetchMock = stubAdminFetch((url, init) => {
      if (url === "/api/v1/admin/regions" && !init?.method) return jsonResponse({ regions });
      if (url === "/api/v1/admin/regions/order") return jsonResponse({ regions });
      return undefined;
    });
    render(<AdminMapsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Move Scotland up" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url === "/api/v1/admin/regions/order");
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ ids: ["6", "5"] });
    });
  });
});
