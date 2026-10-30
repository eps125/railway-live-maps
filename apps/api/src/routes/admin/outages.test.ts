import { describe, expect, it } from "vitest";
import { gapSeverity, liveTdStatus, parseOutageDays, worseSeverity } from "./outages.js";

const NOW = new Date("2026-10-30T12:00:00Z");

describe("parseOutageDays", () => {
  it("defaults to 30 and accepts whole days from 1 to 365", () => {
    expect(parseOutageDays(undefined)).toBe(30);
    expect(parseOutageDays("")).toBe(30);
    expect(parseOutageDays("7")).toBe(7);
    expect(parseOutageDays("365")).toBe(365);
  });

  it("rejects anything else", () => {
    for (const raw of ["0", "366", "2.5", "-1", "week", "7d"]) {
      expect(parseOutageDays(raw)).toBeNull();
    }
  });
});

describe("liveTdStatus", () => {
  it("is not ongoing while frames keep arriving", () => {
    expect(liveTdStatus(new Date("2026-10-30T11:59:30Z"), NOW)).toEqual({
      lastFrameAt: "2026-10-30T11:59:30.000Z",
      silentForSeconds: 30,
      ongoing: false,
      severity: null,
    });
  });

  it("is amber past 30 s of silence and red past 5 minutes (owner, 2026-10-30)", () => {
    expect(liveTdStatus(new Date("2026-10-30T11:59:29Z"), NOW)).toMatchObject({
      ongoing: true,
      severity: "amber",
    });
    expect(liveTdStatus(new Date("2026-10-30T11:55:00Z"), NOW).severity).toBe("amber");
    expect(liveTdStatus(new Date("2026-10-30T11:54:59Z"), NOW)).toMatchObject({
      silentForSeconds: 301,
      ongoing: true,
      severity: "red",
    });
  });

  it("counts a feed that has never received anything as a red outage", () => {
    expect(liveTdStatus(null, NOW)).toEqual({
      lastFrameAt: null,
      silentForSeconds: null,
      ongoing: true,
      severity: "red",
    });
  });
});

describe("gapSeverity / worseSeverity", () => {
  it("short silences are amber, everything else red", () => {
    expect(gapSeverity("td_short_receive_silence")).toBe("amber");
    expect(gapSeverity("td_receive_silence")).toBe("red");
    expect(gapSeverity("operator_recorded")).toBe("red");
  });

  it("red wins over amber, which wins over nothing", () => {
    expect(worseSeverity(null, null)).toBeNull();
    expect(worseSeverity("amber", null)).toBe("amber");
    expect(worseSeverity(null, "amber")).toBe("amber");
    expect(worseSeverity("amber", "red")).toBe("red");
  });
});
