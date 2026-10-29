import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeSClassPayload,
  foldSClassEvents,
  isStaleRefreshByte,
  sBit,
  sBits,
  sByteKey,
  sClassMessageType,
  trackRefreshSweep,
  type SByteState,
  type SClassFoldEvent,
} from "./sClass.js";

/** 58 real M9 (Blackpool) S-Class messages, in ingestion order, captured 2026-09-18 19:21:00 -
 * 19:24:25 UTC: a full refresh (SG 00-10 + SH 14), 46 SF updates, then the next full refresh. */
const M9_WINDOW = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../fixtures/td/m9-refresh-window-2026-09-18.json", import.meta.url)),
    "utf8",
  ),
) as Array<Record<string, { area_id: string; address: string; data: string; time: string }>>;

/** 35 real Q1 S-Class messages, in ingestion order, 2026-10-27 13:15:09 - 13:15:28 UTC: one full
 * refresh (SG 00 at 13:15:18 .. SH 70 at 13:15:23; some unrelated chunks are absent because the
 * capture kept only refresh rows and SFs for the affected bytes) with four SF updates that landed
 * just before or during it — bytes 55, 4A, 58 and 69 — each of whose later chunk carried the
 * pre-update value, then the next SF for byte 58. */
const Q1_STALE_REFRESH = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../fixtures/td/q1-stale-refresh-2026-10-27.json", import.meta.url)),
    "utf8",
  ),
) as typeof M9_WINDOW;

function foldEventsFrom(
  messages: typeof M9_WINDOW,
  firstSequence = 1,
): { events: SClassFoldEvent[]; types: string[] } {
  const events: SClassFoldEvent[] = [];
  const types: string[] = [];
  messages.forEach((message, index) => {
    const [wrapper, payload] = Object.entries(message)[0]!;
    const decoded = decodeSClassPayload(wrapper, payload.address, payload.data);
    if (!decoded.ok) throw new Error(`fixture message ${index} failed: ${decoded.errorCode}`);
    types.push(wrapper);
    events.push({
      tdArea: payload.area_id,
      sourceKind: decoded.sourceKind,
      messageType: sClassMessageType(wrapper) ?? undefined,
      bytes: decoded.bytes,
      eventId: String(index + 1),
      eventNormalizedAt: new Date(Number(payload.time)),
      ingestionSequence: String(firstSequence + index),
    });
  });
  return { events, types };
}

describe("decodeSClassPayload", () => {
  it("SF: one byte at the hex address", () => {
    expect(decodeSClassPayload("SF_MSG", "0A", "3F")).toEqual({
      ok: true,
      sourceKind: "update",
      bytes: [{ address: "0A", value: 0x3f }],
    });
  });

  it("SG: four bytes from the address, first byte first (real M9 SG 04)", () => {
    expect(decodeSClassPayload("SG_MSG", "04", "FEFFBFCF")).toEqual({
      ok: true,
      sourceKind: "refresh",
      bytes: [
        { address: "04", value: 0xfe },
        { address: "05", value: 0xff },
        { address: "06", value: 0xbf },
        { address: "07", value: 0xcf },
      ],
    });
  });

  it("SH: final refresh chunk carries real data, decoded like SG", () => {
    const result = decodeSClassPayload("SH", "14", "00010000");
    expect(result).toMatchObject({ ok: true, sourceKind: "refresh" });
    if (result.ok) expect(result.bytes.map((b) => b.address)).toEqual(["14", "15", "16", "17"]);
    if (result.ok) expect(result.bytes[1]?.value).toBe(1);
  });

  it("canonicalises lowercase hex addresses to uppercase", () => {
    const result = decodeSClassPayload("SF_MSG", "0a", "ff");
    expect(result).toMatchObject({ ok: true, bytes: [{ address: "0A", value: 255 }] });
  });

  it.each([
    ["SX_MSG", "00", "00", "unknown_message_type"],
    ["SF_MSG", "0", "00", "invalid_address"],
    ["SF_MSG", "0G", "00", "invalid_address"],
    ["SF_MSG", 5, "00", "invalid_address"],
    ["SF_MSG", "00", "ZZ", "invalid_data"],
    ["SF_MSG", "00", null, "invalid_data"],
    ["SF_MSG", "00", "0000", "data_length_mismatch"],
    ["SG_MSG", "00", "00", "data_length_mismatch"],
    ["SG_MSG", "FE", "00000000", "address_overflow"],
  ])("%s address=%s data=%s -> %s", (type, address, data, errorCode) => {
    expect(decodeSClassPayload(type, address, data)).toEqual({ ok: false, errorCode });
  });
});

