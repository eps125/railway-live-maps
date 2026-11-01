import Konva from "konva";

export type LabelAlign = "left" | "center" | "right";

/** Where each alignment puts the anchor across the text block: 0 = its left edge, 1 = its right. */
const ANCHOR_FRACTION: Record<LabelAlign, number> = { left: 0, center: 0.5, right: 1 };

/** Width of one line as the editor canvas draws it: Konva's own measurement, at the label's
 * font size and Konva's default font, the same as the `Text` in EditorCanvas. */
export function konvaLineWidth(line: string, fontSize: number): number {
  return new Konva.Text({ text: line, fontSize }).getTextWidth();
}

/**
 * Owner report 2026-11-01: changing a label's alignment made it jump. A label's `x` is its text
 * anchor (`start` / `middle` / `end`), so keeping `x` while switching `align` moves the drawn
 * text by half or all of its width. This is the `x` that keeps the text block where it is:
 * shifted by the widest line's width times the change in anchor position.
 */
export function realignedLabelX(
  label: { x: number; text: string; fontSize: number; align: LabelAlign },
  align: LabelAlign,
  measureLine: (line: string, fontSize: number) => number = konvaLineWidth,
): number {
  if (align === label.align) return label.x;
  const width = Math.max(0, ...label.text.split("\n").map((l) => measureLine(l, label.fontSize)));
  return label.x + (ANCHOR_FRACTION[align] - ANCHOR_FRACTION[label.align]) * width;
}
