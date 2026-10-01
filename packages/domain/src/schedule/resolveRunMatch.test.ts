import { describe, expect, it } from "vitest";
import { resolveRunMatch, type RunMatchCandidate } from "./resolveRunMatch.js";

function candidate(overrides: Partial<RunMatchCandidate> = {}): RunMatchCandidate {
  return {
    scheduleId: "1",
    stpIndicator: "P",
    scheduleStartDate: "2026-01-01",
    scheduleEndDate: "2026-12-31",
    daysRunsBitmask: "1111111",
    ...overrides,
  };
}

/** Builds the `activatedDatesByScheduleId` map `resolveRunMatch` expects — each entry is
 * `[scheduleId, dateActivatedOn]`, mirroring a real `trust_activation` row's own calendar date
 * (ADR 0008 addendum: never the query's cutoff bound). */
function activatedOn(
  ...entries: Array<[scheduleId: string, date: string]>
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const [id, date] of entries) {
    const set = map.get(id);
    if (set) set.add(date);
    else map.set(id, new Set([date]));
  }
  return map;
}

// 2026-08-10 is a Monday.
const A_MONDAY = "2026-08-10";
const SUNDAY_BEFORE = "2026-08-09";

describe("resolveRunMatch (Milestone 34, docs/adr/0006)", () => {
  it("matches on trust_activation when exactly one running-today candidate has one, even though it isn't the STP-precedence winner", () => {
    // Two Permanent schedules (same precedence, would be ambiguous by STP alone) — only one
    // has an activation today. Rule 6: activation is authoritative when available.
    const p1 = candidate({ scheduleId: "1" });
    const p2 = candidate({ scheduleId: "2" });
    const result = resolveRunMatch([p1, p2], activatedOn(["2", A_MONDAY]), [A_MONDAY]);
    expect(result).toEqual({
      status: "matched",
      basis: "trust_activation",
      selected: p2,
      trafficDay: A_MONDAY,
    });
  });

  it("two activated candidates is ambiguous at the trust_activation tier — never falls through to STP as a tie-break", () => {
    const p1 = candidate({ scheduleId: "1" });
    const p2 = candidate({ scheduleId: "2" });
    const result = resolveRunMatch([p1, p2], activatedOn(["1", A_MONDAY], ["2", A_MONDAY]), [
      A_MONDAY,
    ]);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.basis).toBe("trust_activation");
      expect(result.candidates).toEqual([p1, p2]);
    }
  });

  it("falls to stp_precedence when no candidate is activated", () => {
    const p = candidate({ scheduleId: "1", stpIndicator: "P" });
    const o = candidate({ scheduleId: "2", stpIndicator: "O" });
    const result = resolveRunMatch([p, o], activatedOn(), [A_MONDAY]);
    expect(result).toEqual({
      status: "matched",
      basis: "stp_precedence",
      selected: o,
      trafficDay: A_MONDAY,
    });
  });

  it("is ambiguous at the stp_precedence tier when STP itself can't resolve it and nothing is activated", () => {
    const p1 = candidate({ scheduleId: "1" });
    const p2 = candidate({ scheduleId: "2" });
    const result = resolveRunMatch([p1, p2], activatedOn(), [A_MONDAY]);
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.basis).toBe("stp_precedence");
      expect(result.candidates).toEqual([p1, p2]);
    }
  });

  it("is unmatched when no candidate runs on any probed date at all", () => {
    const stale = candidate({ scheduleStartDate: "2020-01-01", scheduleEndDate: "2020-12-31" });
    const result = resolveRunMatch([stale], activatedOn(["1", A_MONDAY]), [
      A_MONDAY,
      SUNDAY_BEFORE,
    ]);
    expect(result).toEqual({ status: "unmatched" });
  });

  it("is unmatched with an empty candidate list", () => {
    expect(resolveRunMatch([], activatedOn(), [A_MONDAY])).toEqual({ status: "unmatched" });
  });

  it("only checks activation among running candidates, not a stale one that happens to be activated", () => {
    const stale = candidate({
      scheduleId: "1",
      scheduleStartDate: "2020-01-01",
      scheduleEndDate: "2020-12-31",
    });
    const running = candidate({ scheduleId: "2" });
    const result = resolveRunMatch([stale, running], activatedOn(["1", A_MONDAY]), [A_MONDAY]);
    // "1" is activated but doesn't run on any probed date, so only "2" is a real candidate —
    // falls to stp_precedence (no activation among the running set) and matches on "2" alone.
    expect(result).toEqual({
      status: "matched",
      basis: "stp_precedence",
      selected: running,
      trafficDay: A_MONDAY,
    });
  });

  describe("overnight trains running on consecutive days (2026-10-01, Caledonian Sleeper)", () => {
    // 1M11, Glasgow Central 23:40, runs Tuesday to Thursday: valid on both probed dates.
    const sleeper = candidate({ scheduleId: "1M11", stpIndicator: "O" });
    const departs2340 = (nowMinutes: number) => ({
      originDepartureMinutes: () => 23 * 60 + 40,
      nowMinutes,
    });

    it("after midnight it is last night's run, and matches that night's activation", () => {
      const result = resolveRunMatch(
        [sleeper],
        activatedOn(["1M11", SUNDAY_BEFORE]),
        [A_MONDAY, SUNDAY_BEFORE],
        undefined,
        undefined,
        departs2340(30), // 00:30: 50 minutes after last night's departure
      );
      expect(result).toEqual({
        status: "matched",
        basis: "trust_activation",
        selected: sleeper,
        trafficDay: SUNDAY_BEFORE,
      });
    });

    it("before its departure the same evening it is tonight's run", () => {
      const result = resolveRunMatch(
        [sleeper],
        activatedOn(["1M11", SUNDAY_BEFORE], ["1M11", A_MONDAY]),
        [A_MONDAY, SUNDAY_BEFORE],
        undefined,
        undefined,
        departs2340(23 * 60), // 23:00, being made ready
      );
      expect(result).toMatchObject({ basis: "trust_activation", trafficDay: A_MONDAY });
    });

    it("a day train standing at its origin early is still today's", () => {
      const result = resolveRunMatch(
        [candidate()],
        activatedOn(),
        [A_MONDAY, SUNDAY_BEFORE],
        undefined,
        undefined,
        { originDepartureMinutes: () => 9 * 60, nowMinutes: 6 * 60 + 30 },
      );
      expect(result).toMatchObject({ basis: "stp_precedence", trafficDay: A_MONDAY });
    });

    it("without a known departure keeps the most recent date, as before", () => {
      const result = resolveRunMatch(
        [sleeper],
        activatedOn(["1M11", SUNDAY_BEFORE]),
        [A_MONDAY, SUNDAY_BEFORE],
        undefined,
        undefined,
        { originDepartureMinutes: () => null, nowMinutes: 30 },
      );
      expect(result).toMatchObject({ basis: "stp_precedence", trafficDay: A_MONDAY });
    });
  });

  describe("traffic-day boundary (docs/adr/0008): probing more than one serviceDate", () => {
    it("matches a schedule valid only on yesterday's date when today is also probed — the overnight-train case", () => {
      // Real scenario this fixes (2026-09-14 incident): PX 0052, headcode 5F05, schedule dated
      // only the 13th, still genuinely running past midnight into the 14th. Before the fix,
      // `resolveRunMatch` only ever saw `[today]` and this candidate fell out of every check.
      const overnight = candidate({
        scheduleId: "1",
        scheduleStartDate: SUNDAY_BEFORE,
        scheduleEndDate: SUNDAY_BEFORE,
      });
      const result = resolveRunMatch([overnight], activatedOn(), [A_MONDAY, SUNDAY_BEFORE]);
      expect(result).toEqual({
        status: "matched",
        basis: "stp_precedence",
        selected: overnight,
        trafficDay: SUNDAY_BEFORE,
      });
    });

    it("prefers today's own instance over yesterday's when a daily-running schedule satisfies both probed dates", () => {
      const daily = candidate({ scheduleId: "1" });
      const result = resolveRunMatch([daily], activatedOn(), [A_MONDAY, SUNDAY_BEFORE]);
      expect(result).toEqual({
        status: "matched",
        basis: "stp_precedence",
        selected: daily,
        trafficDay: A_MONDAY,
      });
    });

    it("resolves via trust_activation on yesterday's traffic day and reports that as the trafficDay", () => {
      const overnight = candidate({
        scheduleId: "1",
        scheduleStartDate: SUNDAY_BEFORE,
        scheduleEndDate: SUNDAY_BEFORE,
      });
      const sibling = candidate({ scheduleId: "2" }); // runs today, not activated
      const result = resolveRunMatch([overnight, sibling], activatedOn(["1", SUNDAY_BEFORE]), [
        A_MONDAY,
        SUNDAY_BEFORE,
      ]);
      expect(result).toEqual({
        status: "matched",
        basis: "trust_activation",
        selected: overnight,
        trafficDay: SUNDAY_BEFORE,
      });
    });

    it("is ambiguous, not a silent pick, when a still-running overnight schedule and a fresh today-dated same-headcode schedule are both activated on their own respective resolved dates", () => {
      const overnight = candidate({
        scheduleId: "1",
        scheduleStartDate: SUNDAY_BEFORE,
        scheduleEndDate: SUNDAY_BEFORE,
      });
      const freshToday = candidate({ scheduleId: "2" });
      const result = resolveRunMatch(
        [overnight, freshToday],
        activatedOn(["1", SUNDAY_BEFORE], ["2", A_MONDAY]),
        [A_MONDAY, SUNDAY_BEFORE],
      );
      expect(result.status).toBe("ambiguous");
      if (result.status === "ambiguous") {
        expect(result.basis).toBe("trust_activation");
        expect(result.candidates).toEqual([overnight, freshToday]);
      }
    });

    it("does not let a same-headcode sibling's activation from a different day count toward today's tier — the PX 0107 / 1Y61 regression (2026-09-15)", () => {
      // Real incident: both G89843 (activated ~08:25 this morning, for today's ~10:52 working)
      // and G89845 (last activated the evening before, for ITS OWN prior-day working — not due
      // again until tonight) share headcode 1Y61 and both call at the same position-scoped berth
      // every day. Widening the activation query to also fetch yesterday's rows (needed for the
      // overnight-train case above) meant G89845's stale prior-day row started counting as
      // "activated" for today's tier too, wrongly reporting `ambiguous` instead of matching
      // G89843 cleanly. Both candidates here run on both probed dates (daily bitmask) and so both
      // resolve to `A_MONDAY` (today, the preferred date) — only the one actually activated ON
      // that resolved date should count.
      const activatedThisMorning = candidate({ scheduleId: "1" }); // e.g. G89843
      const dueLaterToday = candidate({ scheduleId: "2" }); // e.g. G89845
      const result = resolveRunMatch(
        [activatedThisMorning, dueLaterToday],
        activatedOn(["1", A_MONDAY], ["2", SUNDAY_BEFORE]),
        [A_MONDAY, SUNDAY_BEFORE],
      );
      expect(result).toEqual({
        status: "matched",
        basis: "trust_activation",
        selected: activatedThisMorning,
        trafficDay: A_MONDAY,
      });
    });
  });

  describe("station_berth_timetable tier (Milestone 35)", () => {
    function timedCandidate(
      id: string,
      timeMinutes: number,
    ): RunMatchCandidate & {
      timeMinutes: number;
    } {
      return { ...candidate({ scheduleId: id }), timeMinutes };
    }
    const byTime = (c: { timeMinutes: number }): number => c.timeMinutes;

    it("does nothing when no timing is given — same two-tier result as Milestone 34", () => {
      const a = candidate({ scheduleId: "1" });
      const b = candidate({ scheduleId: "2" });
      const result = resolveRunMatch([a, b], activatedOn(), [A_MONDAY]);
      expect(result.status).toBe("ambiguous");
      if (result.status === "ambiguous") expect(result.basis).toBe("stp_precedence");
    });

    it("breaks an STP tie using whichever candidate's calling time is closest to now, even hours before it — the early-interpose case", () => {
      const early = timedCandidate("1", 10 * 60); // due 10:00
      const other = timedCandidate("2", 22 * 60); // due 22:00, same headcode elsewhere today
      const result = resolveRunMatch(
        [early, other],
        activatedOn(),
        [A_MONDAY],
        { callingTimeMinutes: byTime, nowMinutes: 5 * 60 }, // interposed at 05:00
      );
      expect(result).toEqual({
        status: "matched",
        basis: "station_berth_timetable",
        selected: early,
        trafficDay: A_MONDAY,
      });
    });

    it("still picks the nominally-passed candidate when it's just running late, not excluded for being in the past", () => {
      const late = timedCandidate("1", 10 * 60); // due 10:00, still sitting there
      const laterToday = timedCandidate("2", 22 * 60);
      const result = resolveRunMatch([late, laterToday], activatedOn(), [A_MONDAY], {
        callingTimeMinutes: byTime,
        nowMinutes: 10 * 60 + 15, // now 10:15 — 15 min late, not "already gone"
      });
      expect(result).toEqual({
        status: "matched",
        basis: "station_berth_timetable",
        selected: late,
        trafficDay: A_MONDAY,
      });
    });

    it("stays ambiguous at station_berth_timetable when two candidates are exactly tied for closest to now", () => {
      const a = timedCandidate("1", 10 * 60);
      const b = timedCandidate("2", 10 * 60 + 10);
      const result = resolveRunMatch([a, b], activatedOn(), [A_MONDAY], {
        callingTimeMinutes: byTime,
        nowMinutes: 10 * 60 + 5, // exactly 5 min from each
      });
      expect(result.status).toBe("ambiguous");
      if (result.status === "ambiguous") {
        expect(result.basis).toBe("station_berth_timetable");
        expect(result.candidates).toEqual([a, b]);
      }
    });

    it("falls back to the plain stp_precedence ambiguous result when neither tied candidate has a usable time", () => {
      const a = candidate({ scheduleId: "1" });
      const b = candidate({ scheduleId: "2" });
      const result = resolveRunMatch([a, b], activatedOn(), [A_MONDAY], {
        callingTimeMinutes: () => null,
        nowMinutes: 600,
      });
      expect(result.status).toBe("ambiguous");
      if (result.status === "ambiguous") expect(result.basis).toBe("stp_precedence");
    });

    it("never reaches the timing tier at all when STP precedence already resolves cleanly", () => {
      const p = { ...timedCandidate("1", 10 * 60), stpIndicator: "P" as const };
      const o = { ...timedCandidate("2", 5 * 60), stpIndicator: "O" as const }; // closer to now, but that shouldn't matter
      const result = resolveRunMatch([p, o], activatedOn(), [A_MONDAY], {
        callingTimeMinutes: byTime,
        nowMinutes: 5 * 60,
      });
      // Overlay beats Permanent outright — timing never gets consulted.
      expect(result).toEqual({
        status: "matched",
        basis: "stp_precedence",
        selected: o,
        trafficDay: A_MONDAY,
      });
    });
  });

  describe("movement-progress refinement (2026-09-15): excluding a demonstrably already-passed candidate", () => {
    it("resolves cleanly when one of two activated candidates has already passed this berth — the PX 0237 / 1M11 real case", () => {
      // Real report: W33973 activated this morning; a same-headcode Caledonian Sleeper working
      // (C04561) activated the evening before was also genuinely within the probed window, but
      // its own TRUST movement history already showed it well past this exact berth, terminated
      // hours earlier. Without the movement filter this reports ambiguous; with it, the
      // already-gone candidate is excluded before the ambiguity check ever runs.
      const stillRunning = candidate({ scheduleId: "1" }); // W33973
      const alreadyGone = candidate({ scheduleId: "2" }); // C04561
      const result = resolveRunMatch(
        [stillRunning, alreadyGone],
        activatedOn(["1", A_MONDAY], ["2", A_MONDAY]),
        [A_MONDAY],
        undefined,
        new Set(["2"]),
      );
      expect(result).toEqual({
        status: "matched",
        basis: "trust_activation",
        selected: stillRunning,
        trafficDay: A_MONDAY,
      });
    });

    it("stays ambiguous when neither activated candidate has confirmed movement evidence of having passed", () => {
      const a = candidate({ scheduleId: "1" });
      const b = candidate({ scheduleId: "2" });
      const result = resolveRunMatch(
        [a, b],
        activatedOn(["1", A_MONDAY], ["2", A_MONDAY]),
        [A_MONDAY],
        undefined,
        new Set(), // no positive evidence either way — absence of data excludes nothing
      );
      expect(result.status).toBe("ambiguous");
      if (result.status === "ambiguous") {
        expect(result.basis).toBe("trust_activation");
        expect(result.candidates).toEqual([a, b]);
      }
    });

    it("also excludes an already-passed candidate from the STP-precedence tier, not just the trust_activation check", () => {
      // Neither candidate is activated, so this falls straight to STP precedence — an
      // already-gone candidate must never win there either, since it's confirmed physically
      // absent regardless of which tier would otherwise have picked it.
      const wouldWinStp = candidate({ scheduleId: "1", stpIndicator: "O", trainUid: "A1" }); // already gone
      const fallback = candidate({ scheduleId: "2", stpIndicator: "P", trainUid: "B2" });
      const result = resolveRunMatch(
        [wouldWinStp, fallback],
        activatedOn(),
        [A_MONDAY],
        undefined,
        new Set(["1"]),
      );
      expect(result).toEqual({
        status: "matched",
        basis: "stp_precedence",
        selected: fallback,
        trafficDay: A_MONDAY,
      });
    });

    it("is unmatched when every running candidate has confirmed movement evidence of already passing", () => {
      const a = candidate({ scheduleId: "1" });
      const b = candidate({ scheduleId: "2" });
      const result = resolveRunMatch(
        [a, b],
        activatedOn(),
        [A_MONDAY],
        undefined,
        new Set(["1", "2"]),
      );
      expect(result).toEqual({ status: "unmatched" });
    });
  });

  describe("STP precedence within one train UID only (2026-10-01, PX/M9 1N58)", () => {
    // 1N58 is two trains on this line: G89569 (Manchester Airport 09:17, overlaid this week by
    // an O) and G89571 (19:17, its P). Seen at 20:30, the morning overlay's run is finished.
    const morningP = candidate({ scheduleId: "34568", stpIndicator: "P", trainUid: "G89569" });
    const morningO = candidate({ scheduleId: "250898", stpIndicator: "O", trainUid: "G89569" });
    const eveningP = candidate({ scheduleId: "34569", stpIndicator: "P", trainUid: "G89571" });
    const timing = {
      callingTimeMinutes: (c: RunMatchCandidate) =>
        c.trainUid === "G89569" ? 9 * 60 + 50 : 19 * 60 + 50,
      nowMinutes: 20 * 60 + 30,
    };

    it("a finished overlay does not bring back its own permanent schedule", () => {
      const result = resolveRunMatch(
        [morningP, morningO, eveningP],
        activatedOn(),
        [A_MONDAY],
        timing,
        new Set(["250898"]),
      );
      expect(result).toEqual({
        status: "matched",
        basis: "stp_precedence",
        selected: eveningP,
        trafficDay: A_MONDAY,
      });
    });

    it("an overlay of one train never outranks another train's permanent schedule", () => {
      // Neither run passed or activated: the overlay is G89569's governing schedule and the P is
      // G89571's — two trains, so it falls to the station timing, not to "O beats P".
      const result = resolveRunMatch(
        [morningP, morningO, eveningP],
        activatedOn(),
        [A_MONDAY],
        timing,
      );
      expect(result).toEqual({
        status: "matched",
        basis: "station_berth_timetable",
        selected: eveningP,
        trafficDay: A_MONDAY,
      });
      // Without a station to time against, two trains is ambiguous — never a guess.
      const unscoped = resolveRunMatch([morningP, morningO, eveningP], activatedOn(), [A_MONDAY]);
      expect(unscoped).toEqual({
        status: "ambiguous",
        basis: "stp_precedence",
        candidates: [morningO, eveningP],
      });
    });

    it("a cancellation that never matched by headcode still removes its train", () => {
      // CIF cancellations carry no headcode or calling points: they only arrive via the UID.
      const cancelled = candidate({ scheduleId: "9", stpIndicator: "C", trainUid: "G89571" });
      const result = resolveRunMatch(
        [morningP, eveningP],
        activatedOn(),
        [A_MONDAY],
        undefined,
        undefined,
        undefined,
        [morningP, eveningP, cancelled],
      );
      expect(result).toEqual({
        status: "matched",
        basis: "stp_precedence",
        selected: morningP,
        trafficDay: A_MONDAY,
      });
    });

    it("a cancellation only applies to the dates it covers", () => {
      const cancelledYesterday = candidate({
        scheduleId: "9",
        stpIndicator: "C",
        trainUid: "G89571",
        scheduleStartDate: SUNDAY_BEFORE,
        scheduleEndDate: SUNDAY_BEFORE,
      });
      const result = resolveRunMatch(
        [eveningP],
        activatedOn(),
        [A_MONDAY, SUNDAY_BEFORE],
        undefined,
        undefined,
        undefined,
        [eveningP, cancelledYesterday],
      );
      expect(result).toEqual({
        status: "matched",
        basis: "stp_precedence",
        selected: eveningP,
        trafficDay: A_MONDAY,
      });
    });
  });
});
