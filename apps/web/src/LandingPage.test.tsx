import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "./LandingPage.js";

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
  window.localStorage.clear();
  window.history.pushState(null, "", "/");
});

const NORTH_WEST = { id: "1", name: "North West", sortOrder: 10 };
const MIDLANDS = { id: "2", name: "West Midlands", sortOrder: 20 };

function map(
  slug: string,
  name: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    slug,
    name,
    description: null,
    visibility: "public",
    region: null,
    publishedAt: "2026-09-30T12:00:00Z",
    mapVersion: 1,
    liveDataStatus: "ok",
    ...overrides,
  };
}

// Deliberately out of order: the page sorts by name.
const MAPS_BODY = {
  maps: [
    map("lancaster", "Lancaster", { region: NORTH_WEST }),
    map("wolverhampton", "Wolverhampton", { region: MIDLANDS }),
    map("carlisle", "Carlisle", { region: NORTH_WEST, description: "Carlisle station and yards" }),
    map("blackpool", "Blackpool Line", { liveDataStatus: "unknown" }),
  ],
  regionGrouping: false,
};

function stubFetch(handler: (url: string, init?: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const response = handler(url, init);
    if (!response) throw new Error(`unexpected fetch: ${url}`);
    return Promise.resolve(response);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mapNamesInOrder(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".map-card__name")].map((el) => el.textContent ?? "");
}

