import { describe, expect, it } from "vitest";
import { realignedLabelX } from "./labelAlign.js";

// One font-size unit per character, so the widest line is easy to read off.
const measure = (line: string, fontSize: number): number => line.length * fontSize;

describe("realignedLabelX", () => {
  // Widest line "Carlisle" is 8 chars → 8 × 10 = 80 units wide.
  const label = { x: 100, text: "To\nCarlisle", fontSize: 10 };

  it("left → centre moves the anchor right by half the widest line", () => {
    expect(realignedLabelX({ ...label, align: "left" }, "center", measure)).toBe(140);
  });

  it("centre → right moves the anchor right by half the widest line", () => {
    expect(realignedLabelX({ ...label, align: "center" }, "right", measure)).toBe(140);
  });

  it("right → left moves the anchor left by the whole widest line", () => {
    expect(realignedLabelX({ ...label, align: "right" }, "left", measure)).toBe(20);
  });

  it("keeps x when the alignment does not change", () => {
    expect(realignedLabelX({ ...label, align: "center" }, "center", measure)).toBe(100);
  });
});
