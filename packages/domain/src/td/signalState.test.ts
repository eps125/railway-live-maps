import { describe, expect, it } from "vitest";
import {
  inferredBarrierState,
  inferredCrossingStates,
  inferredInputBindings,
  inferredInputElementId,
  signalStateForBit as signalStateForBitForInference,
  detectReceiveSilences,
  resolveSignalStates,
  sByteTrustedAt,
  signalBindingsFromIndex,
  signalStateForBit,
  SIGNAL_GAP_TOLERANCE_MS,
  barrierActiveMeansAsSignal,
  barrierBindingsFromIndex,
  barrierStateFromSignalState,
  routeActiveMeansAsSignal,
  routeBindingsFromIndex,
  routeStateFromSignalState,
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

describe("barrier vocabulary (Milestone 55 / ADR 0014)", () => {
  it("maps a barrier's activeMeans onto the shared bit machinery", () => {
    // down is the restrictive state, exactly as a signal that is on is.
    expect(barrierActiveMeansAsSignal("down")).toBe("on");
    expect(barrierActiveMeansAsSignal("up")).toBe("off");
  });

  it("maps the machinery's result back, keeping blank as blank", () => {
    expect(barrierStateFromSignalState("on")).toBe("down");
    expect(barrierStateFromSignalState("off")).toBe("up");
    // blank must never become "up": it means no information (ADR 0014 decision 1).
    expect(barrierStateFromSignalState("blank")).toBe("blank");
  });

  it("round-trips a bound bit into the barrier's own vocabulary", () => {
    const value = 0b0000_0100;
    const down = barrierStateFromSignalState(
      signalStateForBit(value, 2, barrierActiveMeansAsSignal("down")),
    );
    expect(down).toBe("down");
    const up = barrierStateFromSignalState(
      signalStateForBit(value, 3, barrierActiveMeansAsSignal("down")),
    );
    expect(up).toBe("up");
  });

  it("reads a bundle's barrier index, and a bundle without one as empty", () => {
    expect(barrierBindingsFromIndex({ "M9|03|2": "lx-1" }, { "M9|03|2": "down" })).toEqual([
      { elementId: "lx-1", tdArea: "M9", address: "03", bit: 2, activeMeans: "on" },
    ]);

    // A version published before barriers existed is immutable and has neither key.
    expect(barrierBindingsFromIndex(undefined, undefined)).toEqual([]);

    // No recorded activeMeans -> no activeMeans -> blank downstream, never a guess.
    expect(barrierBindingsFromIndex({ "M9|03|2": "lx-1" }, undefined)).toEqual([
      { elementId: "lx-1", tdArea: "M9", address: "03", bit: 2 },
    ]);
  });
});

describe("inferred crossing state (Milestone 59 / ADR 0015)", () => {
  it("is down if any protecting signal is at proceed", () => {
    expect(inferredBarrierState(["off", "on"])).toBe("down");
    expect(inferredBarrierState(["on", "off"])).toBe("down");
    expect(inferredBarrierState(["off", "off"])).toBe("down");
    // A signal at proceed proves the crossing down even if the other one is unknown.
    expect(inferredBarrierState(["off", "blank"])).toBe("down");
  });

  it("is up only when every protecting signal is confirmed at danger", () => {
    expect(inferredBarrierState(["on", "on"])).toBe("up");
    expect(inferredBarrierState(["on"])).toBe("up");
  });

  it("is blank when an input is unknown and none is at proceed — never up on a guess", () => {
    expect(inferredBarrierState(["on", "blank"])).toBe("blank");
    expect(inferredBarrierState(["blank", "blank"])).toBe("blank");
    expect(inferredBarrierState([])).toBe("blank");
  });

  it("reproduces the owner's Carleton rule from raw bits (M9 07:4 and 06:6, set = off)", () => {
    // Owner: "both signals at danger = raised; either one at proceed = crossing lowered".
    // On M9 a set bit means the signal is off (ADR 0014's polarity finding), so activeMeans "off".
    const carleton = (s3879: number, s3870: number) =>
      inferredBarrierState([
        signalStateForBitForInference(s3879 << 4, 4, "off"),
        signalStateForBitForInference(s3870 << 6, 6, "off"),
      ]);
    expect(carleton(0, 0)).toBe("up");
    expect(carleton(1, 0)).toBe("down");
    expect(carleton(0, 1)).toBe("down");
    expect(carleton(1, 1)).toBe("down");
  });

  it("turns a bundle's inferred index into signal bindings under non-colliding synthetic ids", () => {
    const bindings = inferredInputBindings({
      "lx-carleton": [
        { tdArea: "M9", address: "07", bit: 4, activeMeans: "off" },
        { tdArea: "M9", address: "06", bit: 6, activeMeans: "off" },
      ],
    });
    expect(bindings).toEqual([
      { elementId: "lx-carleton#in0", tdArea: "M9", address: "07", bit: 4, activeMeans: "off" },
      { elementId: "lx-carleton#in1", tdArea: "M9", address: "06", bit: 6, activeMeans: "off" },
    ]);
    expect(inferredInputElementId("lx-carleton", 1)).toBe("lx-carleton#in1");
    // A bundle published before inferred crossings existed.
    expect(inferredInputBindings(undefined)).toEqual([]);
  });

  it("combines resolved input states per crossing", () => {
    const index = {
      a: [
        { tdArea: "M9", address: "07", bit: 4, activeMeans: "off" as const },
        { tdArea: "M9", address: "06", bit: 6, activeMeans: "off" as const },
      ],
      b: [{ tdArea: "M9", address: "01", bit: 0, activeMeans: "on" as const }],
    };
    expect(
      inferredCrossingStates(index, {
        "a#in0": { state: "on" },
        "a#in1": { state: "on" },
        // b's only input has no resolved state at all.
      }),
    ).toEqual({ a: "up", b: "blank" });
  });
});

describe("route vocabulary (Milestone 64 / ADR 0016)", () => {
  it("round-trips a bound route bit into set/unset, keeping blank as blank", () => {
    const value = 0b0001_0000;
    expect(
      routeStateFromSignalState(signalStateForBit(value, 4, routeActiveMeansAsSignal("set"))),
    ).toBe("set");
    expect(
      routeStateFromSignalState(signalStateForBit(value, 5, routeActiveMeansAsSignal("set"))),
    ).toBe("unset");
    // An inverted-polarity route bit, stated by the author.
    expect(
      routeStateFromSignalState(signalStateForBit(value, 4, routeActiveMeansAsSignal("unset"))),
    ).toBe("unset");
    // blank means no information and must never become "unset" (or "set").
    expect(routeStateFromSignalState("blank")).toBe("blank");
  });

  it("reads a bundle's route index, and a bundle without one as empty", () => {
    expect(routeBindingsFromIndex({ "M9|0C|4": "r-1" }, { "M9|0C|4": "set" })).toEqual([
      { elementId: "r-1", tdArea: "M9", address: "0C", bit: 4, activeMeans: "off" },
    ]);
    expect(routeBindingsFromIndex(undefined, undefined)).toEqual([]);
    expect(routeBindingsFromIndex({ "M9|0C|4": "r-1" }, undefined)).toEqual([
      { elementId: "r-1", tdArea: "M9", address: "0C", bit: 4 },
    ]);
  });
});