describe("LandingPage", () => {
  it("lists every map A–Z with no region headings or toggle when grouping is off", async () => {
    stubFetch((url) => (url === "/api/v1/maps" ? jsonResponse(MAPS_BODY) : undefined));

    const { container } = render(<LandingPage isAdmin={false} canEdit={false} />);

    await screen.findByRole("link", { name: "Lancaster" });
    expect(mapNamesInOrder(container)).toEqual([
      "Blackpool Line",
      "Carlisle",
      "Lancaster",
      "Wolverhampton",
    ]);
    expect(screen.queryByRole("heading", { name: "North West" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "By region" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Manage maps" })).not.toBeInTheDocument();
    expect(screen.getByText("Carlisle station and yards")).toBeInTheDocument();
  });

  it("groups by region in the admin's order, then Other, and switches to A–Z (remembered)", async () => {
    stubFetch((url) =>
      url === "/api/v1/maps" ? jsonResponse({ ...MAPS_BODY, regionGrouping: true }) : undefined,
    );

    const { container, unmount } = render(<LandingPage isAdmin={false} canEdit={false} />);
    await screen.findByRole("link", { name: "Lancaster" });

    const headings = [...container.querySelectorAll(".map-group__title")].map((h) => h.textContent);
    expect(headings).toEqual(["North West", "West Midlands", "Other"]);
    const northWest = within(screen.getByRole("region", { name: "North West" }));
    expect(northWest.getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Carlisle",
      "Lancaster",
    ]);
    expect(screen.getByRole("button", { name: "By region" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "A–Z" }));
    expect(container.querySelectorAll(".map-group__title")).toHaveLength(0);
    expect(mapNamesInOrder(container)).toEqual([
      "Blackpool Line",
      "Carlisle",
      "Lancaster",
      "Wolverhampton",
    ]);

    // The choice survives a reload.
    unmount();
    const again = render(<LandingPage isAdmin={false} canEdit={false} />);
    await within(again.container).findByRole("link", { name: "Lancaster" });
    expect(again.container.querySelectorAll(".map-group__title")).toHaveLength(0);
  });

  it("marks a restricted map as not public", async () => {
    stubFetch((url) =>
      url === "/api/v1/maps"
        ? jsonResponse({ maps: [map("staff", "Staff Map", { visibility: "restricted" })] })
        : undefined,
    );

    render(<LandingPage isAdmin={false} canEdit={false} />);
    expect(await screen.findByText("Not public")).toBeInTheDocument();
  });

  it("gives an editor Edit links and a list of never-published maps", async () => {
    stubFetch((url) => {
      if (url === "/api/v1/maps") return jsonResponse(MAPS_BODY);
      if (url === "/api/v1/editor/maps") {
        return jsonResponse({
          maps: [
            { slug: "lancaster", name: "Lancaster", publishedVersion: 3 },
            { slug: "new-map", name: "New Map", publishedVersion: null },
          ],
        });
      }
      return undefined;
    });

    render(<LandingPage isAdmin={false} canEdit={true} />);

    expect(await screen.findAllByRole("link", { name: "Edit" })).toHaveLength(4);
    const unpublished = within(await screen.findByRole("region", { name: "Unpublished maps" }));
    expect(unpublished.getByRole("link", { name: "New Map" })).toHaveAttribute(
      "href",
      "/editor/new-map",
    );
    expect(unpublished.queryByRole("link", { name: "Lancaster" })).not.toBeInTheDocument();
  });

  it("links an admin to Admin › Maps", async () => {
    stubFetch((url) => {
      if (url === "/api/v1/maps") return jsonResponse(MAPS_BODY);
      if (url === "/api/v1/editor/maps") return jsonResponse({ maps: [] });
      return undefined;
    });

    render(<LandingPage isAdmin={true} canEdit={true} />);
    expect(await screen.findByRole("link", { name: "Manage maps" })).toHaveAttribute(
      "href",
      "/admin/maps",
    );
  });

  it("shows a filter box once the list is long, matching name, description or region", async () => {
    const many = Array.from({ length: 9 }, (_, i) => map(`m${i}`, `Map ${i}`));
    many.push(map("carlisle", "Carlisle", { description: "Border city", region: NORTH_WEST }));
    stubFetch((url) => (url === "/api/v1/maps" ? jsonResponse({ maps: many }) : undefined));

    const { container } = render(<LandingPage isAdmin={false} canEdit={false} />);
    await screen.findByRole("link", { name: "Carlisle" });

    fireEvent.change(screen.getByLabelText("Filter maps"), { target: { value: "border" } });
    expect(mapNamesInOrder(container)).toEqual(["Carlisle"]);
    fireEvent.change(screen.getByLabelText("Filter maps"), { target: { value: "north west" } });
    expect(mapNamesInOrder(container)).toEqual(["Carlisle"]);
    fireEvent.change(screen.getByLabelText("Filter maps"), { target: { value: "nowhere" } });
    expect(screen.getByText(/no maps match/i)).toBeInTheDocument();
  });

  it("place search: one map links straight there, several are listed to choose from, none says so", async () => {
    const fetchMock = stubFetch((url) => {
      if (url === "/api/v1/maps") return jsonResponse(MAPS_BODY);
      if (url.startsWith("/api/v1/places/search")) {
        expect(url).toContain("q=lanc");
        return jsonResponse({
          results: [
            {
              tiploc: "LANCSTR",
              stanox: "12345",
              crs: "LAN",
              name: "Lancaster",
              maps: [{ slug: "lancaster", name: "Lancaster", elementId: "station-1" }],
            },
            {
              tiploc: "CRNFNJN",
              stanox: null,
              crs: null,
              name: "Carnforth North Jn",
              maps: [
                { slug: "lancaster", name: "Lancaster", elementId: "station-7" },
                { slug: "wcml-north", name: "WCML North", elementId: "station-2" },
              ],
            },
            {
              tiploc: "BAYHORS",
              stanox: null,
              crs: null,
              name: "Bay Horse Jn",
              maps: [],
            },
          ],
        });
      }
      return undefined;
    });

    const { container } = render(<LandingPage isAdmin={false} canEdit={false} />);
    await screen.findByRole("link", { name: "Lancaster" });

    fireEvent.change(screen.getByLabelText(/name, crs, tiploc or stanox/i), {
      target: { value: "lanc" },
    });

    // Scoped to the results list — the map list also has a "Lancaster" link.
    const placesList = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(".landing-page__places");
      if (!el) throw new Error("places list not rendered yet");
      return el;
    });
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/places/search"))).toBe(true);

    const rows = [...placesList.querySelectorAll<HTMLElement>(".landing-page__place-row")];
    const carnforth = rows.find((row) => row.textContent?.includes("Carnforth North Jn"))!;
    expect(within(carnforth).getByText(/on 2 maps/i)).toBeInTheDocument();
    expect(within(carnforth).getByRole("link", { name: "WCML North" })).toHaveAttribute(
      "href",
      "/map/wcml-north?center=station-2",
    );
    // A place on several maps has no single link of its own.
    expect(within(carnforth).queryByRole("link", { name: "Carnforth North Jn" })).toBeNull();

    expect(within(placesList).getByText(/not on any map yet/i)).toBeInTheDocument();

    const lancaster = rows.find((row) => row.textContent?.startsWith("Lancaster"))!;
    expect(within(lancaster).getByText("on Lancaster")).toBeInTheDocument();
    fireEvent.click(within(lancaster).getByRole("link", { name: "Lancaster" }));
    expect(window.location.pathname).toBe("/map/lancaster");
    expect(window.location.search).toBe("?center=station-1");
  });

  it("clears results and stops searching when the query is emptied", async () => {
    stubFetch((url) =>
      url === "/api/v1/maps" ? jsonResponse(MAPS_BODY) : jsonResponse({ results: [] }),
    );

    render(<LandingPage isAdmin={false} canEdit={false} />);
    await screen.findByRole("link", { name: "Lancaster" });

    const searchInput = screen.getByLabelText(/name, crs, tiploc or stanox/i);
    fireEvent.change(searchInput, { target: { value: "lanc" } });
    await waitFor(() => expect(screen.getByText(/no matches/i)).toBeInTheDocument());

    fireEvent.change(searchInput, { target: { value: "" } });
    await waitFor(() => expect(screen.queryByText(/no matches/i)).not.toBeInTheDocument());
  });
});