describe("sBit / sBits", () => {
  it("bit 0 is the least significant bit (SOP numbering)", () => {
    expect(sBit(0x01, 0)).toBe(true);
    expect(sBit(0x01, 7)).toBe(false);
    expect(sBit(0x80, 7)).toBe(true);
    expect(sBits(0x66)).toEqual([false, true, true, false, false, true, true, false]);
  });
});

describe("foldSClassEvents", () => {
  const at = new Date("2026-09-18T19:00:00Z");
  const event = (
    address: string,
    value: number,
    sequence: string,
    sourceKind: "update" | "refresh" = "update",
  ): SClassFoldEvent => ({
    tdArea: "M9",
    sourceKind,
    bytes: [{ address, value }],
    eventId: sequence,
    eventNormalizedAt: at,
    ingestionSequence: sequence,
  });

  it("first observation yields all 8 bits with previousValue null", () => {
    const result = foldSClassEvents(new Map(), [event("03", 0x01, "10")]);
    expect(result.transitions).toHaveLength(8);
    expect(result.transitions.every((t) => t.previousValue === null)).toBe(true);
    expect(result.transitions[0]).toMatchObject({ bitIndex: 0, newValue: true });
    expect(result.byteWrites).toEqual([
      expect.objectContaining({ address: "03", value: 1, ingestionSequence: "10" }),
    ]);
  });

  it("later updates yield only the bits that changed", () => {
    const prior = new Map<string, SByteState>([
      [sByteKey("M9", "03"), { value: 0x01, sourceIngestionSequence: "10" }],
    ]);
    const result = foldSClassEvents(prior, [event("03", 0x05, "11"), event("03", 0x04, "12")]);
    expect(result.transitions.map((t) => [t.bitIndex, t.previousValue, t.newValue])).toEqual([
      [2, false, true],
      [0, true, false],
    ]);
    expect(result.byteWrites).toEqual([expect.objectContaining({ value: 0x04 })]);
    expect(result.refreshMismatches).toBe(0);
  });

  it("an unchanged byte yields no transitions but is still written (re-confirmed)", () => {
    const prior = new Map<string, SByteState>([
      [sByteKey("M9", "03"), { value: 0x01, sourceIngestionSequence: "10" }],
    ]);
    const result = foldSClassEvents(prior, [event("03", 0x01, "11", "refresh")]);
    expect(result.transitions).toEqual([]);
    expect(result.byteWrites).toEqual([
      expect.objectContaining({
        ingestionSequence: "11",
        sourceKind: "refresh",
        lastRefreshAt: at,
      }),
    ]);
  });

  it("a refresh that changes a known byte counts as a mismatch (missed SF)", () => {
    const prior = new Map<string, SByteState>([
      [sByteKey("M9", "03"), { value: 0x01, sourceIngestionSequence: "10" }],
    ]);
    const result = foldSClassEvents(prior, [event("03", 0x03, "11", "refresh")]);
    expect(result.refreshMismatches).toBe(1);
    expect(result.transitions).toEqual([
      expect.objectContaining({ bitIndex: 1, sourceKind: "refresh", previousValue: false }),
    ]);
  });

  it("ignores events not newer than the known state (replay safety)", () => {
    const prior = new Map<string, SByteState>([
      [sByteKey("M9", "03"), { value: 0x01, sourceIngestionSequence: "20" }],
    ]);
    const result = foldSClassEvents(prior, [event("03", 0xff, "19")]);
    expect(result.transitions).toEqual([]);
    expect(result.byteWrites).toEqual([]);
  });

  it("keys state per area — the same address in two areas is independent", () => {
    const result = foldSClassEvents(new Map(), [
      event("03", 0x01, "1"),
      { ...event("03", 0x01, "2"), tdArea: "R1" },
    ]);
    expect(result.byteWrites).toHaveLength(2);
    expect(result.transitions).toHaveLength(16);
  });

  it("real M9: refresh + SF stream folds to exactly the next refresh's state", () => {
    const { events, types } = foldEventsFrom(M9_WINDOW);
    // The fixture's second refresh starts at the second SG for address 00.
    const secondRefreshStart = types.findIndex(
      (type, i) => i > 0 && type === "SG_MSG" && events[i]!.bytes[0]!.address === "00",
    );
    expect(secondRefreshStart).toBeGreaterThan(0);

    const beforeSecondRefresh = foldSClassEvents(new Map(), events.slice(0, secondRefreshStart));
    const secondRefresh = foldSClassEvents(new Map(), events.slice(secondRefreshStart));

    const stateBefore = new Map(
      beforeSecondRefresh.byteWrites.map((w) => [w.address, w.value] as const),
    );
    for (const write of secondRefresh.byteWrites) {
      expect({ address: write.address, value: stateBefore.get(write.address) }).toEqual({
        address: write.address,
        value: write.value,
      });
    }

    // And folding the whole window in one go reports no refresh mismatches.
    expect(foldSClassEvents(new Map(), events).refreshMismatches).toBe(0);
  });
});

