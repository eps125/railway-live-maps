# ADR 0004 — Map track/platform standardisation and visual model

## Status

Accepted 2026-09-07. Resolves the "open questions" of IMPLEMENTATION_PLAN.md Milestone 14
(public renderer visual polish). Does **not** change the status of CLAUDE.md non-negotiables 5
or 7 — it only restates the abeyance ADR 0002 already put them in.

## Context

The first public Lancaster map is drawn by `apps/web/src/map/MapRenderer.tsx` (plain SVG,
Milestone 5). Owner review on 2026-09-06/07 identified concrete defects and a direction:

- **Berths are not vertically centred on their bound track.** Berth `y` is an authored
  top-left coordinate with no enforced relationship to any track; the renderer ignores the
  `trackElementId` the berth already carries. In `packages/map-schema/fixtures/lancaster-minimal.json`
  the up-main track (`y = 300`) sits 8 px below the centre of berths 1–3 (`y = 280`, height 24).
- **Track polylines show wedge-shaped gaps where a diagonal meets a horizontal segment,**
  worse as the user zooms in. Each `trackPath` is a separate `<polyline>` with default `butt`
  caps and no `stroke-linejoin`; the flat ends of two distinct elements do not tile at an angle.
- **Tracks are free polylines with arbitrary geometry:** no standard vertical pitch for
  parallel running lines, no standard diagonal slope, segments do not share endpoints/nodes.
  This is the root cause of the junction gaps and blocks a consistent schematic look.
- **Platforms render as a bare thick line;** `number` / `name` / `tiploc` are carried but never
  shown. There is no `station` concept — station names are faked with `label` elements.
- Owner wants, later, a berthmaps-style "berth boxes only when occupied" presentation, and
  eventually line names / structures (tunnels, viaducts) / neutral sections / area boundaries.
- Owner asked whether a berth could carry a station CRS so a train in a "station berth" can be
  matched to a schedule before a TRUST activation exists.

Reference maps were inspected 2026-09-06/07, permitted by the owner as a one-off under
CLAUDE.md rule 14 (`open.berthmaps.mistral-data.net` was down; the OpenTrainTimes and Traksy
live SVGs were read directly):

- **OpenTrainTimes** (Waterloo): `.track { stroke:#000; stroke-width:4px }` — default
  butt/miter, **no junction dots anywhere** in the track layer. Each running line is **one
  continuous multi-vertex `<path>`** with the diagonal as an internal vertex, so
  `stroke-linejoin` handles the corner and there is nothing to gap (`M 5,20 260,20 350,200
2215,200`). Points/switches are short paired diagonal "blade" stubs. **Every diagonal is
  1:2** (26.57°). Row pitch **30**. Platforms are filled rects `fill:#40c040` (green) with a
  white bold number. Area boundary = dashed line (`.divide`); tunnel portals grey (`.portal`).
- **Traksy** (Kings Cross): platforms are `rect.plat` with **`fill:#FFA500` (orange), height
  34**, `stroke:none`, width proportional to platform length; the platform number sits in a
  **white box with a `#222` border, ~18 px** (`rect.plat-num-box`). Track is many
  `path.track normal` plus `path.track points normal` blade stubs (same pattern as OTT), heavy
  `polygon.direction` arrow chevrons, and a very wide single-axis (`viewBox` width 45760)
  horizontal scroll.

## Decision

### D1 — Berth vertical centring (defect fix, now)

Derive the berth's render rectangle at draw time from its bound track. A shared helper in
`@railway/map-schema` samples the `trackElementId` path at the berth's horizontal midpoint and
returns `{ x, y: trackY − height/2, width, height }`. Both `MapRenderer.tsx` and the editor
canvas consume it (CLAUDE.md rule 13). Fallbacks: no `trackElementId` → nearest horizontal
`trackPath` within the weld tolerance × 3 (18 units); none → authored `y`. No coordinate
migration; existing published maps self-correct because `trackElementId` is already in the
compiled bundle.

### D2 — Junction gaps (defect fix, now)

**No junction dots.** The structural fix is to render each running line as a single polyline
through its diagonals (produced by D3) with `stroke-linejoin="round"` on `trackPath`.
**Interim, before D3 lands:** a pass in `compileMapDocument` welds `trackPath` elements whose
endpoints coincide within the weld tolerance **and** are joined in `topology` into one
polyline, and `stroke-linejoin="round"` is set now. `stroke-linecap` stays `butt` (matches
OTT); rounded ends on real buffer stops are later polish.

### D3 — Track standardisation route

The renderer and compiled bundle keep today's `trackPath.points` shape; standardisation is an
authoring-time concern, not a canonical-format one for now.

**Correction (2026-09-08):** the original wording here ("Route C now — the editor authors
track as rows / segments / row-transitions and emits standardised polylines") described a
decision, but **Milestone 14a shipped no editor track-authoring changes at all** — track
drawing in the editor is still a freeform two-point polyline with draggable endpoints, any
angle, any position, and 14a's D2 weld runs only in `compileMapDocument` at publish (the editor
canvas still shows separate segments). Editor-side track standardisation is therefore unbuilt.
It is now split:

- **Interim (ADR 0005, Milestone 14c):** angle-snap the freeform track tool to `{0°, ±1:2}`
  plus a magnetic endpoint weld. No lane model, no schema change.
