import { describe, expect, it } from "vitest";
import { joinCombinedBerthState, type CombinedBerthMember } from "./combinedBerth.js";

function member(overrides: Partial<CombinedBerthMember>): CombinedBerthMember {
  return {
    tdArea: "PX",
    berth: "A001",
    order: 1,
    description: null,
    enteredAt: null,
    ...overrides,
  };
}

describe("joinCombinedBerthState", () => {
  it("returns null/null when every member is vacant", () => {
    const result = joinCombinedBerthState([
      member({ berth: "A001", order: 1 }),
      member({ berth: "B001", order: 2 }),
    ]);
    expect(result).toEqual({ description: null, enteredAt: null });
  });

  it("reduces a single-member group to that member's own state unchanged", () => {
    const result = joinCombinedBerthState([
      member({ description: "2A16", enteredAt: "2026-09-17T10:00:00.000Z" }),
    ]);
    expect(result).toEqual({ description: "2A16", enteredAt: "2026-09-17T10:00:00.000Z" });
  });

  it("joins occupied members in `order`, not in array or berth-code order", () => {
    const result = joinCombinedBerthState([
      member({ berth: "C001", order: 3, description: "3A16", enteredAt: "2026-09-17T10:02:00Z" }),
      member({ berth: "A001", order: 1, description: "1A16", enteredAt: "2026-09-17T10:00:00Z" }),
      member({ berth: "B001", order: 2, description: "2A16", enteredAt: "2026-09-17T10:01:00Z" }),
    ]);
    expect(result.description).toBe("1A16 2A16 3A16");
  });

  it("omits vacant members from the join — only currently-occupied ones show", () => {
    const result = joinCombinedBerthState([
      member({ berth: "A001", order: 1, description: "1A16", enteredAt: "2026-09-17T10:00:00Z" }),
      member({ berth: "B001", order: 2, description: null, enteredAt: null }),
      member({ berth: "C001", order: 3, description: "3A16", enteredAt: "2026-09-17T10:02:00Z" }),
    ]);
    expect(result.description).toBe("1A16 3A16");
  });

  it("reports the most-recently-entered occupied member's enteredAt", () => {
    const result = joinCombinedBerthState([
      member({ berth: "A001", order: 1, description: "1A16", enteredAt: "2026-09-17T10:00:00Z" }),
      member({ berth: "B001", order: 2, description: "2A16", enteredAt: "2026-09-17T10:05:00Z" }),
    ]);
    expect(result.enteredAt).toBe("2026-09-17T10:05:00Z");
  });

  it("supports up to 4 members", () => {
    const result = joinCombinedBerthState([
      member({ berth: "A001", order: 1, description: "A", enteredAt: "2026-09-17T10:00:00Z" }),
      member({ berth: "B001", order: 2, description: "B", enteredAt: "2026-09-17T10:01:00Z" }),
      member({ berth: "C001", order: 3, description: "C", enteredAt: "2026-09-17T10:02:00Z" }),
      member({ berth: "D001", order: 4, description: "D", enteredAt: "2026-09-17T10:03:00Z" }),
    ]);
    expect(result.description).toBe("A B C D");
  });
});