describe("stale refresh chunks (2026-10-28 refresh-glitch investigation)", () => {
  const t = (s: number) => new Date(Date.UTC(2026, 9, 27, 13, 15, s));
  const ev = (
    address: string,
    value: number,
    sequence: string,
    second: number,
    messageType: "SF" | "SG" | "SH" = "SF",
  ): SClassFoldEvent => ({
    tdArea: "Q1",
    sourceKind: messageType === "SF" ? "update" : "refresh",
    messageType,
    bytes: [{ address, value }],
    eventId: sequence,
    eventNormalizedAt: t(second),
    ingestionSequence: sequence,
  });
  const updatedAt = (value: number, sequence: string, second: number): SByteState => ({
    value,
    sourceIngestionSequence: sequence,
    sourceKind: "update",
    statedAt: t(second),
  });

  it("real Q1: chunks carrying pre-update values are skipped, the updates stand", () => {
    // Prior state as it stood before the window: each byte's pre-update value, stated long ago.
    const prior = new Map<string, SByteState>(
      (
        [
          ["4A", 0x02],
          ["55", 0xf8],
          ["58", 0x41],
          ["69", 0xff],
        ] as const
      ).map(([address, value]) => [
        sByteKey("Q1", address),
        { value, sourceIngestionSequence: "0", sourceKind: "update", statedAt: t(-600) },
      ]),
    );
    const { events } = foldEventsFrom(Q1_STALE_REFRESH);
    const result = foldSClassEvents(prior, events);

    const final = new Map(result.byteWrites.map((w) => [w.address, w.value] as const));
    expect(final.get("4A")).toBe(0x00);
    expect(final.get("55")).toBe(0xd8);
    expect(final.get("69")).toBe(0xff);
    // Byte 58: the SF at :28 restates 60 over the SF's 40, so only bit 5 changes — never bit 0.
    expect(final.get("58")).toBe(0x60);
    const touched = (address: string) =>
      result.transitions
        .filter((tr) => tr.address === address && tr.previousValue !== null)
        .map((tr) => [tr.bitIndex, tr.newValue, tr.sourceKind]);
    expect(touched("58")).toEqual([
      [0, false, "update"],
      [5, true, "update"],
    ]);
    expect(touched("4A")).toEqual([[1, false, "update"]]);
    expect(touched("55")).toEqual([[5, false, "update"]]);
    expect(touched("69")).toEqual([
      [6, false, "update"],
      [6, true, "update"],
    ]);
    expect(result.staleRefreshBytes).toBe(4);
    expect(result.refreshMismatches).toBe(0);
    expect(result.openSweeps.size).toBe(0); // the SH closed it
  });

  it("a refresh disagreeing with an update from before the sweep is applied (missed SF)", () => {
    const prior = new Map([[sByteKey("Q1", "03"), updatedAt(0x01, "1", 10)]]);
    const result = foldSClassEvents(prior, [
      ev("00", 0, "2", 15, "SG"),
      ev("03", 0x03, "3", 16, "SG"),
    ]);
    expect(result.staleRefreshBytes).toBe(0);
    expect(result.refreshMismatches).toBe(1);
    expect(result.byteWrites.find((w) => w.address === "03")?.value).toBe(0x03);
  });

  it("an update in the second before the sweep's first chunk still wins", () => {
    const prior = new Map([[sByteKey("Q1", "03"), updatedAt(0x01, "1", 14)]]);
    const result = foldSClassEvents(prior, [
      ev("00", 0, "2", 15, "SG"),
      ev("03", 0x03, "3", 16, "SG"),
    ]);
    expect(result.staleRefreshBytes).toBe(1);
    expect(result.byteWrites.find((w) => w.address === "03")).toBeUndefined();
  });

  it("a chunk agreeing with a recent update is applied as a re-confirmation", () => {
    const prior = new Map([[sByteKey("Q1", "03"), updatedAt(0x01, "1", 16)]]);
    const result = foldSClassEvents(prior, [
      ev("00", 0, "2", 15, "SG"),
      ev("03", 0x01, "3", 17, "SG"),
    ]);
    expect(result.staleRefreshBytes).toBe(0);
    expect(result.byteWrites.find((w) => w.address === "03")).toMatchObject({
      sourceKind: "refresh",
      lastRefreshAt: t(17),
    });
  });

  it("a sweep split across folds keeps its start via openSweeps", () => {
    const first = foldSClassEvents(new Map(), [ev("00", 0, "1", 10, "SG")]);
    expect(first.openSweeps.get("Q1")).toEqual(t(10));
    // The update at :12 is newer than the snapshot begun at :10, so the :20 chunk is stale.
    const prior = new Map([[sByteKey("Q1", "40"), updatedAt(0x01, "2", 12)]]);
    const second = foldSClassEvents(prior, [ev("40", 0x00, "3", 20, "SG")], first.openSweeps);
    expect(second.staleRefreshBytes).toBe(1);
    // Without the carried sweep the chunk would open its own at :20 and wrongly be applied.
    expect(foldSClassEvents(prior, [ev("40", 0x00, "3", 20, "SG")]).staleRefreshBytes).toBe(0);
  });

  it("prior state with no source kind (older callers) never suppresses a refresh", () => {
    const prior = new Map([[sByteKey("Q1", "03"), { value: 0x01, sourceIngestionSequence: "1" }]]);
    const result = foldSClassEvents(prior, [
      ev("00", 0, "2", 15, "SG"),
      ev("03", 0x03, "3", 15, "SG"),
    ]);
    expect(result.staleRefreshBytes).toBe(0);
  });

  it("trackRefreshSweep: 00 opens, SH closes, updates have no sweep", () => {
    const open = new Map<string, Date>();
    expect(trackRefreshSweep(open, ev("01", 0, "1", 1))).toBeNull();
    expect(trackRefreshSweep(open, ev("00", 0, "2", 2, "SG"))).toEqual(t(2));
    expect(trackRefreshSweep(open, ev("04", 0, "3", 4, "SG"))).toEqual(t(2));
    expect(trackRefreshSweep(open, ev("08", 0, "4", 5, "SH"))).toEqual(t(2));
    expect(open.size).toBe(0);
    // A chunk with no sweep open (one that didn't start at 00) opens its own.
    expect(trackRefreshSweep(open, ev("10", 0, "5", 9, "SG"))).toEqual(t(9));
  });

  it("isStaleRefreshByte only fires for a disagreeing update at or after the sweep lead", () => {
    expect(isStaleRefreshByte(undefined, 1, t(10))).toBe(false);
    expect(isStaleRefreshByte(updatedAt(1, "1", 9), 1, t(10))).toBe(false);
    expect(isStaleRefreshByte(updatedAt(1, "1", 9), 2, t(10))).toBe(true);
    expect(isStaleRefreshByte(updatedAt(1, "1", 8), 2, t(10))).toBe(false);
    expect(isStaleRefreshByte({ ...updatedAt(1, "1", 12), sourceKind: "refresh" }, 2, t(10))).toBe(
      false,
    );
  });
});
