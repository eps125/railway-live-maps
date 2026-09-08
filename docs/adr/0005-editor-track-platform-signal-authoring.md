# ADR 0005 — Editor authoring: track snapping, multi-vertex platforms, independent platform numbers, signal render modes

## Status

Accepted 2026-09-08. Builds on ADR 0004 (whose D3 wording is corrected in that document to note
that Milestone 14a shipped no editor track-authoring changes). Implemented as Milestone 14c.
No change to CLAUDE.md non-negotiables.

## Context

After Milestone 14a the editor still draws track as a freeform two-point polyline at any angle,
and 14a's junction-gap weld runs only at publish. Separately the owner wants richer platform
geometry and a choice of signal styles before committing to one:

- Platforms are single straight bars; real platforms are L-shaped / stepped and need arbitrary
  corners added and removed case by case.
- The platform number is a sub-field of the `platform` element (`platform.number`); the owner
  wants it as an independent, separately-placeable item sitting **above** the platform.
- Platforms and their numbers should live on their **own layer** (numbers painting above
  platforms within it), not mixed onto the Track layer as they are today.
- Signals currently render as a filled circle sitting on the track. The owner wants an
  alternative "offset" style — a stem out to a head set off the track, loosely inspired by
  OpenTrainTimes (`.stem { stroke-width:2 }` + `.aspect` head + `.sig_id` below, drawn as
  left/right-facing `g.sig` groups) but not a copy — selectable per signal so both can be
  compared and one dropped later.
- Adding/removing polyline vertices has no editor affordance at all today (only moving the two
  default endpoints).

## Decision

### E1 — Track tool: angle-snap + magnetic endpoint weld (ADR 0004 D3 "interim")

The freeform `trackPath` tool gains, in the editor only (no schema change, no lane model):

- **Angle-snap** while dragging an endpoint: the segment relative to its other end snaps to the
  **nearest** of `0°`, `±1:2` (≈26.57°), `±1:1` (45°) and `90°` — there is no tolerance window
  (a hand-drawn track cannot take an arbitrary angle); holding Alt disables it for a genuinely
  free segment. `1:2` is the standard diagonal (ADR 0004 D4); `1:1` is the permitted steeper
  option. The snapped endpoint's **distance along the ray** is quantised to the grid (not `x`
  and `y` independently, which would pull it back off the angle). _Revised 2026-09-08: the
  original 6° threshold was too narrow to feel like it worked; snapping is now unconditional._
- **Magnetic endpoint weld**: an endpoint dropped within `MAP_STYLE.weldTolerance` of another
  track endpoint snaps exactly onto it, and a `topology` node + edge linking the two segments
  is created if absent — so the publish-time weld (ADR 0004 D2) then actually fires and the
  editor preview and public map agree.

Route A (the structural lane/row model) stays Milestone 14b.

### E2 — Multi-vertex shapes + vertex add/remove tooling

`trackPath` and `platform` already allow `points` ≥ 2; no schema change. The editor gains, for
a selected points-based element:

- **Add vertex** — double-click on a segment (a platform polygon's closing edge included)
  inserts a grid-snapped point, splitting that segment.
- **Remove vertex** — double-click a vertex handle; blocked below 2 points for a `trackPath`
  and below 3 for a platform polygon.
- Both are a single `setProperty { property: "points" }` command, so undo/redo already covers
  them.

**Revision (2026-09-08):** a `platform` with 3+ points is a **filled polygon** — its `points`
are the shape outline, so vertices vary its width (L-shaped platforms, bays, tapers), not a
thick stroked line. The new-platform default is a rectangle. A legacy 2-point platform still
renders as a standard-height bar. `trackPath` stays an open polyline. Platform corners (and
platform / platform-number placement and moves) snap to **half the grid step** so a shape edge
can sit between grid lines; everything else stays on the full grid.

### E3 — Independent `platformNumber` element + Platforms layer

- **New element** `platformNumber`: `{ id, layerId, type: "platformNumber", x, y, text,
platformId? }`. Renders as the white bordered box + number (the Traksy pattern already in
  `MapRenderer`), positioned freely — the author places it above its platform. `platformId` is
  an optional soft link for future grouping; nothing enforces it.
- `platform.number` is **deprecated and no longer rendered** (revised 2026-09-08 — the earlier
  "still drawn for old maps" behaviour was dropped: two number mechanisms was confusing). The
  field is still parsed so old documents load; only a standalone `platformNumber` element
  produces a number box now, and it uses the same white-box style the auto number used.
  `schemaVersion` stays 1. **Consequence:** a map published before 0005 that relied on
  `platform.number` shows no platform number until re-authored — Lancaster needs re-authoring
  for the filled platforms anyway.
- **Layer**: the editor ensures a layer named `Platforms` exists (creating it, ordered just
  below the Berths layer, when the Platform or Number tool is first used and none matches) and
  defaults both `platform` and `platformNumber` onto it. Within the layer, `platformNumber`
  elements get a small positive `zIndex` so they always paint above `platform` bars. The blank
  new-map scaffold (`apps/api/src/editor/draftStore.ts`) gains Track / Platforms / Berths /
  Signals / Labels layers instead of the single "Default".

### E4 — Signal render mode: `inline` vs `offset`

- **Schema**: `signal` gains `renderMode: z.enum(["inline", "offset"]).default("inline")`.
  Additive/optional; `schemaVersion` stays 1.
- **`inline`** — today's behaviour exactly: a filled `MAP_STYLE.signal.radius` circle at
  `(x, y)` in the aspect colour, label offset to the side.
- **`offset`** — OTT-inspired, not identical: a short stem (`MAP_STYLE.signal.offset` long)
  from `(x, y)` perpendicular to the local track direction, ending in a filled circle head in
  the aspect colour with a thin dark outline; the label sits centred beneath the head. Which
  side the stem goes is driven by the existing `orientation` field (0 → one side, 180 → the
  other). No aspect calculation changes — still blank/​on/​off only (CLAUDE.md rule 9).
- **Editor**: a checkbox in the signal property panel flips `renderMode`. Both styles ship;
  the owner picks one to keep later and the other is removed then.

## Consequences

- `packages/map-schema`: one new element variant (`platformNumber`), one new optional `signal`
  field (`renderMode`); `MapElementSchema` grows by one; `schemaVersion` stays 1.
- `MapRenderer.tsx` + `EditorCanvas.tsx`: `platformNumber` render (shared), signal `offset`
  branch (shared), vertex add/remove handlers (editor), angle-snap/weld helpers (editor).
  `platform.number` rendering kept for back-compat.
- `apps/api/src/editor/draftStore.ts`: multi-layer blank scaffold. Existing drafts are
  unaffected — the editor creates the Platforms layer on demand.
- Existing published maps: unchanged; `platform.number` still renders. Re-authoring in the
  editor moves numbers to `platformNumber` elements.
- No DB migration. No API contract change (compiled bundle just carries the new element type).
- `docs/MAP_EDITOR_SPEC.md` §3/§7 updated in the implementing change.
