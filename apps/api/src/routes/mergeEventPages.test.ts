import { describe, expect, it } from "vitest";
import { mergeEventPages } from "./maps.js";
import { parseEventsCursor, type SequencedEvent } from "../lib/signalEvents.js";

/** By default an event's time follows its sequence (1 s apart), as for anything received live. */
const ev = (sequence: number, order = 0, eventAtMs = sequence * 1000): SequencedEvent => ({
  eventAtMs,
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
    expect(page.nextCursor).toBe("3000:3");
    const bounded = mergeEventPages(
      [
        { events: [ev(2), ev(4)], full: true },
        { events: [ev(3), ev(7)], full: false },
      ],
      10,
    );
    expect(seqs(bounded.events)).toEqual(["2", "3", "4"]);
    expect(bounded.nextCursor).toBe("4000:4");
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

  it("orders by event time first: a step stored late plays when it happened (31 Oct)", () => {
    // Sequence 900 was recovered hours later but happened at t=2.5 s, between 2 and 3.
    const page = mergeEventPages(
      [{ events: [ev(1), ev(2), ev(900, 0, 2500), ev(3)], full: false }],
      10,
    );
    expect(seqs(page.events)).toEqual(["1", "2", "900", "3"]);
  });

  it("bounds a full source by its last (time, sequence), not its last sequence", () => {
    const page = mergeEventPages(
      [
        { events: [ev(1), ev(900, 0, 2500)], full: true },
        { events: [ev(2), ev(3)], full: false },
      ],
      10,
    );
    // Source A may have unfetched rows after t=2.5 s, so 3 (t=3 s) waits for the next page.
    expect(seqs(page.events)).toEqual(["1", "2", "900"]);
    expect(page.nextCursor).toBe("2500:900");
  });

  it("returns a null cursor only when every source is exhausted", () => {
    expect(mergeEventPages([{ events: [], full: false }], 5)).toEqual({
      events: [],
      nextCursor: null,
    });
  });
});

describe("parseEventsCursor", () => {
  it("reads the start, a (time, sequence) cursor, and an older bare-sequence cursor", () => {
    expect(parseEventsCursor(undefined)).toEqual({ kind: "start" });
    expect(parseEventsCursor("0")).toEqual({ kind: "start" });
    expect(parseEventsCursor("1793429515000:572718107")).toEqual({
      kind: "cursor",
      at: new Date(1793429515000),
      sequence: "572718107",
    });
    expect(parseEventsCursor("572718107")).toEqual({ kind: "legacy", sequence: "572718107" });
  });

  it("rejects anything else", () => {
    for (const raw of ["abc", "-1", "1:2:3", "1793429515000:", "1.5"]) {
      expect(parseEventsCursor(raw)).toBeNull();
    }
  });
});
