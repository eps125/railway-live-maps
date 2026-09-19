import { describe, expect, it } from "vitest";
import { decideVirtualBerthStep } from "./stepping.js";

describe("decideVirtualBerthStep", () => {
  it("opens a fresh occupancy when this trust_id holds nothing else (first-ever report)", () => {
    expect(
      decideVirtualBerthStep({ existingStanox: null, newStanox: "52701", terminated: false }),
    ).toEqual({ closeExisting: false, openNew: true, terminateNew: false });
  });

  it("steps from one virtual berth to another for the same trust_id", () => {
    expect(
      decideVirtualBerthStep({ existingStanox: "52701", newStanox: "52702", terminated: false }),
    ).toEqual({ closeExisting: true, openNew: true, terminateNew: false });
  });

  it("treats a repeat report at the same STANOX as a no-op step (re-affirm, no close)", () => {
    expect(
      decideVirtualBerthStep({ existingStanox: "52701", newStanox: "52701", terminated: false }),
    ).toEqual({ closeExisting: false, openNew: true, terminateNew: false });
  });

  it("closes the previous occupancy and immediately terminates the new one when the train ends its journey mid-step", () => {
    expect(
      decideVirtualBerthStep({ existingStanox: "52701", newStanox: "52702", terminated: true }),
    ).toEqual({ closeExisting: true, openNew: true, terminateNew: true });
  });

  it("opens then immediately terminates a first-ever report that already says terminated", () => {
    expect(
      decideVirtualBerthStep({ existingStanox: null, newStanox: "52702", terminated: true }),
    ).toEqual({ closeExisting: false, openNew: true, terminateNew: true });
  });
});
