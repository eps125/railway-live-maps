import { describe, expect, it } from "vitest";
import { isRecoveredMessage, nrIdentity, parseOpenrailTddbLine } from "./openrailTddbLog.js";

// Real lines from the 2026-10-15 gap excerpt, paired with the raw_event_json RLM stored for the
// same NR messages where both systems captured them (23:55:00–23:55:31Z).
describe("parseOpenrailTddbLine", () => {
  it("rebuilds a CA step exactly as NR sent it", () => {
    const parsed = parseOpenrailTddbLine(
      "15/10/26 23:55:30Z ] (Timestamp 15/10/26 23:55:30Z) A2 CA: 5J76 from 0882 to 0880 ",
      7,
    );
    expect(isRecoveredMessage(parsed)).toBe(true);
    if (!isRecoveredMessage(parsed)) return;
    // RLM stored: {"CA_MSG": {"to": "0880", "from": "0882", "time": "1792108530000", "descr": "5J76", "area_id": "A2", "msg_type": "CA"}}
    expect(parsed.rawEventJson).toEqual({
      CA_MSG: {
        to: "0880",
        from: "0882",
        time: "1792108530000",
        descr: "5J76",
        area_id: "A2",
        msg_type: "CA",
      },
    });
    expect(parsed.eventAt.toISOString()).toBe("2026-10-15T23:55:30.000Z");
    expect(parsed.tdArea).toBe("A2");
    expect(parsed.lineNumber).toBe(7);
  });

  it("keeps openrail's log-write time separate from the NR message time", () => {
    const parsed = parseOpenrailTddbLine(
      "15/10/26 23:55:32Z ] (Timestamp 15/10/26 23:55:31Z) C6 CA: 2B93 from 3179 to 3205 ",
      1,
    );
    if (!isRecoveredMessage(parsed)) throw new Error("expected a message");
    expect(parsed.loggedAt.toISOString()).toBe("2026-10-15T23:55:32.000Z");
    expect(parsed.eventAt.toISOString()).toBe("2026-10-15T23:55:31.000Z");
  });

  it("rebuilds CB and CC with only the berth NR sends", () => {
    const cb = parseOpenrailTddbLine(
      "15/10/26 23:55:52Z ] (Timestamp 15/10/26 23:55:51Z) CV CB: 5U72 from 9128         ",
      1,
    );
    const cc = parseOpenrailTddbLine(
      "15/10/26 23:55:50Z ] (Timestamp 15/10/26 23:55:49Z) WE CC: 0M00           to WUSY ",
      2,
    );
    if (!isRecoveredMessage(cb) || !isRecoveredMessage(cc)) throw new Error("expected messages");
    expect(cb.rawEventJson).toEqual({
      CB_MSG: { from: "9128", time: "1792108551000", descr: "5U72", area_id: "CV", msg_type: "CB" },
    });
    expect(cc.rawEventJson).toEqual({
      CC_MSG: { to: "WUSY", time: "1792108549000", descr: "0M00", area_id: "WE", msg_type: "CC" },
    });
  });

  it("rebuilds a CT heartbeat", () => {
    const ct = parseOpenrailTddbLine(
      "15/10/26 23:55:50Z ] (Timestamp 15/10/26 23:55:49Z) SM CT: Heartbeat, report time 0055",
      1,
    );
    if (!isRecoveredMessage(ct)) throw new Error("expected a message");
    expect(ct.rawEventJson).toEqual({
      CT_MSG: { time: "1792108549000", area_id: "SM", msg_type: "CT", report_time: "0055" },
    });
  });

  it("restores NR's upper-case hex for S-Class, whatever openrail appended", () => {
    const changed = parseOpenrailTddbLine(
      "15/10/26 23:55:00Z ] (Timestamp 15/10/26 23:55:00Z) G4 SF: 5b = 0c                 Bit 5b 2 = 1",
      1,
    );
    const unchanged = parseOpenrailTddbLine(
      "15/10/26 23:55:00Z ] (Timestamp 15/10/26 23:55:00Z) R4 SF: 04 = f7                  No change",
      2,
    );
    if (!isRecoveredMessage(changed) || !isRecoveredMessage(unchanged)) throw new Error("expected");
    // RLM stored 5B|0C (G4) and 04|F7 (R4) for these exact messages.
    expect(changed.rawEventJson.SF_MSG).toMatchObject({ address: "5B", data: "0C", area_id: "G4" });
    expect(unchanged.rawEventJson.SF_MSG).toMatchObject({
      address: "04",
      data: "F7",
      area_id: "R4",
    });
    expect(changed.line).toContain("5b = 0c");
  });

  it("rejects anything it cannot rebuild exactly, rather than guessing", () => {
    expect(parseOpenrailTddbLine("garbage", 3)).toEqual({
      lineNumber: 3,
      line: "garbage",
      reason: "unrecognised_line",
    });
    const sg = parseOpenrailTddbLine(
      "15/10/26 23:55:00Z ] (Timestamp 15/10/26 23:55:00Z) R4 SG: 04 = f7000000",
      4,
    );
    expect(isRecoveredMessage(sg)).toBe(false);
    const badCa = parseOpenrailTddbLine(
      "15/10/26 23:55:00Z ] (Timestamp 15/10/26 23:55:00Z) A2 CA: 5J76 to 0880",
      5,
    );
    expect(badCa).toMatchObject({ reason: "bad_ca_body" });
  });
});

describe("nrIdentity", () => {
  it("is independent of JSON key order, so recovered and stored copies compare equal", () => {
    expect(
      nrIdentity({
        CA_MSG: {
          to: "0880",
          from: "0882",
          time: "1",
          descr: "5J76",
          area_id: "A2",
          msg_type: "CA",
        },
      }),
    ).toBe(
      nrIdentity({
        CA_MSG: {
          time: "1",
          area_id: "A2",
          msg_type: "CA",
          from: "0882",
          to: "0880",
          descr: "5J76",
        },
      }),
    );
  });
});
