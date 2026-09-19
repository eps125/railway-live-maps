import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decodeSClassPayload,
  foldSClassEvents,
  sBit,
  sBits,
  sByteKey,
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
