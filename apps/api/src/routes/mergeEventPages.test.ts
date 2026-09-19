import { describe, expect, it } from "vitest";
import { mergeEventPages } from "./maps.js";
import type { SequencedEvent } from "../lib/signalEvents.js";

const ev = (sequence: number, order = 0): SequencedEvent => ({
  sequence: BigInt(sequence),
  order,
  messages: [],
});
const seqs = (events: SequencedEvent[]): string[] =>
  events.map((e) => `${e.sequence}${e.order ? "b" : ""}`);

describe("mergeEventPages (Milestone 36b playback paging)", () => {
  it("merges sources in sequence order, a silence blank after its row", () => {
    const page = mergeEventPages(
      [
        { events: [ev(1), ev(5)], full: false },
        { events: [ev(3), ev(4)], full: false },
        { events: [ev(4, 1)], full: false },
      ],
      10,
    );
    expect(seqs(page.events)).toEqual(["1", "3", "4", "4b", "5"]);
    expect(page.nextCursor).toBeNull();
  });

  it("stops at a full source's last sequence so its unfetched rows aren't skipped", () => {
    // Source A filled its page at 4 (rows after 4 weren't fetched); B has 7 — it must wait.
    const page = mergeEventPages(
      [
        { events: [ev(2), ev(4)], full: true },
        { events: [ev(3), ev(7)], full: false },
      ],
      2,
    );
    expect(seqs(page.events)).toEqual(["2", "3"]);
    expect(page.nextCursor).toBe("3");
    const bounded = mergeEventPages(
      [
        { events: [ev(2), ev(4)], full: true },
        { events: [ev(3), ev(7)], full: false },
      ],
      10,
    );
    expect(seqs(bounded.events)).toEqual(["2", "3", "4"]);
    expect(bounded.nextCursor).toBe("4");
  });

  it("never splits entries sharing a sequence across pages", () => {
    const page = mergeEventPages(
      [
        { events: [ev(1), ev(2)], full: false },
        { events: [ev(2, 1)], full: false },
      ],
      2,
    );
    expect(seqs(page.events)).toEqual(["1", "2", "2b"]);
  });

  it("returns a null cursor only when every source is exhausted", () => {
    expect(mergeEventPages([{ events: [], full: false }], 5)).toEqual({
      events: [],
      nextCursor: null,
    });
  });
});
