import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminMaintenancePage,
  jobSummary,
  type MaintenanceJobView,
} from "./AdminMaintenancePage.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const AREAS = {
  areas: [
    { tdArea: "CL", allowanceBerths: 0, measuredBerths: 0, allowancesCalculatedAt: null },
    {
      tdArea: "PX",
      allowanceBerths: 210,
      measuredBerths: 168,
      allowancesCalculatedAt: "2026-10-26T16:00:00.000Z",
    },
  ],
};

function job(overrides: Partial<MaintenanceJobView>): MaintenanceJobView {
  return {
    id: "1",
    kind: "berth_allowances",
    tdAreas: ["PX"],
    params: { windowDays: 14 },
    status: "succeeded",
    cancelRequested: false,
    attempts: 1,
    progress: { done: 1, total: 1 },
    result: null,
    error: null,
    requestedBy: "matt",
    requestedAt: "2026-10-26T16:00:00.000Z",
    startedAt: "2026-10-26T16:00:01.000Z",
    finishedAt: "2026-10-26T16:00:09.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("jobSummary", () => {
  it("summarises each kind of job", () => {
    expect(
      jobSummary(
        job({
          result: { windowDays: 14, areas: { PX: { berths: 210, measured: 168 } } },
        }),
      ),
    ).toBe("210 berths (168 measured, 42 default) over 14 days");
    expect(
      jobSummary(
        job({
          kind: "link_backfill",
          result: { linked: 730, carriedForward: 4850, examined: 91230 },
        }),
      ),
    ).toBe("730 linked, 4850 carried on, 91230 examined");
    expect(jobSummary(job({ status: "failed", error: "not on any published map: YX" }))).toBe(
      "not on any published map: YX",
    );
    expect(
      jobSummary(
        job({
          status: "running",
          finishedAt: null,
          progress: { done: 2, total: 5 },
          cancelRequested: true,
        }),
      ),
    ).toBe("2 of 5 — stopping");
  });
});

describe("AdminMaintenancePage", () => {
  it("lists areas, and queues an allowance job for the selected ones", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/v1/admin/maintenance/areas") return Promise.resolve(jsonResponse(AREAS));
      if (url === "/api/v1/admin/maintenance/jobs" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(job({ status: "queued" }), 201));
      }
      return Promise.resolve(jsonResponse({ jobs: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminMaintenancePage />);
    expect(await screen.findByText("PX")).toBeInTheDocument();
    expect(screen.getByText("Never")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Select PX"));
    fireEvent.click(screen.getByRole("button", { name: "Queue job" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/admin/maintenance/jobs",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      kind: "berth_allowances",
      tdAreas: ["PX"],
      params: { windowDays: 14 },
    });
  });

  it("won't queue a job with no area chosen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(jsonResponse(url.endsWith("/areas") ? AREAS : { jobs: [] })),
      ),
    );
    render(<AdminMaintenancePage />);
    await screen.findByText("PX");
    fireEvent.click(screen.getByRole("button", { name: "Queue job" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose at least one TD area.");
  });
});
