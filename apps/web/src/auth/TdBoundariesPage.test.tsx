import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TdBoundariesPage } from "./TdBoundariesPage.js";

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

describe("TdBoundariesPage", () => {
  it("lists existing boundaries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            boundaries: [
              {
                id: "1",
                areaA: "PX",
                berthA: "0076",
                areaB: "LA",
                berthB: "0001",
                notes: "test",
                createdBy: "matt",
                createdAt: "2026-09-14T00:00:00.000Z",
              },
            ],
          }),
        ),
      ),
    );

    render(<TdBoundariesPage />);

    expect(await screen.findByText("PX")).toBeInTheDocument();
    expect(screen.getByText("0076")).toBeInTheDocument();
    expect(screen.getByText("LA")).toBeInTheDocument();
  });

  it("submits a new boundary and reloads the list", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(
          jsonResponse({
            id: "2",
            areaA: "PX",
            berthA: "0076",
            areaB: "LA",
            berthB: "0001",
            notes: null,
            createdBy: "matt",
            createdAt: "2026-09-14T00:00:00.000Z",
          }),
        );
      }
      return Promise.resolve(jsonResponse({ boundaries: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TdBoundariesPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Add boundary" })).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText("Area A"), { target: { value: "PX" } });
    fireEvent.change(screen.getByLabelText("Berth A"), { target: { value: "0076" } });
    fireEvent.change(screen.getByLabelText("Area B"), { target: { value: "LA" } });
    fireEvent.change(screen.getByLabelText("Berth B"), { target: { value: "0001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add boundary" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/admin/td-boundaries",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("shows the server's error message when creation fails", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Promise.resolve(
          jsonResponse({ error: { message: "That boundary pair is already recorded" } }, 409),
        );
      }
      return Promise.resolve(jsonResponse({ boundaries: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TdBoundariesPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Add boundary" })).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText("Area A"), { target: { value: "PX" } });
    fireEvent.change(screen.getByLabelText("Berth A"), { target: { value: "0076" } });
    fireEvent.change(screen.getByLabelText("Area B"), { target: { value: "LA" } });
    fireEvent.change(screen.getByLabelText("Berth B"), { target: { value: "0001" } });
    fireEvent.click(screen.getByRole("button", { name: "Add boundary" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That boundary pair is already recorded",
    );
  });
});
