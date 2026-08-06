import { describe, expect, it } from "vitest";
import {
  applyActivation,
  applyMovement,
  applyCancellation,
  applyReinstatement,
  applyChangeOfOrigin,
  applyChangeOfLocation,
  applyChangeOfIdentity,
  applyUnidentified,
  type TrainRunSnapshot,
} from "./runReducer.js";

const RUN: TrainRunSnapshot = { id: "run-1", lifecycleState: "activated" };

describe("applyActivation", () => {
  it("creates a run when none exists yet", () => {
    const result = applyActivation({
      trustTrainId: "2A1612AA26",
      serviceDate: "2026-08-10",
      signallingId: "2A16",
      activatedAt: "2026-08-10T10:00:00.000Z",
      originDepartureAt: "2026-08-10T10:01:00.000Z",
      callType: "AUTOMATIC",
      callMode: "NORMAL",
      operatorCode: "NT",
      serviceCode: "22222000",
      existingRun: null,
    });
    expect(result.effects).toEqual([
      {
        kind: "createRun",
        trustTrainId: "2A1612AA26",
        serviceDate: "2026-08-10",
        signallingId: "2A16",
        activatedAt: "2026-08-10T10:00:00.000Z",
        originDepartureAt: "2026-08-10T10:01:00.000Z",
        callType: "AUTOMATIC",
        callMode: "NORMAL",
        operatorCode: "NT",
        serviceCode: "22222000",
        lifecycleState: "activated",
        lastEventAt: "2026-08-10T10:00:00.000Z",
      },
    ]);
  });

  it("redelivery of an activation for an already-activated identity is a no-op", () => {
    const result = applyActivation({
      trustTrainId: "2A1612AA26",
      serviceDate: "2026-08-10",
      signallingId: "2A16",
      activatedAt: "2026-08-10T10:00:00.000Z",
      originDepartureAt: null,
      callType: null,
      callMode: null,
      operatorCode: null,
      serviceCode: null,
      existingRun: RUN,
    });
    expect(result.effects).toEqual([]);
  });
});

describe("applyMovement", () => {
  it("advances last_event_at for an existing run", () => {
    const result = applyMovement({ run: RUN, eventAt: "2026-08-10T10:05:00.000Z" });
    expect(result.effects).toEqual([
      { kind: "touchLastEventAt", runId: "run-1", lastEventAt: "2026-08-10T10:05:00.000Z" },
    ]);
  });

  it("is a defensive no-op when no matching run exists — never fabricates one", () => {
    const result = applyMovement({ run: null, eventAt: "2026-08-10T10:05:00.000Z" });
    expect(result.effects).toEqual([]);
  });
});

describe("cancel-then-reinstate", () => {
  it("Cancellation moves the run to cancelled", () => {
    const result = applyCancellation({ run: RUN, eventAt: "2026-08-10T10:10:00.000Z" });
    expect(result.effects).toEqual([
      {
        kind: "setLifecycleState",
        runId: "run-1",
        lifecycleState: "cancelled",
        lastEventAt: "2026-08-10T10:10:00.000Z",
      },
    ]);
  });

  it("Reinstatement moves a cancelled run back to activated, not a separate state", () => {
    const cancelled: TrainRunSnapshot = { id: "run-1", lifecycleState: "cancelled" };
    const result = applyReinstatement({ run: cancelled, eventAt: "2026-08-10T10:20:00.000Z" });
    expect(result.effects).toEqual([
      {
        kind: "setLifecycleState",
        runId: "run-1",
        lifecycleState: "activated",
        lastEventAt: "2026-08-10T10:20:00.000Z",
      },
    ]);
  });
});

describe("applyChangeOfOrigin / applyChangeOfLocation", () => {
  it("both only touch last_event_at in this MVP", () => {
    const originResult = applyChangeOfOrigin({ run: RUN, eventAt: "2026-08-10T10:15:00.000Z" });
    const locationResult = applyChangeOfLocation({
      run: RUN,
      eventAt: "2026-08-10T10:16:00.000Z",
    });
    expect(originResult.effects).toEqual([
      { kind: "touchLastEventAt", runId: "run-1", lastEventAt: "2026-08-10T10:15:00.000Z" },
    ]);
    expect(locationResult.effects).toEqual([
      { kind: "touchLastEventAt", runId: "run-1", lastEventAt: "2026-08-10T10:16:00.000Z" },
    ]);
  });
});

describe("applyChangeOfIdentity", () => {
  it("supersedes the old identity and carries forward signalling/operator/service codes", () => {
    const result = applyChangeOfIdentity({
      oldRun: RUN,
      newTrustTrainId: "2A9912AA26",
      serviceDate: "2026-08-10",
      signallingId: "2A99",
      operatorCode: "NT",
      serviceCode: "22222000",
      eventAt: "2026-08-10T10:25:00.000Z",
    });
    expect(result.effects).toEqual([
      {
        kind: "supersedeWithNewIdentity",
        oldRunId: "run-1",
        newTrustTrainId: "2A9912AA26",
        serviceDate: "2026-08-10",
        signallingId: "2A99",
        operatorCode: "NT",
        serviceCode: "22222000",
        lastEventAt: "2026-08-10T10:25:00.000Z",
      },
    ]);
  });

  it("is a defensive no-op when the old identity's run was never created", () => {
    const result = applyChangeOfIdentity({
      oldRun: null,
      newTrustTrainId: "2A9912AA26",
      serviceDate: "2026-08-10",
      signallingId: null,
      operatorCode: null,
      serviceCode: null,
      eventAt: "2026-08-10T10:25:00.000Z",
    });
    expect(result.effects).toEqual([]);
  });
});

describe("applyUnidentified", () => {
  it("creates a minimal unidentified run when none exists yet", () => {
    const result = applyUnidentified({
      trustTrainId: "UNKNOWNXXX",
      serviceDate: "2026-08-10",
      existingRun: null,
      eventAt: "2026-08-10T10:30:00.000Z",
    });
    expect(result.effects).toEqual([
      {
        kind: "createRun",
        trustTrainId: "UNKNOWNXXX",
        serviceDate: "2026-08-10",
        signallingId: null,
        activatedAt: null,
        originDepartureAt: null,
        callType: null,
        callMode: null,
        operatorCode: null,
        serviceCode: null,
        lifecycleState: "unidentified",
        lastEventAt: "2026-08-10T10:30:00.000Z",
      },
    ]);
  });

  it("just advances last_event_at when an unidentified run already exists for this identity", () => {
    const existing: TrainRunSnapshot = { id: "run-2", lifecycleState: "unidentified" };
    const result = applyUnidentified({
      trustTrainId: "UNKNOWNXXX",
      serviceDate: "2026-08-10",
      existingRun: existing,
      eventAt: "2026-08-10T10:35:00.000Z",
    });
    expect(result.effects).toEqual([
      { kind: "touchLastEventAt", runId: "run-2", lastEventAt: "2026-08-10T10:35:00.000Z" },
    ]);
  });
});
