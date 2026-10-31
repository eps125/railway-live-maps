import { describe, expect, it } from "vitest";
import { TD_INGEST_LAG_LOSS_REASON, TD_INGEST_LAG_REASON } from "@railway/domain";
import { lagAction } from "./ingestLagAlarm.js";

const NOW = new Date("2026-10-31T06:45:00Z");

describe("lagAction (2026-10-31)", () => {
  it("does nothing while the recorder keeps up", () => {
    expect(lagAction(3_000, null, NOW)).toEqual({ kind: "none" });
    expect(lagAction(59_999, null, NOW)).toEqual({ kind: "none" });
    expect(lagAction(null, null, NOW)).toEqual({ kind: "none" });
  });

  it("opens an amber outage at 60 s behind, dated from when the lag began", () => {
    expect(lagAction(81_600, null, NOW)).toEqual({
      kind: "open",
      reason: TD_INGEST_LAG_REASON,
      startedAt: new Date("2026-10-31T06:43:38.400Z"),
    });
  });

  it("opens straight to red, or escalates, near the broker's five-minute limit", () => {
    expect(lagAction(301_200, null, NOW)).toMatchObject({
      kind: "open",
      reason: TD_INGEST_LAG_LOSS_REASON,
    });
    expect(lagAction(240_000, TD_INGEST_LAG_REASON, NOW)).toEqual({ kind: "escalate" });
    expect(lagAction(300_000, TD_INGEST_LAG_LOSS_REASON, NOW)).toEqual({ kind: "none" });
  });

  it("stays open until the lag is under 15 s, and never steps red back to amber", () => {
    expect(lagAction(30_000, TD_INGEST_LAG_LOSS_REASON, NOW)).toEqual({ kind: "none" });
    expect(lagAction(14_999, TD_INGEST_LAG_LOSS_REASON, NOW)).toEqual({ kind: "close" });
    expect(lagAction(2_000, TD_INGEST_LAG_REASON, NOW)).toEqual({ kind: "close" });
  });
});
