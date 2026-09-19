import { describe, expect, it } from "vitest";
import {
  detectReceiveSilences,
  resolveSignalStates,
  sByteTrustedAt,
  signalBindingsFromIndex,
  signalStateForBit,
  SIGNAL_GAP_TOLERANCE_MS,
} from "./signalState.js";

const t = (iso: string): Date => new Date(`2026-09-19T${iso}Z`);

describe("signalStateForBit", () => {
  it("activeMeans off: set = off (green), clear = on (red)", () => {
    expect(signalStateForBit(0b0000_0100, 2, "off")).toBe("off");
    expect(signalStateForBit(0b0000_0000, 2, "off")).toBe("on");
  });

  it("activeMeans on: set = on (red), clear = off (green)", () => {
    expect(signalStateForBit(0x80, 7, "on")).toBe("on");
    expect(signalStateForBit(0x7f, 7, "on")).toBe("off");
  });

  it("without an activeMeans the state is blank, never guessed", () => {
    expect(signalStateForBit(0xff, 0, undefined)).toBe("blank");
  });
});

describe("detectReceiveSilences", () => {
  const row = (iso: string, seq: string) => ({ receivedAt: t(iso), ingestionSequence: seq });

  it("reports only silences longer than the tolerance", () => {
    const silences = detectReceiveSilences(null, [
      row("10:00:00", "1"),
      row("10:04:59", "2"), // 4m59s — tolerated
      row("10:10:00", "3"), // 5m01s — a silence
    ]);
    expect(silences).toEqual([
      { startAt: t("10:04:59"), endAt: t("10:10:00"), startSequence: "2", endSequence: "3" },
    ]);
  });

  it("an exactly-5-minute silence is still tolerated", () => {
    expect(detectReceiveSilences(row("10:00:00", "1"), [row("10:05:00", "2")])).toEqual([]);
  });

  it("uses the previous batch's last row across a batch boundary", () => {
    expect(detectReceiveSilences(row("09:00:00", "9"), [row("09:30:00", "10")])).toHaveLength(1);
  });
});

describe("sByteTrustedAt", () => {
  const silence = (iso: string, sequence: string) => ({ at: t(iso), sequence });

  it("trusted with no silences at all", () => {
    expect(sByteTrustedAt("100", [], t("12:00:00"))).toBe(true);
  });

  it("a silence that began after confirmation is tolerated for its first 5 minutes", () => {
    const s = [silence("10:00:00", "150")];
    expect(sByteTrustedAt("100", s, t("10:04:00"))).toBe(true);
    expect(sByteTrustedAt("100", s, t("10:05:00"))).toBe(true);
    expect(sByteTrustedAt("100", s, t("10:05:01"))).toBe(false);
  });

  it("stays untrusted after a long silence ends, until re-confirmed", () => {
    // Silence 10:00-10:20 (recorded gap), byte last confirmed before it.
    expect(sByteTrustedAt("100", [silence("10:00:00", "150")], t("11:00:00"))).toBe(false);
    // Re-confirmed after the silence (sequence past its start): trusted again.
    expect(sByteTrustedAt("200", [silence("10:00:00", "150")], t("11:00:00"))).toBe(true);
  });

  it("a silence starting at the confirming event itself counts (sequence >=)", () => {
    expect(sByteTrustedAt("150", [silence("10:00:00", "150")], t("10:30:00"))).toBe(false);
  });

  it("tolerance is the ADR 0013 5 minutes", () => {
    expect(SIGNAL_GAP_TOLERANCE_MS).toBe(300_000);
  });
});

describe("resolveSignalStates", () => {
  const at = t("12:00:00");
  const binding = {
    elementId: "sig-1",
    tdArea: "M9",
    address: "03",
    bit: 2,
    activeMeans: "off" as const,
  };

  it("unbound signals are blank; a bound, trusted bit decides on/off", () => {
    const result = resolveSignalStates({
      signalElementIds: ["sig-1", "sig-unbound"],
      bindings: [binding],
      byteFacts: new Map([["M9|03", { value: 0b100, confirmedSequence: "10" }]]),
      silences: [],
      at,
    });
    expect(result).toEqual({ "sig-1": { state: "off" }, "sig-unbound": { state: "blank" } });
  });

  it("no fact for the byte (unknown) is blank", () => {
    const result = resolveSignalStates({
      signalElementIds: ["sig-1"],
      bindings: [binding],
      byteFacts: new Map(),
      silences: [],
      at,
    });
    expect(result["sig-1"]).toEqual({ state: "blank" });
  });

  it("a fact not re-confirmed since a >5 min silence is blank", () => {
    const result = resolveSignalStates({
      signalElementIds: ["sig-1"],
      bindings: [binding],
      byteFacts: new Map([["M9|03", { value: 0b100, confirmedSequence: "10" }]]),
      silences: [{ at: t("11:00:00"), sequence: "20" }],
      at,
    });
    expect(result["sig-1"]).toEqual({ state: "blank" });
  });

  it("overlay rows newer than the stored facts win, and re-confirm after a silence", () => {
    const result = resolveSignalStates({
      signalElementIds: ["sig-1"],
      bindings: [binding],
      byteFacts: new Map([["M9|03", { value: 0b100, confirmedSequence: "10" }]]),
      overlayRows: [
        {
          tdArea: "M9",
          eventType: "SG_MSG",
          address: "00",
          data: "00000000",
          ingestionSequence: "30",
        },
      ],
      silences: [{ at: t("11:00:00"), sequence: "20" }],
      at,
    });
    // Byte 03 = 0 from the refresh: bit 2 clear → activeMeans off → on (red).
    expect(result["sig-1"]).toEqual({ state: "on" });
  });

  it("a binding without activeMeans stays blank", () => {
    const { activeMeans: _unused, ...noMeans } = binding;
    const result = resolveSignalStates({
      signalElementIds: ["sig-1"],
      bindings: [noMeans],
      byteFacts: new Map([["M9|03", { value: 0xff, confirmedSequence: "10" }]]),
      silences: [],
      at,
    });
    expect(result["sig-1"]).toEqual({ state: "blank" });
  });
});

describe("signalBindingsFromIndex", () => {
  it("splits keys and attaches activeMeans when present", () => {
    expect(
      signalBindingsFromIndex({ "M9|0A|3": "sig-1", "M9|0B|0": "sig-2" }, { "M9|0A|3": "off" }),
    ).toEqual([
      { elementId: "sig-1", tdArea: "M9", address: "0A", bit: 3, activeMeans: "off" },
      { elementId: "sig-2", tdArea: "M9", address: "0B", bit: 0 },
    ]);
  });
});
