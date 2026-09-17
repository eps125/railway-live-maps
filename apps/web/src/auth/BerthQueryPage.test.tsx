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

function selectAreas(select: HTMLSelectElement, values: string[]): void {
  Array.from(select.options).forEach((option) => {
    option.selected = values.includes(option.value);
  });
  fireEvent.change(select);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BerthQueryPage", () => {
  it("loads TD areas and searches with the selected area(s) and headcode", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith("/api/v1/td/areas")) {
        return Promise.resolve(jsonResponse({ areas: [{ tdArea: "PX" }, { tdArea: "LA" }] }));
      }
      if (url.startsWith("/api/v1/admin/berths/query")) {
        return Promise.resolve(
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
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<BerthQueryPage />);

    const select = (await screen.findByLabelText("Train describer area(s)")) as HTMLSelectElement;
    selectAreas(select, ["PX"]);
    fireEvent.change(screen.getByPlaceholderText("e.g. 1A23"), { target: { value: "1a23" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/admin/berths/query?"),
      ),
    );
    const queryUrl = fetchMock.mock.calls.find(([u]: [string]) =>
      u.startsWith("/api/v1/admin/berths/query"),
    )![0] as string;
    expect(queryUrl).toContain("tdAreas=PX");
    expect(queryUrl).toContain("headcode=1A23");

    expect(await screen.findByText("0076")).toBeInTheDocument();
    expect(screen.getByText("0077")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "PX" })).toBeInTheDocument();
  });

  it("shows a client-side error when searching with no area selected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(jsonResponse(url.includes("td/areas") ? { areas: [] } : {})),
      ),
    );

    render(<BerthQueryPage />);
    fireEvent.change(await screen.findByPlaceholderText("e.g. 1A23"), {
      target: { value: "1A23" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(
      await screen.findByText("Select at least one train describer area."),
    ).toBeInTheDocument();
  });

  it("shows the server's error message when the search fails", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith("/api/v1/td/areas")) {
        return Promise.resolve(jsonResponse({ areas: [{ tdArea: "PX" }] }));
      }
      return Promise.resolve(jsonResponse({ error: { message: "boom" } }, 400));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<BerthQueryPage />);
    const select = (await screen.findByLabelText("Train describer area(s)")) as HTMLSelectElement;
    selectAreas(select, ["PX"]);
    fireEvent.change(screen.getByPlaceholderText("e.g. 1A23"), { target: { value: "1A23" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
