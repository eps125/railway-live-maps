import { describe, expect, it } from "vitest";
import { normalizeTimestamp } from "./normalizeTimestamp.js";

const RECEIVED_AT = new Date("2026-08-04T12:00:00.000Z");

describe("normalizeTimestamp", () => {
  it("parses a plausible epoch-ms string cleanly", () => {
    const eventAt = new Date("2026-08-04T11:59:50.000Z");
    const result = normalizeTimestamp(String(eventAt.getTime()), RECEIVED_AT);

    expect(result.correctionCode).toBe("none");
    expect(result.correctionDetails).toBeNull();
    expect(result.normalizedEventAtUtc).toBe(eventAt.toISOString());
  });

  it("falls back to receivedAt when the text is null", () => {
    const result = normalizeTimestamp(null, RECEIVED_AT);
    expect(result.correctionCode).toBe("unparseable");
    expect(result.normalizedEventAtUtc).toBe(RECEIVED_AT.toISOString());
  });

  it("falls back to receivedAt when the text is not numeric", () => {
    const result = normalizeTimestamp("not-a-timestamp", RECEIVED_AT);
    expect(result.correctionCode).toBe("unparseable");
    expect(result.normalizedEventAtUtc).toBe(RECEIVED_AT.toISOString());
  });

  it("falls back to receivedAt when the timestamp is wildly implausible", () => {
    const result = normalizeTimestamp("1", RECEIVED_AT);
    expect(result.correctionCode).toBe("implausible_skew");
    expect(result.normalizedEventAtUtc).toBe(RECEIVED_AT.toISOString());
    expect(result.correctionDetails).toContain("substituted received_at");
  });

  it("accepts a timestamp right at the plausibility boundary", () => {
    const justInside = new Date(RECEIVED_AT.getTime() - 24 * 60 * 60 * 1000 + 1000);
    const result = normalizeTimestamp(String(justInside.getTime()), RECEIVED_AT);
    expect(result.correctionCode).toBe("none");
  });
});
