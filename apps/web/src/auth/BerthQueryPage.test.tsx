import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BerthQueryPage } from "./BerthQueryPage.js";

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

describe("BerthQueryPage", () => {
  it("searches with the entered comma-separated area(s) and headcode", async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(
        jsonResponse({
          events: [
            {
              id: "1",
              tdArea: "PX",
              messageType: "CA",
              fromBerth: "0076",
              toBerth: "0077",
              description: "1A23",
              eventAt: "2026-09-17T10:00:00.000Z",
              ingestionSequence: "1",
            },
          ],
          nextCursor: null,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<BerthQueryPage />);

    fireEvent.change(screen.getByLabelText("Train describer area(s)"), {
      target: { value: "px, la" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. 1A23"), { target: { value: "1a23" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/admin/berths/query?"),
      ),
    );
    const queryUrl = fetchMock.mock.calls[0]![0] as string;
    expect(queryUrl).toContain("tdAreas=PX%2CLA");
    expect(queryUrl).toContain("headcode=1A23");

    expect(await screen.findByText("0076")).toBeInTheDocument();
    expect(screen.getByText("0077")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "PX" })).toBeInTheDocument();
  });

  it("shows a client-side error when searching with no area entered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({}))),
    );

    render(<BerthQueryPage />);
    fireEvent.change(screen.getByPlaceholderText("e.g. 1A23"), { target: { value: "1A23" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Enter at least one train describer area.")).toBeInTheDocument();
  });

  it("shows the server's error message when the search fails", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ error: { message: "boom" } }, 400)),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<BerthQueryPage />);
    fireEvent.change(screen.getByLabelText("Train describer area(s)"), {
      target: { value: "PX" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. 1A23"), { target: { value: "1A23" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
