import { describe, expect, it } from "vitest";
import {
  buildSignalDeltas,
  foldLiveBerthState,
  publishInSequenceOrder,
  type BindingsCache,
  type CachedInferredInput,
  type RawCClassRow,
  type RawSClassRow,
} from "./liveProjector.js";

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

describe("publishInSequenceOrder (Milestone 36b)", () => {
  it("publishes a batch's deltas strictly in sequence order, whatever order they were built in", async () => {
    // foldLiveBerthState orders writes by (td_area, berth) for lock ordering — so two berths
    // changed in one frame can come out sequence-descending. A client drops its socket on any
    // sequence regression, so publishing must re-sort (regression test).
    const sent: number[] = [];
    const redis = {
      publishDeltaIfNewer: async (_slug: string, _key: string, sequence: number) => {
        sent.push(sequence);
        return 1;
      },
    };
    const published = await publishInSequenceOrder(redis, [
      { mapSlug: "m", key: "PX 0002", sequence: 30, message: "{}" },
      { mapSlug: "m", key: "S PX 03 2", sequence: 20, message: "{}" },
      { mapSlug: "m", key: "PX 0001", sequence: 10, message: "{}" },
    ]);
    expect(sent).toEqual([10, 20, 30]);
    expect(published).toBe(3);
  });
});

describe("buildSignalDeltas (Milestone 36b)", () => {
  function cacheWith(
    signals: Record<
      string,
      Array<{ mapSlug: string; elementId: string; bit: number; activeMeans: "on" | "off" | null }>
    >,
    barriers: Record<
      string,
      Array<{ mapSlug: string; elementId: string; bit: number; activeMeans: "up" | "down" | null }>
    > = {},
  ): BindingsCache {
    return {
      getSignals: async (tdArea: string, address: string) => signals[`${tdArea} ${address}`] ?? [],
      // Milestone 55 / ADR 0014: the delta builder reads barrier bindings off the same cache.
      getBarriers: async (tdArea: string, address: string) =>
        barriers[`${tdArea} ${address}`] ?? [],
      // Milestone 59: no inferred crossings in these tests.
      getInferredInputs: async () => [],
      inferredCrossingInputs: () => [],
      seededInputByte: () => undefined,
    } as unknown as BindingsCache;
  }
  const sRow = (seq: number, type: string, address: string, data: string): RawSClassRow => ({
    id: String(seq),
    normalized_event_at_utc: new Date("2026-09-19T12:00:00Z"),
    ingestion_sequence: String(seq),
    event_type: type,
    td_area: "Q1",
    raw_event_json: { [type]: { area_id: "Q1", address, data } },
  });

  it("emits the bound bit's state through activeMeans, and only when it changes", async () => {
    const cache = cacheWith({
      "Q1 03": [{ mapSlug: "bpool", elementId: "sig-a", bit: 2, activeMeans: "off" }],
    });
    const pending = await buildSignalDeltas(cache, [
      sRow(100, "SF_MSG", "03", "04"), // bit 2 set → off
      sRow(101, "SF_MSG", "03", "05"), // bit 2 still set → no change, nothing sent
      sRow(102, "SG_MSG", "00", "00000000"), // refresh: byte 03 = 0 → on
    ]);
    expect(pending.map((p) => [p.sequence, p.key, JSON.parse(p.message).state])).toEqual([
      [100, "S Q1 03 2", "off"],
      [102, "S Q1 03 2", "on"],
    ]);
    expect(JSON.parse(pending[0]!.message)).toMatchObject({
      type: "signal.updated",
      elementId: "sig-a",
      tdArea: "Q1",
      address: "03",
      bit: 2,
    });
  });

  it("a binding without activeMeans publishes blank, and malformed rows are skipped", async () => {
    const cache = cacheWith({
      "Q1 07": [{ mapSlug: "bpool", elementId: "sig-b", bit: 0, activeMeans: null }],
    });
    const pending = await buildSignalDeltas(cache, [
      sRow(200, "SF_MSG", "07", "zz"),
      sRow(201, "SF_MSG", "07", "01"),
    ]);
    expect(pending.map((p) => JSON.parse(p.message).state)).toEqual(["blank"]);
  });
});