- **Route A (Milestone 14b):** a structural lane/row model (`track`, `trackSegment`,
  `row-transition`, `turnout`) in the canonical JSON, replacing free `trackPath` polylines.

The "Route C" hybrid (author in a lane model, emit polylines, keep the lane model in
`editorMetadata`) is not being pursued as a distinct step — 14c covers the immediate need and
14b is the durable form.

### D4 — Style profile

One shared constant module in `packages/map-schema`, consumed by compiler, renderer and editor:

| Constant                  | Value                                   | Note                                                                      |
| ------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| Row pitch                 | **30**                                  | matches OTT; owner may revisit                                            |
| Diagonal slope            | **1:2** (26.57°)                        | only permitted non-horizontal track angle (optional 1:1 for tight spaces) |
| Track stroke width        | 3                                       | casing 5 reserved for a later halo pass                                   |
| `stroke-linejoin`         | `round`                                 | `stroke-linecap` stays `butt`                                             |
| Berth box height          | 20                                      | fixed, centred on the row, divides the row pitch                          |
| Berth box width           | `chars × charWidth + 2 × pad`           | monospace; every 4-char berth identical                                   |
| Signal offset from track  | 12                                      | standard perpendicular gap                                                |
| Endpoint weld tolerance   | 6                                       | editor endpoint magnet + D2 interim weld                                  |
| Grid size                 | 10                                      | unchanged; 1/3 of row pitch                                               |
| Platform fill             | `#FFA500`                               | Traksy orange; CSS token `--map-platform-fill`, overrideable              |
| Platform schematic height | 12                                      | offset from the track by the signal-offset gap                            |
| Platform number box       | white fill, `#2d3644` border, dark text | Traksy pattern                                                            |

### D5 — Empty berths

Add a per-viewer "show empty berths" toggle, default **on** (parity with today). Off = only
occupied berths draw a box (berthmaps behaviour). The editor always shows empty-berth outlines.
Persisted in `localStorage` (wrapped in try/catch). The structural "berth = track span" model
is **deferred** with Route A.

### D6 — Stations and platforms (now)

- New `station` element: `{ id, layerId, type: "station", x, y, crs, name, tiploc? }` where
  `crs` is a 3-letter uppercase code. Renders the station name in one standard style. A zone
  bracket around member platforms is deferred.
- `berth` gains optional `stationId` and optional `crs`.
- `platform` rendering upgraded: bind to a track via the existing `trackElementId`, draw as a
  filled rectangle offset from the track by the standard gap, `fill = var(--map-platform-fill)`
  (`#FFA500`), with `number` shown in a white bordered box (Traksy pattern); `name` optional.
- `docs/MAP_EDITOR_SPEC.md` §3 is updated in the same change. The editor gains a Station tool
  and `stationId` / `crs` fields on the berth property panel.
- No rule impact: this is map-authoring metadata and must not gate ingestion (CLAUDE.md
  rule 17).

### D7 — Station-berth schedule deduction

**Deferred.** Matching a train in a station berth to a schedule with no TRUST activation is
run↔schedule correlation, which ADR 0002 defers to a dedicated later phase and for which
CLAUDE.md rules 5 and 7 remain held in abeyance. This ADR only:

1. Approves adding the **schema hooks** (`station.crs`, `berth.stationId`, `berth.crs`) now, as
   part of D6, with **no deduction logic attached**.
2. Records two spikes to run before the correlation phase is planned:
   - whether garner already exposes a berth-level `trust_id` / schedule deduction RLM should
     consume rather than rebuild (its `td_states` / `livesig` link is not currently mirrored —
     IMPLEMENTATION_PLAN.md Milestone 15, "Still deferred");
   - SMART coverage and quality for berth → STANOX nationwide (`smart_berth_step`), which would
     let the feature work without per-map `crs` authoring.
3. States the intended shape when that phase starts: berth → station TIPLOC (SMART-derived,
   authored `crs` as override) → candidate schedules with a calling point at that TIPLOC within
   ±5 min of `occupancy_entered_at`; an explicit `matchBasis` confidence enum
   `trust_activation > stp_precedence > station_berth_timetable > headcode_only`; the heuristic
   never overrides a TRUST pick; more than one candidate is always `ambiguous` (rule 7).
   Opening that phase needs its own ADR updating the abeyance status of rules 5 and 7.

## Consequences

- `packages/map-schema` gains a `station` element, two optional `berth` fields and a
  style-constant module; `MapElementSchema` grows by one variant. `schemaVersion` stays **1** —
  every addition is optional and additive.
- `MapRenderer.tsx` and the editor canvas both consume the new berth-rect helper and the style
  module. A visual-regression fixture is added per MAP_EDITOR_SPEC §12.
- The D2 interim weld runs in `compileMapDocument`; published bundle geometry changes only
  where segments were already coincident **and** topologically joined, covered by a compiler
  test.
- The existing published Lancaster map does not need republishing for D1/D2 (both derive from
  data already in the bundle). It does need re-authoring in the editor to benefit from D3/D6.
- Milestone 14 splits into an **active phase** (D1, D2 interim, D4 style tokens, D5 toggle, D6)
  and a **later phase** (D3 Route A lane model, D4 full structural form, D5 span model, D7
  correlation).
- No change to CLAUDE.md non-negotiables. Rules 5 and 7 stay in abeyance exactly as ADR 0002
  left them; D7 explicitly neither reinstates nor weakens them.
