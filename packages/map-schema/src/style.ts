/**
 * D4 style profile — see `docs/adr/0004-map-track-platform-standardisation.md`.
 *
 * Single source of truth for map geometry constants and colour tokens, imported by the
 * compiler, the public SVG renderer (`apps/web/src/map/MapRenderer.tsx`) and the editor canvas
 * (`apps/web/src/editor/EditorCanvas.tsx`) so no literal is duplicated across the three
 * (CLAUDE.md rule 13 — one domain model, two renderers).
 *
 * `rowPitch` is provisional: it matches OpenTrainTimes' de-facto pitch of 30, and the owner
 * has flagged it as a value that may change. Everything downstream reads it from here, so a
 * change is a one-line edit.
 */
export const MAP_STYLE = {
  /** Vertical gap between adjacent parallel running lines. */
  rowPitch: 30,
  /** The only permitted non-horizontal track slope: rise / run = 1 / 2 (~26.57°). */
  diagonalSlope: 0.5,
  track: {
    strokeWidth: 3,
    /** Wedge-gap fix (ADR 0004 D2): round joins on the (welded) continuous polyline. Caps
     * stay `butt`, matching OpenTrainTimes — rounded ends on real buffer stops are later polish. */
    strokeLinejoin: "round",
    strokeLinecap: "butt",
    color: "#3d4a5c",
  },
  berth: {
    /** Fixed; the box is centred on its bound track's row. Divides `rowPitch`. */
    height: 20,
    /** Monospace advance per description character, plus `padding` on each side, gives the box
     * width — so every 4-character berth is identical. */
    charWidth: 8,
    padding: 6,
  },
  signal: {
    /** Standard perpendicular gap from the bound track to the signal head. */
    offset: 12,
    radius: 6,
  },
  platform: {
    /** Schematic bar thickness. */
    height: 12,
    /** Gap from the bound track to the near edge of the bar. */
    offset: 12,
    /** Side of the square white platform-number box. */
    numberBox: 16,
    /** Konva has no CSS custom properties; the editor canvas uses this hex directly. The public
     * SVG renderer uses `var(--map-platform-fill, …)` with this as the fallback. */
    color: "#ffa500",
  },
  /** Editor endpoint magnet, and the compiler's coincident-endpoint weld (ADR 0004 D2). */
  weldTolerance: 6,
} as const;

/** CSS custom properties the public renderer reads for themeable colours (defined on `:root`
 * in `apps/web/src/styles.css`). Each renderer call pairs the token with a hard fallback so a
 * missing stylesheet (e.g. jsdom tests) still paints something sensible. */
export const MAP_CSS_TOKENS = {
  platformFill: "--map-platform-fill",
  platformNumberFill: "--map-platform-number-fill",
  platformNumberBorder: "--map-platform-number-border",
  platformNumberText: "--map-platform-number-text",
  stationLabel: "--map-station-label",
} as const;
