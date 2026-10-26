import { describe, expect, it } from "vitest";
import { cancellationRulesOutRun } from "./cancellation.js";

const today = { resolvedToYesterday: false, cancelledBeforeBerth: false };
const yesterday = { resolvedToYesterday: true, cancelledBeforeBerth: false };

describe("cancellationRulesOutRun", () => {
  it("never rules out a run with no cancellation", () => {
    expect(cancellationRulesOutRun(null, today)).toBe(false);
    expect(cancellationRulesOutRun(null, yesterday)).toBe(false);
  });

  it("rules out whole-run cancellations — the CL 2C32 / PX 1Y50 real cases (2026-10-26)", () => {
    for (const type of ["AT ORIGIN", "ON CALL", "OUT OF PLAN"]) {
      expect(cancellationRulesOutRun({ type, reinstate: 0 }, today)).toBe(true);
      expect(cancellationRulesOutRun({ type, reinstate: 0 }, yesterday)).toBe(true);
    }
  });

  it("keeps a reinstated run — the CL 1S63 real case (cancelled 11:45, reinstated 13:44)", () => {
    expect(cancellationRulesOutRun({ type: null, reinstate: 1 }, today)).toBe(false);
    expect(cancellationRulesOutRun({ type: "AT ORIGIN", reinstate: 1 }, today)).toBe(false);
  });

  it("rules out an en-route cancellation resolved to yesterday", () => {
    expect(cancellationRulesOutRun({ type: "EN ROUTE", reinstate: 0 }, yesterday)).toBe(true);
  });

  it("keeps today's part-cancelled train still on its way to the cancellation point", () => {
    expect(cancellationRulesOutRun({ type: "EN ROUTE", reinstate: 0 }, today)).toBe(false);
  });

  it("rules out today's part-cancelled train when it terminates short of this berth", () => {
    expect(
      cancellationRulesOutRun(
        { type: "EN ROUTE", reinstate: 0 },
        { resolvedToYesterday: false, cancelledBeforeBerth: true },
      ),
    ).toBe(true);
  });

  it("never treats an unknown or missing type as evidence", () => {
    expect(cancellationRulesOutRun({ type: null, reinstate: 0 }, yesterday)).toBe(false);
    expect(cancellationRulesOutRun({ type: "P", reinstate: 0 }, yesterday)).toBe(false);
  });
});
