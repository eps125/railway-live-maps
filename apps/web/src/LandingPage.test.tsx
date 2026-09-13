import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "New Map" } });
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

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "Lancaster" } });
    fireEvent.click(screen.getByRole("button", { name: /create map/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/i);
  });
});
