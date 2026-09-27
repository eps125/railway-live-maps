import { describe, expect, it } from "vitest";
import type { BufferStopElement } from "./document.js";
import { bufferStopBounds, bufferStopDrawing, stopBoardParts } from "./drawing.js";
import { signalColor, signalPostGeometry } from "./signalGeometry.js";

const buffer = (over: Partial<BufferStopElement> = {}): BufferStopElement => ({
  id: "b1",
  layerId: "track",
  zIndex: 1,
  type: "bufferStop",
  x: 100,
  y: 50,
  facing: "left",
  ...over,
});

describe("bufferStopDrawing (2026-09-27)", () => {
  it("is 10 across the track and 5 deep, its face at x/y", () => {
    const drawing = bufferStopDrawing(buffer());
    expect(drawing).toMatchObject({ x: 100, y: 50, scaleX: 1, rotation: 0 });
    for (const part of drawing.parts) {
      if (part.kind !== "rect") continue;
      expect(part.x).toBeGreaterThanOrEqual(0);
      expect(part.x + part.width).toBeLessThanOrEqual(5);
      expect(part.y).toBeGreaterThanOrEqual(-5);
      expect(part.y + part.height).toBeLessThanOrEqual(5);
    }
    expect(bufferStopBounds(buffer())).toEqual({ x: 100, y: 45, width: 5, height: 10 });
  });

  it("is mirrored for a line ending on the left", () => {
    expect(bufferStopDrawing(buffer({ facing: "right" })).scaleX).toBe(-1);
    expect(bufferStopBounds(buffer({ facing: "right" }))).toEqual({
      x: 95,
      y: 45,
      width: 5,
      height: 10,
    });
  });

  it("draws Rawie by default and hydraulic when chosen", () => {
    const rawie = bufferStopDrawing(buffer()).parts;
    const hydraulic = bufferStopDrawing(buffer({ style: "hydraulic" })).parts;
    expect(rawie.some((part) => part.kind === "polygon")).toBe(true); // the sloping frame
    expect(hydraulic.some((part) => part.kind === "polygon")).toBe(false);
    expect(hydraulic).not.toEqual(rawie);
  });
});

describe("stop board (2026-09-27)", () => {
  it("has no post and lies along the track with its disc leading", () => {
    const right = signalPostGeometry({ appliesTo: "right", signalType: "stopBoard" })!;
    expect(right.post).toBeNull();
    // 13 long (a post and head), 9.5 deep, 1 clear of the 3-wide track's edge.
    expect(right.head).toMatchObject({ kind: "board", x: 6.5, y: -7.25, rotation: 90 });
    const left = signalPostGeometry({ appliesTo: "left", signalType: "stopBoard" })!;
    expect(left.head).toMatchObject({ kind: "board", x: -6.5, y: 7.25, rotation: -90 });
    expect(left.headCentre).toEqual({ x: -6.5, y: 7.25 });
  });

  it("faces right when it has no direction yet", () => {
    expect(signalPostGeometry({ signalType: "stopBoard" })?.appliesTo).toBe("right");
  });

  it("is always red, whatever the state", () => {
    for (const state of ["blank", "on", "off"] as const) {
      expect(signalColor("stopBoard", state)).toBe("#d7263d");
    }
  });

  it("is a white board with the disc at the top and 'Stop' below it, cut out from the platform", () => {
    const [cut, board, disc, text] = stopBoardParts();
    expect(cut).toMatchObject({ kind: "rect", fill: "#0d1117", width: 11, height: 14.5 });
    expect(board).toMatchObject({ kind: "rect", width: 9.5, height: 13, fill: "#f5f7fa" });
    expect(disc).toMatchObject({ kind: "circle", cx: 0, r: 3.1 });
    expect(text).toMatchObject({ kind: "text", text: "Stop", bold: true });
    if (disc?.kind !== "circle" || text?.kind !== "text") throw new Error("shape");
    expect(disc.cy).toBeLessThan(text.y);
  });
});

describe("signal cut-out (2026-09-27)", () => {
  it("is 0.75 either side of the post and round the head, in the map background", () => {
    const g = signalPostGeometry({ appliesTo: "right" })!;
    expect(g.cutout).toEqual({ color: "#0d1117", postWidth: 3.5, headStroke: 1.5 });
    expect(g.headCentre).toEqual({ x: 8, y: -8.5 });
  });
});
