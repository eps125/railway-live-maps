import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunPopup } from "./RunPopup.js";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RunPopup", () => {
  it("renders full run detail when matched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            tdArea: "PX",
            berth: "0512",
            description: "2A16",
            occupancyEnteredAt: "2026-08-10T10:00:00.000Z",
            resolution: { status: "matched", confidence: 0.9, resolverVersion: 1, candidates: [] },
            run: {
              runId: "run-1",
              trustTrainId: "2A1612AA26",
              signallingId: "2A16",
              serviceDate: "2026-08-10",
              activatedAt: "2026-08-10T09:30:00.000Z",
              operatorCode: "NT",
              serviceCode: "22222000",
              lifecycleState: "activated",
              scheduleLink: { matchOutcome: "matched", scheduleId: "42" },
            },
            schedule: {
              scheduleId: "42",
              trainUid: "U12345",
              stpIndicator: "P",
              source: "SCHEDULE",
              originTiploc: "PRST",
              destinationTiploc: "LANCSTR",
              locations: [
                {
                  seqNo: 1,
                  locationType: "origin",
                  tiploc: "PRST",
                  arrivalPublic: null,
                  departurePublic: "1000",
                  passPublic: null,
                  platform: "4",
                },
              ],
            },
            latestMovement: {
              eventType: "DEPARTURE",
              locationStanox: "11224",
              platform: "4",
              variationStatus: "LATE",
              timetableVariationMinutes: 3,
            },
          }),
        ),
      ),
    );

    render(<RunPopup elementId="berth-1" displayName="Berth 1" tdArea="PX" berth="0512" />);

    expect(await screen.findByText("2A1612AA26")).toBeInTheDocument();
    expect(screen.getByText("U12345")).toBeInTheDocument();
    expect(screen.getByText(/Matched/)).toBeInTheDocument();
  });

  it("shows candidates without picking one when ambiguous", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            tdArea: "PX",
            berth: "0513",
            description: "3A16",
            occupancyEnteredAt: null,
            resolution: {
              status: "ambiguous",
              confidence: null,
              resolverVersion: 1,
              candidates: [
                { trainRunId: "run-a", score: 40, confidence: 0.4, reasons: ["schedule-linked"] },
                { trainRunId: "run-b", score: 40, confidence: 0.4, reasons: ["schedule-linked"] },
              ],
            },
            run: null,
            schedule: null,
            latestMovement: null,
          }),
        ),
      ),
    );

    render(<RunPopup elementId="berth-2" displayName="Berth 2" tdArea="PX" berth="0513" />);

    expect(await screen.findByText(/Ambiguous/)).toBeInTheDocument();
    expect(screen.getByText(/run-a/)).toBeInTheDocument();
    expect(screen.getByText(/run-b/)).toBeInTheDocument();
  });

  it("shows the exact spec'd message when unmatched, without fabricating a run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            tdArea: "PX",
            berth: "0514",
            description: "4A16",
            occupancyEnteredAt: null,
            resolution: {
              status: "unmatched",
              confidence: null,
              resolverVersion: 1,
              candidates: [],
            },
            run: null,
            schedule: null,
            latestMovement: null,
          }),
        ),
      ),
    );

    render(<RunPopup elementId="berth-3" displayName="Berth 3" tdArea="PX" berth="0514" />);

    expect(await screen.findByText("No matching activated schedule found.")).toBeInTheDocument();
  });
});
