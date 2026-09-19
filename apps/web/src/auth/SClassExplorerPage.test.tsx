import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SClassExplorerPage } from "./SClassExplorerPage.js";

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const bits = (value: number, labels: Record<number, string> = {}) =>
  Array.from({ length: 8 }, (_, bit) => ({
    bit,
    value: ((value >> bit) & 1) === 1,
    lastChangedAt: null,
    changes24h: bit === 2 ? 4 : 0,
    definition: labels[bit]
      ? {
          tdArea: "M9",
          address: "03",
          bit,
          kind: "signal",
          label: labels[bit],
          destination: null,
          source: "observed",
          notes: null,
          updatedBy: "owner",
          updatedAt: "2026-09-19T10:00:00Z",
        }
      : null,
  }));

function stubApi(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string) => {
    if (url === "/api/v1/admin/s-class/areas") {
      return Promise.resolve(
        jsonResponse({
          areas: [{ tdArea: "M9", bytes: 2, lastEventAt: "2026-09-19T10:00:00Z", definitions: 1 }],
        }),
      );
    }
    if (url === "/api/v1/admin/s-class/areas/M9/bits") {
      return Promise.resolve(
        jsonResponse({
          bytes: [
            {
              address: "03",
              value: 4,
              confirmedAt: "2026-09-19T10:00:00Z",
              sourceKind: "update",
              lastRefreshAt: null,
              bits: bits(4, { 2: "S3003" }),
            },
            {
              address: "04",
              value: 0,
              confirmedAt: "2026-09-19T10:00:00Z",
              sourceKind: "refresh",
              lastRefreshAt: null,
              bits: bits(0),
            },
          ],
        }),
      );
    }
    if (url.includes("/history")) return Promise.resolve(jsonResponse({ transitions: [] }));
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SClassExplorerPage (Milestone 36c)", () => {
  it("shows an area's bit grid with definitions, and opens a bit's panel on click", async () => {
    stubApi();
    render(<SClassExplorerPage />);

    const areaSelect = await screen.findByLabelText("TD area");
    await screen.findByRole("option", { name: /M9 — 2 bytes, 1 defined/ });
    fireEvent.change(areaSelect, { target: { value: "M9" } });

    const grid = await screen.findByRole("table", { name: "M9 S-Class bits" });
    expect(within(grid).getByText("S3003")).toBeInTheDocument();
    // Header row + one row per byte (03 and 04).
    expect(within(grid).getAllByRole("row")).toHaveLength(3);

    fireEvent.click(within(grid).getByTitle(/^03:2 = 1/));
    expect(await screen.findByRole("heading", { name: "M9 03:2 — currently 1" })).toBeVisible();
    expect(screen.getByLabelText("Label (e.g. S3003, R1007)")).toHaveValue("S3003");
  });

  it("won't preview an import until the byte numbering is chosen", async () => {
    stubApi();
    render(<SClassExplorerPage />);
    fireEvent.change(await screen.findByLabelText("TD area"), { target: { value: "M9" } });
    await screen.findByRole("table", { name: "M9 S-Class bits" });

    fireEvent.change(screen.getByLabelText("Table"), { target: { value: "03:0\tS1" } });
    const preview = screen.getByRole("button", { name: "Preview" });
    expect(preview).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Hex (e.g. 03:0, 1A:3)"));
    expect(preview).toBeEnabled();
  });
});
