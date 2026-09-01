import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunPopup } from "./RunPopup.js";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const NOTE =
  "Candidate schedules for this headcode running today, mirrored from openrail-eps (garner). " +
  "RLM's berth-to-run resolver is being rebuilt (ADR 0002) — this is garner's data, not a " +
  "confirmed RLM identification.";

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    tdArea: "PX",
    berth: "0512",
    description: "2A16",
    headcode: "2A16",
    occupancyEnteredAt: "2026-08-10T10:00:00.000Z",
    note: NOTE,
    effective: null,
    candidateSchedules: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RunPopup", () => {
  it("renders the effective schedule, its activation and its latest movement", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            baseBody({
              effective: {
                scheduleId: "42",
                trainUid: "U12345",
                stpIndicator: "P",
                operatorCode: "NT",
                trainStatus: "P",
                serviceCode: "22222000",
                category: "OO",
                originTiploc: "PRST",
                originName: "Preston",
                destinationTiploc: "LANCSTR",
                destinationName: "Lancaster",
                selectedBy: "trust_activation",
                activation: {
                  trustId: "729S93MT10",
                  deduced: false,
                  activatedAt: "2026-08-10T09:30:00.000Z",
                  trainUid: "U12345",
                  tocId: "NT",
                  scheduleWttId: "U12345",
                  scheduleType: "P",
                  originDepartureAt: "2026-08-10T10:00:00.000Z",
                },
                latestMovement: {
                  trustId: "729S93MT10",
                  locStanox: "11224",
                  locName: "Preston",
                  platform: "4",
                  actualTimestamp: "2026-08-10T10:01:00.000Z",
                  plannedTimestamp: "2026-08-10T09:58:00.000Z",
                  gbttTimestamp: "2026-08-10T10:00:00.000Z",
                  eventKind: "departure",
                  variationStatus: "late",
                  variationMinutes: 3,
                  terminated: false,
                  offRoute: false,
                  manual: false,
                  correction: false,
                  nextReportStanox: "11225",
                },
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
                    passWorking: null,
                    platform: "4",
                    path: null,
                    line: "UF",
                    dayOffset: 0,
                  },
                  {
                    seqNo: 2,
                    locationType: "pass",
                    tiploc: "WRKGJN",
                    locationName: "Working Junction",
                    arrivalPublic: null,
                    arrivalWorking: null,
                    departurePublic: null,
                    departureWorking: null,
                    passWorking: "1215",
                    platform: null,
                    path: "DS",
                    line: "DF",
                    dayOffset: 0,
                  },
                  {
                    seqNo: 3,
                    locationType: "destination",
                    tiploc: "LANCSTR",
                    locationName: "Lancaster",
                    arrivalPublic: "1030",
                    arrivalWorking: "1029",
                    departurePublic: null,
                    departureWorking: null,
                    passWorking: null,
                    platform: "3",
                    path: null,
                    line: null,
                    dayOffset: 0,
                  },
                ],
              },
              candidateSchedules: [
                {
                  scheduleId: "42",
                  trainUid: "U12345",
                  stpIndicator: "P",
                  operatorCode: "NT",
                  trainStatus: "P",
                  serviceCode: "22222000",
                  category: "OO",
                  signallingId: "2A16",
                  scheduleStartDate: "2026-01-01",
                  scheduleEndDate: "2026-12-31",
                  originTiploc: "PRST",
                  destinationTiploc: "LANCSTR",
                  activatedToday: true,
                  trustId: "729S93MT10",
                  activationDeduced: false,
                  isEffective: true,
                },
              ],
            }),
          ),
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

    expect(
      (await screen.findAllByText(/U12345 · Permanent \(WTT\)/)).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("TRUST activation today")).toBeInTheDocument();
    expect(screen.getByText("729S93MT10")).toBeInTheDocument();
    expect(screen.getAllByText("Preston (PRST)").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Lancaster (LANCSTR)").length).toBeGreaterThanOrEqual(1);
    // late by 3 min
    expect(screen.getByText(/late \(3 min\)/)).toBeInTheDocument();
    // a calling point shows its arrival; a passing point shows its working pass time
    expect(screen.getByText("10:30")).toBeInTheDocument();
    expect(screen.getByText("pass 12:15")).toBeInTheDocument();
    // the honesty note is always shown verbatim
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });

  it("lists candidate schedules without an effective pick when the headcode is ambiguous", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            baseBody({
              berth: "0513",
              description: "3A16",
              headcode: "3A16",
              effective: null,
              candidateSchedules: [
                {
                  scheduleId: "100",
                  trainUid: "C17206",
                  stpIndicator: "P",
                  operatorCode: "NT",
                  trainStatus: "P",
                  serviceCode: "1",
                  category: "OO",
                  signallingId: "3A16",
                  scheduleStartDate: "2026-01-01",
                  scheduleEndDate: "2026-12-31",
                  originTiploc: null,
                  destinationTiploc: null,
                  activatedToday: false,
                  trustId: null,
                  activationDeduced: false,
                  isEffective: false,
                },
                {
                  scheduleId: "101",
                  trainUid: "C17207",
                  stpIndicator: "O",
                  operatorCode: "NT",
                  trainStatus: "P",
                  serviceCode: "1",
                  category: "OO",
                  signallingId: "3A16",
                  scheduleStartDate: "2026-01-01",
                  scheduleEndDate: "2026-12-31",
                  originTiploc: null,
                  destinationTiploc: null,
                  activatedToday: true,
                  trustId: "723A16MG11",
                  activationDeduced: true,
                  isEffective: false,
                },
              ],
            }),
          ),
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

    expect(await screen.findByText(/2 schedules match headcode 3A16 today/)).toBeInTheDocument();
    expect(screen.getByText(/C17206 · Permanent \(WTT\)/)).toBeInTheDocument();
    expect(
      screen.getByText(/C17207 · STP overlay — activated \(deduced\) as 723A16MG11/),
    ).toBeInTheDocument();
    // no effective section
    expect(screen.queryByText("Picked by")).not.toBeInTheDocument();
  });

  it("says so plainly when no garner schedule matches the headcode today", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(baseBody({ berth: "0514", description: "4A16", headcode: "4A16" })),
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

    expect(
      await screen.findByText("No garner schedule matches headcode 4A16 today."),
    ).toBeInTheDocument();
  });

  it("has a close button that calls onClose", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(baseBody()))),
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

  it("polls, so an activation that lands after the popup opened still shows up (regression)", async () => {
    vi.useFakeTimers();
    const before = baseBody({ berth: "0226", description: "9S93", headcode: "9S93" });
    const after = baseBody({
      berth: "0226",
      description: "9S93",
      headcode: "9S93",
      effective: {
        scheduleId: "1",
        trainUid: "U99999",
        stpIndicator: "P",
        operatorCode: "GW",
        trainStatus: "P",
        serviceCode: "9S93000",
        category: "XX",
        originTiploc: null,
        originName: null,
        destinationTiploc: null,
        destinationName: null,
        selectedBy: "trust_activation",
        activation: {
          trustId: "729S93MT10",
          deduced: false,
          activatedAt: "2026-08-10T15:40:21.000Z",
          trainUid: "U99999",
          tocId: "GW",
          scheduleWttId: "U99999",
          scheduleType: "P",
          originDepartureAt: null,
        },
        latestMovement: null,
        locations: [],
      },
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(before))
      .mockResolvedValue(jsonResponse(after));
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
    expect(screen.getByText("No garner schedule matches headcode 9S93 today.")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText("729S93MT10")).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    vi.useRealTimers();
  });
});
