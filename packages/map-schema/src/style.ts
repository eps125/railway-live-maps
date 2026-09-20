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
    /** The only public signal states (CLAUDE.md rule 9, PROJECT_SPEC §6): red = on, green = off,
     * grey = blank (unmapped/unknown). Shared by the public renderer and the editor so a bound
     * signal looks the same in both (rule 13). */
    stateColors: { blank: "#5f6b7a", on: "#f85149", off: "#3fb950" },
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
  /**
   * Lineside feature symbols reproduced from the real signage — the first of a planned family
   * (tunnels, viaducts and signal boxes are later work).
   *
   * Sign **AJ02 Issue 1** (RSSB, June 2015), "Neutral Section Indication Board": a 600x600 white
   * board with a 30-unit corner radius carrying a black symbol of two vertical bars 70 wide and
   * 60 apart, inset 40 from the top and bottom, each with an 80-tall arm running *outward* to 50
   * from the board edge. Every fraction below is that drawing's own dimension over 600, so
   * `neutralSectionGeometry` scales the symbol with the element's `size` and it stays true to the
   * sign at any zoom.
   */
  neutralSection: {
    /** Default board side, in map units, for a newly placed sign: 2x2 default grid squares
     * (`canvas.gridSize` is 10 — owner request 2026-09-20). The board is square, and the size is
     * per-element and author-editable, so this is only the starting value. */
    size: 20,
    cornerRadius: 30 / 600,
    barWidth: 70 / 600,
    barGap: 60 / 600,
    barInsetY: 40 / 600,
    armHeight: 80 / 600,
    armInsetX: 50 / 600,
    /** The sign's own colours ("Black symbol on a White background") rather than the dark map
     * palette — the point of the symbol is that it looks like the real board. */
    boardFill: "#ffffff",
    symbolFill: "#111111",
    /** Thin outline so a white board still reads as a board against the dark canvas. */
    boardStroke: "#0d1117",
    labelFill: "#c9d1d9",
  },
  /** Milestone 55: the shared look of a placed label — the caption a piece of map furniture
   * (neutral section, tunnel, viaduct, water, level crossing) carries, attached to one side of
   * its shape or detached to a free offset. One set of values so every such label matches. */
  placedLabel: {
    /** Gap between the shape's edge and the near edge of the label. */
    gap: 4,
    fill: "#c9d1d9",
    fontSize: 10,
  },
  /** Milestone 55. Track in tunnel: a dark bore with a dashed portal outline — the schematic
   * convention, and it reads correctly painted *under* the rails (`zIndex: -1`). */
  tunnel: {
    fill: "#111820",
    stroke: "#7c8899",
    strokeWidth: 1.5,
    /** SVG `stroke-dasharray` / Konva `dash`. */
    dash: [6, 4],
  },
  /** Milestone 55. A viaduct is drawn like a track path but as a wider, stone-coloured deck
   * painted beneath the rails, so the line visibly runs *over* it rather than the deck hiding
   * it — which is what a same-width line in a different colour would do. */
  viaduct: {
    color: "#6d6255",
    /** Default deck width = the track stroke width plus this. Author-editable per viaduct
     * (owner request 2026-09-20), so this is only the starting value. */
    extraWidth: 7,
  },
  /** Milestone 55. Rivers, docks, the sea: a filled body with a lighter bank outline. Painted
   * below the track (`zIndex: -1`) so a river crosses *under* the railway. */
  water: {
    fill: "#16384f",
    stroke: "#2d7098",
    strokeWidth: 1,
  },
  /**
   * Milestone 55: a level crossing — the road drawn across the railway, with an optional pair of
   * barriers whose position comes only from a bound S-Class bit (ADR 0014), never inferred.
   *
   * `roadLength` runs *across* the track, `roadWidth` *along* it, both in map units; a barrier
   * sits `barrierDistance` (a fraction of `roadLength`) out from the track centre on each side.
   */
  levelCrossing: {
    roadLength: 34,
    roadWidth: 16,
    roadColor: "#9aa4b1",
    roadStrokeWidth: 1.5,
    barrierDistance: 0.3,
    barrierStrokeWidth: 2.5,
    /**
     * A barrier's *physical position*, not a signal aspect — CLAUDE.md rule 9 governs signal
     * aspects and none of this claims one. `down` is red because the road is blocked, `up` green
     * because it is clear, `blank` grey for an unbound crossing or one whose bit isn't currently
     * trustworthy.
     */
    stateColors: { blank: "#5f6b7a", up: "#3fb950", down: "#f85149" },
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
  tunnelFill: "--map-tunnel-fill",
  viaductColor: "--map-viaduct-color",
  waterFill: "--map-water-fill",
  levelCrossingRoad: "--map-level-crossing-road",
  neutralSectionBoard: "--map-neutral-section-board",
  neutralSectionSymbol: "--map-neutral-section-symbol",
} as const;
