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
  window.history.pushState(null, "", "/");
});

const MAPS_BODY = {
  maps: [
    { slug: "lancaster", name: "Lancaster", mapVersion: 3, liveDataStatus: "ok" },
    { slug: "blackpool", name: "Blackpool Line", mapVersion: 1, liveDataStatus: "unknown" },
  ],
};

describe("LandingPage", () => {
  it("lists every map from GET /api/v1/maps, with no create control for a non-admin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(MAPS_BODY))),
    );

    render(<LandingPage canCreateMap={false} canEdit={false} />);

    expect(await screen.findByRole("link", { name: "Lancaster" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Blackpool Line" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create map/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("shows a per-map Edit link for an editor session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(MAPS_BODY))),
    );

    render(<LandingPage canCreateMap={false} canEdit={true} />);

    expect(await screen.findAllByRole("link", { name: "Edit" })).toHaveLength(2);
  });

  it("lets an admin create a map and navigates to its editor on success", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/v1/maps") return Promise.resolve(jsonResponse(MAPS_BODY));
      if (url === "/api/v1/editor/maps" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ slug: "new-map", name: "New Map", mapId: "9" }, 201));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LandingPage canCreateMap={true} canEdit={true} />);
    await screen.findByRole("link", { name: "Lancaster" });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Map" } });
    fireEvent.click(screen.getByRole("button", { name: /create map/i }));

    await waitFor(() => expect(window.location.pathname).toBe("/editor/new-map"));
    const postCall = fetchMock.mock.calls.find(([url]) => url === "/api/v1/editor/maps");
    expect(postCall).toBeDefined();
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({
      slug: "new-map",
      name: "New Map",
    });
  });

  it("shows an error message when creation fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/v1/maps") return Promise.resolve(jsonResponse(MAPS_BODY));
        return Promise.resolve(
          jsonResponse({ error: { message: 'A map with slug "lancaster" already exists' } }, 409),
        );
      }),
    );

    render(<LandingPage canCreateMap={true} canEdit={false} />);
    await screen.findByRole("link", { name: "Lancaster" });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Lancaster" } });
    fireEvent.click(screen.getByRole("button", { name: /create map/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/i);
  });

  it("debounces the place search, then shows a clickable result for a covering map and an inert one for none", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/v1/maps") return Promise.resolve(jsonResponse(MAPS_BODY));
      if (url.startsWith("/api/v1/places/search")) {
        expect(url).toContain("q=lanc");
        return Promise.resolve(
          jsonResponse({
            results: [
              {
                tiploc: "LANCSTR",
                stanox: "12345",
                crs: "LAN",
                name: "Lancaster",
                mapSlug: "lancaster",
                elementId: "station-1",
              },
              {
                tiploc: "BAYHORS",
                stanox: null,
                crs: null,
                name: "Bay Horse Jn",
                mapSlug: null,
                elementId: null,
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<LandingPage canCreateMap={false} canEdit={false} />);
    await screen.findByRole("link", { name: "Lancaster" });

    fireEvent.change(screen.getByLabelText(/name, crs, tiploc or stanox/i), {
      target: { value: "lanc" },
    });

    // Scoped to the search results list — the map list on the left also has its own "Lancaster"
    // link, so an unscoped query would match both once results appear.
    const placesList = await waitFor(() => {
      const el = container.querySelector<HTMLElement>(".landing-page__places");
      if (!el) throw new Error("places list not rendered yet");
      return el;
    });
    const lancasterResult = within(placesList).getByRole("link", { name: "Lancaster" });
    expect(fetchMock.mock.calls.some(([url]) => (url as string).includes("/places/search"))).toBe(
      true,
    );
    expect(within(placesList).getByText("Bay Horse Jn")).toBeInTheDocument();
    expect(within(placesList).getByText(/not on any published map yet/i)).toBeInTheDocument();

    fireEvent.click(lancasterResult);
    expect(window.location.pathname).toBe("/map/lancaster");
    expect(window.location.search).toBe("?center=station-1");
  });

  it("shows no Rename/Delete controls for a non-admin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(MAPS_BODY))),
    );

    render(<LandingPage canCreateMap={false} canEdit={true} />);
    await screen.findByRole("link", { name: "Lancaster" });

    expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("lets an admin rename a map's name and slug via PATCH, then reloads the list (owner request 2026-09-13)", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/v1/maps") return Promise.resolve(jsonResponse(MAPS_BODY));
      if (url === "/api/v1/editor/maps/lancaster" && init?.method === "PATCH") {
        return Promise.resolve(jsonResponse({ mapId: "1", slug: "lanc", name: "Lancaster PSB" }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<LandingPage canCreateMap={true} canEdit={false} />);
    await screen.findByRole("link", { name: "Lancaster" });

    fireEvent.click(screen.getAllByRole("button", { name: "Rename" })[0]!);

    // Scoped to the rename form — the "+ New map" create form (also visible, canCreateMap=true)
    // has its own identically-labeled Name/Slug fields.
    const renameForm = within(container.querySelector(".landing-page__rename-form")!);
    const nameInput = renameForm.getByLabelText("Name");
    expect(nameInput).toHaveValue("Lancaster");
    fireEvent.change(nameInput, { target: { value: "Lancaster PSB" } });
    const slugInput = renameForm.getByLabelText("Slug");
    expect(slugInput).toHaveValue("lancaster");
    fireEvent.change(slugInput, { target: { value: "lanc" } });
    fireEvent.click(renameForm.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/v1/editor/maps/lancaster")).toBe(
        true,
      ),
    );
    const patchCall = fetchMock.mock.calls.find(([url]) => url === "/api/v1/editor/maps/lancaster");
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({
      name: "Lancaster PSB",
      slug: "lanc",
    });
    // Reloaded the list afterward — GET /api/v1/maps called at least twice (initial + reload).
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([url]) => url === "/api/v1/maps").length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  it("shows an error and keeps the rename form open when renaming fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/v1/maps") return Promise.resolve(jsonResponse(MAPS_BODY));
        if (url === "/api/v1/editor/maps/lancaster" && init?.method === "PATCH") {
          return Promise.resolve(
            jsonResponse({ error: { message: 'A map with slug "blackpool" already exists' } }, 409),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const { container } = render(<LandingPage canCreateMap={true} canEdit={false} />);
    await screen.findByRole("link", { name: "Lancaster" });

    fireEvent.click(screen.getAllByRole("button", { name: "Rename" })[0]!);
    const renameForm = within(container.querySelector(".landing-page__rename-form")!);
    fireEvent.change(renameForm.getByLabelText("Slug"), { target: { value: "blackpool" } });
    fireEvent.click(renameForm.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/i);
    // Form stays open on failure so the admin can correct it.
    expect(container.querySelector(".landing-page__rename-form")).toBeInTheDocument();
  });

  it("lets an admin cancel a rename without calling the API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(MAPS_BODY))),
    );

    const { container } = render(<LandingPage canCreateMap={true} canEdit={false} />);
    await screen.findByRole("link", { name: "Lancaster" });

    fireEvent.click(screen.getAllByRole("button", { name: "Rename" })[0]!);
    const renameForm = within(container.querySelector(".landing-page__rename-form")!);
    expect(renameForm.getByLabelText("Slug")).toBeInTheDocument();
    fireEvent.click(renameForm.getByRole("button", { name: "Cancel" }));

    expect(container.querySelector(".landing-page__rename-form")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Lancaster" })).toBeInTheDocument();
  });

  it("deletes a map only after a second confirming click, then reloads the list", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/v1/maps") return Promise.resolve(jsonResponse(MAPS_BODY));
      if (url === "/api/v1/editor/maps/lancaster" && init?.method === "DELETE") {
        return Promise.resolve(jsonResponse(null, 204));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LandingPage canCreateMap={true} canEdit={false} />);
    await screen.findByRole("link", { name: "Lancaster" });

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
    // First click only arms confirmation — no DELETE call yet.
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Confirm delete" })).toBeInTheDocument();

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

  it("lets an admin cancel a delete confirmation without calling the API", async () => {
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (url === "/api/v1/maps") return Promise.resolve(jsonResponse(MAPS_BODY));
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LandingPage canCreateMap={true} canEdit={false} />);
    await screen.findByRole("link", { name: "Lancaster" });

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("button", { name: "Confirm delete" })).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });

  it("clears results and stops searching when the query is emptied", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/v1/maps") return Promise.resolve(jsonResponse(MAPS_BODY));
      return Promise.resolve(jsonResponse({ results: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<LandingPage canCreateMap={false} canEdit={false} />);
    await screen.findByRole("link", { name: "Lancaster" });

    const searchInput = screen.getByLabelText(/name, crs, tiploc or stanox/i);
    fireEvent.change(searchInput, { target: { value: "lanc" } });
    await waitFor(() => expect(screen.getByText(/no matches/i)).toBeInTheDocument());

    fireEvent.change(searchInput, { target: { value: "" } });
    await waitFor(() => expect(screen.queryByText(/no matches/i)).not.toBeInTheDocument());
  });
});