describe("buildSignalDeltas — inferred crossings (Milestone 59 / ADR 0015)", () => {
  // Carleton-style: two protecting signals in different bytes of one area; set bit = signal off.
  // Each test uses its own crossing id — the builder's de-dup memory is per process.
  function carletonInputs(elementId: string): CachedInferredInput[] {
    return [
      { mapSlug: "bpool", elementId, tdArea: "M9", address: "07", bit: 4, activeMeans: "off" },
      { mapSlug: "bpool", elementId, tdArea: "M9", address: "06", bit: 6, activeMeans: "off" },
    ];
  }
  function inferredCache(
    inputs: CachedInferredInput[],
    seeded: Record<string, number> = {},
  ): BindingsCache {
    return {
      getSignals: async () => [],
      getBarriers: async () => [],
      getInferredInputs: async (tdArea: string, address: string) =>
        inputs.filter((i) => i.tdArea === tdArea && i.address === address),
      inferredCrossingInputs: (mapSlug: string, elementId: string) =>
        inputs.filter((i) => i.mapSlug === mapSlug && i.elementId === elementId),
      seededInputByte: (tdArea: string, address: string) => seeded[`${tdArea} ${address}`],
    } as unknown as BindingsCache;
  }
  const row = (seq: number, address: string, data: string): RawSClassRow => ({
    id: String(seq),
    normalized_event_at_utc: new Date("2026-09-21T12:00:00Z"),
    ingestion_sequence: String(seq),
    event_type: "SF_MSG",
    td_area: "M9",
    raw_event_json: { SF_MSG: { area_id: "M9", address, data } },
  });
  const states = (pending: Awaited<ReturnType<typeof buildSignalDeltas>>) =>
    pending.map((p) => [p.sequence, p.key, JSON.parse(p.message).state]);

  it("follows the owner's rule: either signal at proceed = lowered, both at danger = raised", async () => {
    const cache = inferredCache(carletonInputs("lx-a"), { "M9 07": 0x00, "M9 06": 0x00 });
    const pending = await buildSignalDeltas(cache, [
      row(9001, "07", "10"), // S3879 off -> down
      row(9002, "07", "00"), // S3879 back on; S3870 on (seeded) -> up
      row(9003, "06", "40"), // S3870 off -> down
      row(9004, "06", "40"), // restated, unchanged -> nothing sent
      row(9005, "06", "00"), // both on -> up
    ]);
    expect(states(pending)).toEqual([
      [9001, "I lx-a", "down"],
      [9002, "I lx-a", "up"],
      [9003, "I lx-a", "down"],
      [9005, "I lx-a", "up"],
    ]);
    expect(JSON.parse(pending[0]!.message)).toMatchObject({
      type: "crossing.updated",
      elementId: "lx-a",
      tdArea: "M9",
      address: "07",
      bit: 4,
    });
  });

  it("never claims raised while the other signal is unknown", async () => {
    // Nothing seeded and nothing seen for byte 06: S3870 is unknown, so S3879 at danger on its
    // own is not enough for "up".
    const pending = await buildSignalDeltas(inferredCache(carletonInputs("lx-b")), [
      row(9101, "07", "00"),
      row(9102, "06", "00"), // now both known at danger
    ]);
    expect(states(pending)).toEqual([
      [9101, "I lx-b", "blank"],
      [9102, "I lx-b", "up"],
    ]);
  });

  it("uses the byte seeded at reload for an input it hasn't seen live yet", async () => {
    // After a restart: S3870 is off according to td_s_current_state, so a restated S3879 at danger
    // still leaves the crossing down rather than waiting ~2h for byte 06's next refresh.
    const cache = inferredCache(carletonInputs("lx-c"), { "M9 06": 0x40 });
    const pending = await buildSignalDeltas(cache, [row(9201, "07", "00")]);
    expect(states(pending)).toEqual([[9201, "I lx-c", "down"]]);
  });
});
