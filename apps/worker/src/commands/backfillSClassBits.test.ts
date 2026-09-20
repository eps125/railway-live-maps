import { describe, expect, it } from "vitest";
import { areaFlag, parseBackfillArgs, planSlices, toFoldEvent } from "./backfillSClassBits.js";

/**
 * Milestone 56: the pure parts of `backfill-s-class-bits`. The DB-touching half is covered by
 * running it against production data (dry run first) — what matters here is that the window is
 * validated, the slices tile it exactly, and a stored `td_s_event` row maps onto the fold event
 * the live projector would have built, including the `raw_feed_event` id the FK requires.
 */

const DEFAULT_TO = new Date("2026-09-19T15:00:00.000Z");

describe("parseBackfillArgs", () => {
  it("defaults to the 14 days ending where the live decoder took over", () => {
    const parsed = parseBackfillArgs([], DEFAULT_TO);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.to.toISOString()).toBe("2026-09-19T15:00:00.000Z");
    expect(parsed.args.from.toISOString()).toBe("2026-09-05T15:00:00.000Z");
    expect(parsed.args.area).toBeNull();
    expect(parsed.args.execute).toBe(false);
  });

  it("is a dry run unless --execute is passed", () => {
    const parsed = parseBackfillArgs(["--execute"], DEFAULT_TO);
    expect(parsed.ok && parsed.args.execute).toBe(true);
  });

  it("uppercases --area and accepts explicit bounds", () => {
    const parsed = parseBackfillArgs(
      ["--area", "m9", "--from", "2026-09-10T00:00:00Z", "--to", "2026-09-11T00:00:00Z"],
      DEFAULT_TO,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.area).toBe("M9");
    expect(parsed.args.from.toISOString()).toBe("2026-09-10T00:00:00.000Z");
  });

  it("rejects an empty window, an over-long one and a bad area", () => {
    expect(parseBackfillArgs(["--from", "2026-09-20T00:00:00Z"], DEFAULT_TO).ok).toBe(false);
    expect(parseBackfillArgs(["--days", "90"], DEFAULT_TO).ok).toBe(false);
    expect(parseBackfillArgs(["--area", "M99"], DEFAULT_TO).ok).toBe(false);
    expect(parseBackfillArgs(["--days", "-1"], DEFAULT_TO).ok).toBe(false);
    expect(parseBackfillArgs(["--to", "not-a-date"], DEFAULT_TO).ok).toBe(false);
  });
});

describe("parseBackfillArgs — decode columns (replay)", () => {
  it("fills td_s_event decode columns by default, since that is what replay reads", () => {
    const parsed = parseBackfillArgs([], DEFAULT_TO);
    expect(parsed.ok && parsed.args.decode).toBe(true);
  });

  it("honours --skip-decode for a transitions-only run", () => {
    const parsed = parseBackfillArgs(["--skip-decode"], DEFAULT_TO);
    expect(parsed.ok && parsed.args.decode).toBe(false);
  });
});

describe("areaFlag — the boundary lookup must be per area, not global", () => {
  it("reads and uppercases --area", () => {
    expect(areaFlag(["--area", "m9", "--execute"])).toBe("M9");
    expect(areaFlag(["--area", "M9"])).toBe("M9");
  });

  it("is null for a nationwide run", () => {
    expect(areaFlag(["--execute"])).toBeNull();
  });

  it("is null for a malformed area, so a typo can never widen the boundary to all areas", () => {
    // parseBackfillArgs rejects these outright; areaFlag must not quietly fall back to a
    // nationwide boundary lookup in the meantime.
    expect(areaFlag(["--area", "M99"])).toBeNull();
    expect(areaFlag(["--area"])).toBeNull();
  });
});

describe("planSlices", () => {
  it("tiles the window exactly, with a short final slice", () => {
    const from = new Date("2026-09-10T00:00:00Z");
    const to = new Date("2026-09-10T15:00:00Z");
    const slices = planSlices(from, to, 6);
    expect(slices.map(([a, b]) => [a.toISOString(), b.toISOString()])).toEqual([
      ["2026-09-10T00:00:00.000Z", "2026-09-10T06:00:00.000Z"],
      ["2026-09-10T06:00:00.000Z", "2026-09-10T12:00:00.000Z"],
      ["2026-09-10T12:00:00.000Z", "2026-09-10T15:00:00.000Z"],
    ]);
  });

  it("never runs past the window end", () => {
    const slices = planSlices(
      new Date("2026-09-10T00:00:00Z"),
      new Date("2026-09-10T01:00:00Z"),
      6,
    );
    expect(slices).toHaveLength(1);
    expect(slices[0]?.[1].toISOString()).toBe("2026-09-10T01:00:00.000Z");
  });
});

describe("toFoldEvent", () => {
  const row = {
    id: "4242",
    event_at: new Date("2026-09-10T09:00:05.000Z"),
    raw_event_id: "987654",
    raw_event_normalized_at_utc: new Date("2026-09-10T09:00:05.000Z"),
    td_area: "M9",
    message_type: "SF_MSG",
    address: "07",
    raw_value: "CB",
    ingestion_sequence: "187507968",
  };

  it("decodes a pre-decoder row using the values td_s_event preserved", () => {
    const mapped = toFoldEvent(row);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.event.tdArea).toBe("M9");
    expect(mapped.event.sourceKind).toBe("update");
    expect(mapped.event.bytes).toEqual([{ address: "07", value: 0xcb }]);
  });

  it("carries the raw_feed_event id, which the transition FK references", () => {
    const mapped = toFoldEvent(row);
    expect(mapped.ok && mapped.event.eventId).toBe("987654");
    expect(mapped.ok && mapped.event.eventNormalizedAt.toISOString()).toBe(
      "2026-09-10T09:00:05.000Z",
    );
    expect(mapped.ok && mapped.event.ingestionSequence).toBe("187507968");
  });

  it("decodes an SG refresh as four consecutive bytes", () => {
    const mapped = toFoldEvent({ ...row, message_type: "SG_MSG", raw_value: "01020304" });
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.event.sourceKind).toBe("refresh");
    expect(mapped.event.bytes.map((b) => b.address)).toEqual(["07", "08", "09", "0A"]);
  });

  it("reports an undecodable row rather than repairing it", () => {
    expect(toFoldEvent({ ...row, raw_value: "ZZ" })).toEqual({
      ok: false,
      errorCode: "invalid_data",
    });
    expect(toFoldEvent({ ...row, raw_value: null })).toEqual({
      ok: false,
      errorCode: "invalid_data",
    });
    expect(toFoldEvent({ ...row, message_type: "CA_MSG" })).toEqual({
      ok: false,
      errorCode: "unknown_message_type",
    });
  });
});
