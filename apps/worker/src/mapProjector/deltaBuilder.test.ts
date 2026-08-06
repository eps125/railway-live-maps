import { describe, expect, it } from "vitest";
import { berthChangesForEvent, buildDeltaMessages } from "./deltaBuilder.js";

describe("berthChangesForEvent", () => {
  it("CA yields both a from-clear and a to-update", () => {
    const changes = berthChangesForEvent({
      messageType: "CA",
      tdArea: "ZZ",
      fromBerth: "0001",
      toBerth: "0002",
      description: "1A23",
      eventAt: "2026-08-05T12:00:00.000Z",
    });
    expect(changes).toEqual([
      { tdArea: "ZZ", berth: "0001", description: null, eventAt: "2026-08-05T12:00:00.000Z" },
      { tdArea: "ZZ", berth: "0002", description: "1A23", eventAt: "2026-08-05T12:00:00.000Z" },
    ]);
  });

  it("CB yields only a from-clear", () => {
    const changes = berthChangesForEvent({
      messageType: "CB",
      tdArea: "ZZ",
      fromBerth: "0001",
      toBerth: null,
      description: "1A23",
      eventAt: "2026-08-05T12:00:00.000Z",
    });
    expect(changes).toEqual([
      { tdArea: "ZZ", berth: "0001", description: null, eventAt: "2026-08-05T12:00:00.000Z" },
    ]);
  });

  it("CC yields only a to-update", () => {
    const changes = berthChangesForEvent({
      messageType: "CC",
      tdArea: "ZZ",
      fromBerth: null,
      toBerth: "0002",
      description: "1A23",
      eventAt: "2026-08-05T12:00:00.000Z",
    });
    expect(changes).toEqual([
      { tdArea: "ZZ", berth: "0002", description: "1A23", eventAt: "2026-08-05T12:00:00.000Z" },
    ]);
  });

  it("a missing from/to berth (mismatch case) produces no change for that half", () => {
    const changes = berthChangesForEvent({
      messageType: "CA",
      tdArea: "ZZ",
      fromBerth: null,
      toBerth: "0002",
      description: "1A23",
      eventAt: "2026-08-05T12:00:00.000Z",
    });
    expect(changes).toEqual([
      { tdArea: "ZZ", berth: "0002", description: "1A23", eventAt: "2026-08-05T12:00:00.000Z" },
    ]);
  });
});

describe("buildDeltaMessages", () => {
  it("builds a berth.updated message per bound map for an occupied change", () => {
    const messages = buildDeltaMessages(
      { tdArea: "ZZ", berth: "0002", description: "1A23", eventAt: "2026-08-05T12:00:00.000Z" },
      [
        { mapSlug: "lancaster", elementId: "berth-1" },
        { mapSlug: "other-map", elementId: "berth-99" },
      ],
      500,
    );
    expect(messages).toEqual([
      {
        mapSlug: "lancaster",
        message: {
          type: "berth.updated",
          sequence: 500,
          eventAt: "2026-08-05T12:00:00.000Z",
          elementId: "berth-1",
          tdArea: "ZZ",
          berth: "0002",
          description: "1A23",
          enteredAt: "2026-08-05T12:00:00.000Z",
          runSummary: null,
        },
      },
      {
        mapSlug: "other-map",
        message: {
          type: "berth.updated",
          sequence: 500,
          eventAt: "2026-08-05T12:00:00.000Z",
          elementId: "berth-99",
          tdArea: "ZZ",
          berth: "0002",
          description: "1A23",
          enteredAt: "2026-08-05T12:00:00.000Z",
          runSummary: null,
        },
      },
    ]);
  });

  it("builds a berth.cleared message for a cleared change (no description/enteredAt fields)", () => {
    const messages = buildDeltaMessages(
      { tdArea: "ZZ", berth: "0001", description: null, eventAt: "2026-08-05T12:00:00.000Z" },
      [{ mapSlug: "lancaster", elementId: "berth-1" }],
      501,
    );
    expect(messages).toEqual([
      {
        mapSlug: "lancaster",
        message: {
          type: "berth.cleared",
          sequence: 501,
          eventAt: "2026-08-05T12:00:00.000Z",
          elementId: "berth-1",
          tdArea: "ZZ",
          berth: "0001",
        },
      },
    ]);
  });

  it("returns an empty array when no map binds the changed berth", () => {
    const messages = buildDeltaMessages(
      { tdArea: "ZZ", berth: "0001", description: "1A23", eventAt: "2026-08-05T12:00:00.000Z" },
      [],
      500,
    );
    expect(messages).toEqual([]);
  });
});
