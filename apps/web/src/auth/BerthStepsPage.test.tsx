import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BerthStepsPage } from "./BerthStepsPage.js";

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

function fill(area: string, from: string, to: string): void {
  fireEvent.change(screen.getByLabelText("Train describer area"), { target: { value: area } });
  fireEvent.change(screen.getByLabelText("From berth"), { target: { value: from } });
  fireEvent.change(screen.getByLabelText("To berth"), { target: { value: to } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
}

describe("BerthStepsPage (owner request 2026-09-22)", () => {
  it("asks for the last 50 steps of the pair and lists them newest first in UK time", async () => {
    const fetchMock = vi.fn((_url: string) =>
      Promise.resolve(
        jsonResponse({
          tdArea: "M9",
          fromBerth: "3879",
          toBerth: "3881",
          since: "2026-06-24T12:00:00.000Z",
          steps: [
            { eventAt: "2026-09-22T17:05:09.000Z", description: "2F19" },
            { eventAt: "2026-01-10T09:00:00.000Z", description: null },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<BerthStepsPage />);
    fill("m9", "3879", "3881");

    const table = await screen.findByRole("table", { name: "3879 to 3881" });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "/api/v1/admin/berths/steps?tdArea=M9&fromBerth=3879&toBerth=3881&limit=50",
    );
    // 17:05:09 UTC is 18:05:09 in the UK in September (BST); January is GMT.
    expect(table).toHaveTextContent("18:05:09");
    expect(table).toHaveTextContent("2F19");
    expect(table).toHaveTextContent("09:00:00");
  });

  it("says so when the pair has no steps, and shows an API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            tdArea: "M9",
            fromBerth: "ZZZZ",
            toBerth: "YYYY",
            since: "",
            steps: [],
          }),
        ),
      ),
    );
    render(<BerthStepsPage />);
    fill("M9", "ZZZZ", "YYYY");
    expect(await screen.findByText(/No steps from ZZZZ to YYYY in M9/)).toBeInTheDocument();

    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(jsonResponse({ error: { message: "tdArea (two characters)" } }, 400)),
      ),
    );
    fill("M99", "A", "B");
    expect(await screen.findByRole("alert")).toHaveTextContent("tdArea (two characters)");
  });
});
