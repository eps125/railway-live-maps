import { describe, expect, it } from "vitest";
import { foldLiveBerthState, type RawCClassRow } from "./liveProjector.js";

function row(
  seq: number,
  eventType: "CA" | "CB" | "CC",
  tdArea: string,
  msg: Record<string, unknown>,
  atIso = "2026-09-01T10:00:00.000Z",
): RawCClassRow {
  return {
    id: String(seq),
    normalized_event_at_utc: new Date(atIso),
    ingestion_sequence: String(seq),
    event_type: eventType,
    td_area: tdArea,
    raw_event_json: { [`${eventType}_MSG`]: msg },
  };
}

describe("foldLiveBerthState", () => {
  it("CC sets the to berth; CB clears the from berth; CA does both", () => {
    const writes = foldLiveBerthState([
      row(1, "CC", "PX", { to: "0001", descr: "1A23" }),
      row(2, "CB", "PX", { from: "0002", descr: "1B99" }),
      row(3, "CA", "PX", { from: "0003", to: "0004", descr: "1C77" }),
    ]);
    // sorted by (td_area, berth)
    expect(writes.map((w) => [w.berth, w.description])).toEqual([
      ["0001", "1A23"],
      ["0002", null],
      ["0003", null],
      ["0004", "1C77"],
    ]);
  });

  it("collapses multiple changes to the same berth to the last one in the batch", () => {
    const writes = foldLiveBerthState([
      row(10, "CC", "PX", { to: "0512", descr: "1S45" }),
      row(11, "CA", "PX", { from: "0512", to: "0513", descr: "1S45" }), // moves out of 0512
      row(12, "CC", "PX", { to: "0512", descr: "2T10" }), // new train into 0512
    ]);
    const b0512 = writes.find((w) => w.berth === "0512");
    expect(b0512).toMatchObject({ description: "2T10", sourceSeq: "12", sourceEventId: "12" });
  });

  it("carries the source lineage of the event that produced each final state", () => {
    const writes = foldLiveBerthState([row(99, "CC", "ZZ", { to: "9999", descr: "9Z99" })]);
    expect(writes[0]).toMatchObject({
      tdArea: "ZZ",
      berth: "9999",
      description: "9Z99",
      eventAt: "2026-09-01T10:00:00.000Z",
      sourceEventId: "99",
      sourceSeq: "99",
    });
  });

  it("treats a missing/blank berth code as no change for that half of a CA", () => {
    const writes = foldLiveBerthState([
      row(1, "CA", "PX", { from: "", to: "0004", descr: "1C77" }),
    ]);
    expect(writes).toEqual([expect.objectContaining({ berth: "0004", description: "1C77" })]);
  });
});
