import { act, render, screen } from "@testing-library/react";
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
              originName: "Preston",
              destinationTiploc: "LANCSTR",
              destinationName: "Lancaster",
              locations: [
                {
                  seqNo: 1,
                  locationType: "origin",
                  tiploc: "PRST",
                  locationName: "Preston",
                  arrivalPublic: null,
                  arrivalWorking: null,
                  departurePublic: "1000",
                  departureWorking: "0958",
                  passPublic: null,
                  passWorking: null,
                  platform: "4",
                  path: null,
                  line: "UF",
                },
                {
                  seqNo: 2,
                  locationType: "pass",
                  tiploc: "OXHEYJN",
                  locationName: "Oxheys Junction",
                  arrivalPublic: null,
                  arrivalWorking: null,
                  departurePublic: null,
                  departureWorking: null,
                  passPublic: "1006",
                  passWorking: null,
                  platform: null,
                  path: null,
                  line: null,
                },
                {
                  // The realistic case (confirmed against real production data 2026-08-13): CIF
                  // essentially never populates a *public* pass time for a junction — only the
                  // working one. Proves the fallback, not just the rarely-populated public field.
                  seqNo: 3,
                  locationType: "pass",
                  tiploc: "WRKGJN",
                  locationName: "Working Junction",
                  arrivalPublic: null,
                  arrivalWorking: null,
                  departurePublic: null,
                  departureWorking: null,
                  passPublic: null,
                  passWorking: "1215",
                  platform: null,
                  path: "DS",
                  line: "DF",
                },
                {
                  // A freight/parcels-style genuine stop (2026-08-13, real 4S44 example): never
                  // has public times at all, but is a real stop (distinct booked working
                  // arrival/departure) — must be classified as a call, not a muted pass.
                  seqNo: 4,
                  locationType: "intermediate",
                  tiploc: "STAFFJN",
                  locationName: null,
                  arrivalPublic: null,
                  arrivalWorking: "1351",
                  departurePublic: null,
                  departureWorking: "1356",
                  passPublic: null,
                  passWorking: null,
                  platform: null,
                  path: null,
                  line: null,
                },
                {
                  seqNo: 5,
                  locationType: "intermediate",
                  tiploc: "UNTIMEDJ",
                  locationName: null,
                  arrivalPublic: null,
                  arrivalWorking: null,
                  departurePublic: null,
                  departureWorking: null,
                  passPublic: null,
                  passWorking: null,
                  platform: null,
                  path: null,
                  line: null,
                },
                {
                  seqNo: 6,
                  locationType: "destination",
                  tiploc: "LANCSTR",
                  locationName: "Lancaster",
                  arrivalPublic: "1030",
                  arrivalWorking: "1029",
                  departurePublic: null,
                  departureWorking: null,
                  passPublic: null,
                  passWorking: null,
                  platform: "3",
                  path: null,
                  line: null,
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

    render(
      <RunPopup
        elementId="berth-1"
        displayName="Berth 1"
        tdArea="PX"
        berth="0512"
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText("2A1612AA26")).toBeInTheDocument();
    expect(screen.getByText("U12345")).toBeInTheDocument();
    expect(screen.getByText(/Matched/)).toBeInTheDocument();
    // Origin/destination resolved via CORPUS, raw TIPLOC kept alongside rather than hidden — each
    // appears twice (once in the summary dl, once as that calling point's own row).
    expect(screen.getAllByText("Preston (PRST)")).toHaveLength(2);
    expect(screen.getAllByText("Lancaster (LANCSTR)")).toHaveLength(2);
    // A calling point (destination) shows its own arrival.
    expect(screen.getByText("10:30")).toBeInTheDocument();
    // A passing point shows its pass time, prefixed and distinguishable from a call.
    expect(screen.getByText("pass 10:06")).toBeInTheDocument();
    // No public pass time (the realistic case) falls back to the working pass time rather than
    // showing a blank dash — real train-time sites show exactly this working time.
    expect(screen.getByText("pass 12:15")).toBeInTheDocument();
    // A freight-style stop with only working times (no public times at all) is classified as a
    // real call, not lumped in with the muted passing points.
    expect(screen.getByText("13:51")).toBeInTheDocument();
    expect(screen.getByText("13:56")).toBeInTheDocument();
    // Path/Line codes are shown alongside the location.
    expect(screen.getByText("DS/DF")).toBeInTheDocument();
    // An untimed structural TIPLOC (no name, no times at all) still gets a row, not silently
    // dropped, and falls back to the raw TIPLOC when CORPUS has no name for it.
    expect(screen.getByText("UNTIMEDJ")).toBeInTheDocument();
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
                {
                  trainRunId: "run-a",
                  score: 40,
                  confidence: 0.4,
                  reasons: ["schedule-linked"],
                  signallingId: "3A16",
                  trustTrainId: "723A16MG11",
                  trainUid: "C17206",
                },
                // No identity resolved (edge case — e.g. the train_run has since been deleted):
                // falls back to the raw id rather than showing nothing.
                {
                  trainRunId: "run-b",
                  score: 40,
                  confidence: 0.4,
                  reasons: ["schedule-linked"],
                  signallingId: null,
                  trustTrainId: null,
                  trainUid: null,
                },
              ],
            },
            run: null,
            schedule: null,
            latestMovement: null,
          }),
        ),
      ),
    );

    render(
      <RunPopup
        elementId="berth-2"
        displayName="Berth 2"
        tdArea="PX"
        berth="0513"
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText(/Ambiguous/)).toBeInTheDocument();
    // Human-readable identity (UID · headcode · TRUST id), not the bare UUID — a raw id is
    // useless to someone reading the popup (confirmed feedback, 2026-08-11).
    expect(screen.getByText(/C17206 · 3A16 · 723A16MG11/)).toBeInTheDocument();
    // No identity resolved at all: falls back to the raw trainRunId rather than an empty label.
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

    render(
      <RunPopup
        elementId="berth-3"
        displayName="Berth 3"
        tdArea="PX"
        berth="0514"
        onClose={() => {}}
      />,
    );

    expect(await screen.findByText("No matching activated schedule found.")).toBeInTheDocument();
  });

  it("has a close button that calls onClose", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            tdArea: "PX",
            berth: "0515",
            description: "5A16",
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

    const onClose = vi.fn();
    render(
      <RunPopup
        elementId="berth-4"
        displayName="Berth 4"
        tdArea="PX"
        berth="0515"
        onClose={onClose}
      />,
    );

    const closeButton = await screen.findByRole("button", { name: "Close" });
    closeButton.click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("picks up a resolution that lands after the popup was already open (regression)", async () => {
    // Real-world case, 2026-08-10: a berth clicked right as a train arrived showed "unmatched"
    // forever because the old implementation fetched exactly once — the resolver matched it 15s
    // later and the popup never found out. The popup must poll, not fetch-once.
    vi.useFakeTimers();
    const unmatchedBody = {
      tdArea: "PX",
      berth: "0226",
      description: "9S93",
      occupancyEnteredAt: "2026-08-10T19:46:33.000Z",
      resolution: { status: "unmatched", confidence: null, resolverVersion: 2, candidates: [] },
      run: null,
      schedule: null,
      latestMovement: null,
    };
    const matchedBody = {
      ...unmatchedBody,
      resolution: { status: "matched", confidence: 0.75, resolverVersion: 2, candidates: [] },
      run: {
        runId: "run-9s93",
        trustTrainId: "729S93MT10",
        signallingId: "9S93",
        serviceDate: "2026-08-10",
        activatedAt: "2026-08-10T15:40:21.000Z",
        operatorCode: "GW",
        serviceCode: "9S93000",
        lifecycleState: "activated",
        scheduleLink: { matchOutcome: "matched", scheduleId: "1" },
      },
      schedule: null,
      latestMovement: null,
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(unmatchedBody))
      .mockResolvedValue(jsonResponse(matchedBody));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <RunPopup
        elementId="berth-px-0226"
        displayName="0226"
        tdArea="PX"
        berth="0226"
        onClose={() => {}}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("No matching activated schedule found.")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText("729S93MT10")).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
  });
});
