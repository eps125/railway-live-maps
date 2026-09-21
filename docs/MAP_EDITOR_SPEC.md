# Canonical Map Format and Visual Editor

## 1. Core rule

The map editor edits a versioned, renderer-independent document. The canonical output is JSON. React components, SVG markup and Konva nodes are runtime representations only.

The same canonical document drives:

- public SVG rendering
- editor canvas rendering
- live state binding
- historical playback
- validation
- publication and version comparison

## 2. Document outline

```json
{
  "schemaVersion": 1,
  "map": {
    "id": "lancaster",
    "name": "Lancaster",
    "canvas": { "width": 5000, "height": 1600, "gridSize": 10 },
    "timezone": "Europe/London"
  },
  "layers": [],
  "elements": [],
  "topology": { "nodes": [], "edges": [] },
  "bindings": [],
  "editorMetadata": {}
}
```

Published compilation removes editor-only metadata and precomputes lookup indexes and bounds.

## 3. Element types for MVP

### `trackPath`

A schematic polyline with stable element ID, layer, points, line/direction metadata and optional topology edge association.

### `berth`

- position and dimensions
- text alignment/font size constraints
- display name
- binding reference
- optional associated track/topology element
- click target/tooltip metadata
- optional `stationId` (link to a `station` element) and optional `crs` — map-authoring
  metadata for the deferred station-berth schedule deduction (ADR 0004 D6/D7); no runtime
  behaviour yet, and it never gates ingestion (rule 17).
- optional `inhibitedBy` (2026-09-11 owner request): the id of another `berth` element on the
  same map, declaring a TD-area fringe/boundary pair — the same physical crossing reported
  independently by two describers (e.g. `PX CE04` / `CL 0005`). Author-declared only, never
  inferred, and makes no claim about run identity (distinct from the deferred berth-run
  resolver, CLAUDE.md rule 5/7). Purely a live-rendering rule: when this berth's and the
  referenced berth's _current_ descriptions are equal and non-null, this berth renders blank —
  both the public SVG renderer and the editor's own Test-mode preview apply the identical
  check, independently (they are deliberately separate implementations, not shared rendering
  code — CLAUDE.md rule 13 covers shared domain model/state semantics, not this). Cosmetic
  only: `berth_current_state`, `berth_occupancy`, history and playback all keep both berths'
  real, individual data untouched.
- **Combined berths** (Milestone 50, owner request 2026-09-17): a physical split-berth group used
  for permissive working — e.g. a 3- or 4-way platform split with no room to draw each member
  separately — can share one berth element instead. Author-declared, kept a rare exception: in the
  Properties panel, a bound berth's "+ Combine with another berth" button adds up to 3 more
  TD area/berth member rows (max 4 total). When 2+ members are simultaneously occupied, the shared
  box shows every occupied member's description joined with a space, in the author-set order —
  e.g. `A001 B001` — rather than just whichever one changed last. Purely a display join: each
  member keeps its own real `berth_current_state`/`berth_occupancy`/history untouched, same
  "cosmetic only" precedent as `inhibitedBy` above. The canonical representation is exactly what
  it looks like — more than one `tdBerth` binding (§4 below) sharing one `elementId`, each carrying
  a `combinedOrder` (1-4) for the join order; a lone binding never sets it. In the editor canvas
  only (not the public map), a combined berth's box is drawn with a dashed outline instead of
  solid, so the author can spot one at a glance. The click-a-berth run popup shows every currently
  occupied member's detail successively, each under its own `tdArea berth` heading, separated by a
  divider — not just one member — and closes only once every member has gone vacant.

The renderer does not trust the authored top-left `y`: when a berth is bound to a track
(`trackElementId`, or the nearest horizontal `trackPath` in range) its box is drawn vertically
centred on that line at the berth's horizontal midpoint (`berthRenderRect`, shared by the SVG
renderer and the editor canvas — ADR 0004 D1). A per-viewer "show empty berths" toggle can
hide vacant boxes entirely (ADR 0004 D5).

### `signal`

- position and orientation
- signal label
- symbol style
- optional associated track
- optional future S-Class binding
- `renderMode` (ADR 0005 E4): absent / `inline` = head on the track at `(x, y)` (today's look);
  `offset` = a short stem out to a head set off the track, side from `orientation`. Both ship
  until the owner picks one. No aspect change either way.

For Lancaster, no S-Class binding is required and operational state is blank.

### `platform`

A **filled shape** in `--map-platform-fill` (Traksy orange by default). With 3+ points those
`points` are the polygon outline, so vertices vary its width and shape (L-shaped platforms,
bays, tapers); a legacy 2-point platform renders as a standard-height bar, still offsettable to
the far side of a bound `trackElementId`. Optional `name` / `tiploc` / `stationId`. `number` is
**deprecated and no longer rendered** (ADR 0005 E3 rev.) — still parsed so old documents load,
but only a standalone `platformNumber` element produces a number now. The editor: double-click
an edge to add a corner, double-click a corner handle to remove it (≥ 3 points), drag corners
to reshape.

### `platformNumber`

The platform number as an independent, freely-placed item (ADR 0005 E3): `text`, position,
`fontSize`, optional `platformId` soft link. Renders as the white bordered box + text. Lives on
the Platforms layer with a small positive `zIndex` so it paints above the bars.

### `station`

A named station: `crs` (optional 3-letter code), `name`, optional `tiploc` and (Milestone 31)
`stanox`, position and font size. Renders `name` (plus `[CRS]`) in the standard station-label
style; `tiploc`/`stanox` are not rendered — they're place identifiers for
`GET /api/v1/places/search` (see §"Place search" below). The `crs` is also the hook the deferred
station-berth schedule deduction (ADR 0004 D7) will build on. A zone bracket around member
platforms is later work.

**Multi-line names** (Milestone 53, owner request 2026-09-20): `\n` in `name` stacks it into
centred lines, exactly as a `label` already did — long names need the vertical space on a crowded
schematic. The public SVG renderer emits one `<tspan>` per line (each re-anchored at the element's
own `x`, so the block stays centred) and Konva wraps natively on the same newlines; a `[CRS]`
suffix goes on the **last** line in both, so it reads as part of the name rather than floating on
its own row. The Properties panel's station **Name** field is a textarea for this. Anywhere a
station name is shown as a single run of text — the berth Properties panel's station picker —
newlines are flattened to spaces.

### `neutralSection`

**Milestone 53 (owner request 2026-09-20).** An AC neutral section, drawn as the real lineside
board: **Sign AJ02 Issue 1**, "Neutral Section Indication Board" (RSSB, June 2015) — a white
rounded square carrying the black two-bar symbol, reproduced to that drawing's own proportions.
Fields: `x`/`y` (the **centre** of the board, unlike a berth's top-left, so `size` scales it about
the point it sits on), `size` (the board's side in map units; default 20 = two default grid
squares, author-editable per sign), optional `label`, `labelPosition` (`above`/`below`/`left`/
`right`, default `below`), optional `labelOffset` and `fontSize`.

**Half-grid placement** (owner request 2026-09-20): a sign places and drags on `gridSize / 2`
rather than the full grid, joining `platform` and `platformNumber` in `snapStep`'s half-grid set
(`EditorCanvas.tsx`) — a full grid square is a coarse jump for a symbol only two squares across.

**Detached label** (same request): setting `labelOffset` frees the label from its
`labelPosition` anchor so it can go wherever is convenient on a crowded schematic. It is an
**offset from the board's centre**, not an absolute point, so the label still travels with the
sign when the sign is moved and survives copy/paste. While set, `labelPosition` is ignored (but
retained, so re-attaching restores the side last chosen) and the label is centred on the offset
point. In the editor, "Detach label" seeds the offset with the label's _current_ drawn position
so it never jumps, the label then becomes independently draggable on the canvas (Konva gives a
draggable child priority over its draggable parent, so grabbing the board still moves the whole
sign), and "Reattach label" clears it.

`neutralSectionGeometry` (in `packages/map-schema`) derives the board rect, the four black symbol
rects and the label anchor from `MAP_STYLE.neutralSection`, whose fractions are the AJ02 drawing's
dimensions over 600 — so the symbol stays true to the sign at any size, and the public SVG
renderer and the editor canvas draw an identical sign from one source (CLAUDE.md rule 13).

Display only, exactly like a `label`: no binding, no live state, no projection, and nothing is
inferred from or about it (rules 9/10). It is the first of the lineside-feature family the owner
has flagged as coming next (tunnels, viaducts, signal boxes), so its shape is deliberately generic
— a point, a scale and an optional placed label, with only the symbol itself specific to AJ02. New
signs land on the **Labels** layer (the conventional stack has no lineside-feature layer, and
adding one to fresh documents would leave already-drafted maps falling back to Track); a dedicated
layer is an option once the family has more members.

### Placed labels (shared)

**Milestone 55.** `neutralSection`, `tunnel`, `viaduct`, `water` and `levelCrossing` all carry the
same optional caption, declared once as `placedLabelFields` and resolved by one helper,
`placedLabelAnchor(bounds, label)`:

- `label` — the text; absent means no caption is drawn at all.
- `labelPosition` — `above`/`below`/`left`/`right` (default `below`), placing it just outside the
  element's own bounds.
- `labelOffset` — **detaches** the label (owner request 2026-09-20). An offset from the **centre of
  the element's bounds**, not an absolute point, so a detached label travels with its shape and
  survives copy/paste. While set, `labelPosition` is ignored but retained, so re-attaching restores
  the side last chosen; the label is centred on the offset point.
- `fontSize`.

In the editor, "Detach label" seeds the offset from the label's _current drawn position_ so it
never jumps, the label then becomes independently draggable on the canvas (Konva gives a draggable
child priority over its draggable parent, so grabbing the shape still moves the whole shape), and
"Reattach label" clears it.

### `tunnel`, `viaduct`, `water`

**Milestone 55 (owner request 2026-09-20).** Three scenery types, all carrying placed labels:

- **`tunnel`** — a reshapeable polygon, drawn exactly like a `platform` (drag corners,
  double-click an edge to add one, double-click a corner to remove it). Rendered as a dark bore
  with a dashed portal outline.
- **`water`** — the same polygon model, for rivers, docks and coastlines, in any orientation. A
  river crossing the railway at right angles is the common case but nothing restricts it.
- **`viaduct`** — a polyline, drawn like a `trackPath`, rendered as a wider stone-coloured deck.
  Deliberately **not** welded by `weldTrackPaths` and never part of `topology`: it is scenery that
  follows the track, not track.

Selecting any of the three shows draggable **vertex handles** (corners on a tunnel/water
polygon, endpoints on a viaduct): drag to reshape, double-click an edge to add a vertex,
double-click a vertex to remove one. A viaduct carries an author-set `width` (its deck width; a
viaduct authored before that field existed falls back to the track-derived default via
`viaductWidth`), and a tunnel's **Width** field scales its outline about its own centre
(`scaleShapeWidth`), so setting the bore width leaves the tunnel's length and position untouched.

All three place and drag on **half-grid** steps (they are traced over real features, not aligned
to the grid) and are placed with **`zIndex: -1`**, which paints them below the rails within their
own layer. A newly seeded map also gets a **Scenery** layer below Track; an already-drafted map
has no layer under Track, so the negative `zIndex` is what makes "below the track" true there.
A viaduct goes on the **Track** layer, with the line it carries.

Scenery only: no binding, no live state, nothing inferred (CLAUDE.md rules 9/10).

### `levelCrossing`

**Milestone 55, [ADR 0014](adr/0014-level-crossing-barriers-from-s-class.md).** The road drawn
across the railway. `x`/`y` is the point on the track it crosses; `orientation` is the road's
angle in degrees (0 = square across a horizontal track); `roadLength` runs across the track and
`roadWidth` along it. `crossingType` (MCB, AHB, UWC …) is an author's note — never rendered, and
it never affects the display.

Barriers are drawn as two half-barriers on **diagonally opposite posts**, each at one edge of
the road and one side of the railway (owner design 2026-09-20). `up` parks them along the road
edge pointing away from the railway (perpendicular to the track) so a raised pair frames the
crossing; `down` swings them 90 degrees about the same posts to lie across the road (parallel to
the track), meeting in the middle. It is a true rotation — same post, same arm length — so the two
states read as one mechanism. `blank` uses the lowered, track-parallel geometry in grey, which is
what the owner asked an unmapped crossing to look like; grey means "no information", never "up".

Barriers are **optional and never inferred**. A crossing shows barrier positions only when bound
to one S-Class bit by a `tdSBitBarrier` binding, which states in the barrier's own vocabulary what
a set bit means (`up`/`down`), verified per crossing and never assumed. Displayed positions are
red = down, green = up, grey = **blank**, where blank means unbound, unknown, or a feed gap — and
must never be read as "up". A barrier position is not a signal aspect: rule 9's blank/on/off
vocabulary is untouched by it, and rule 10's "never infer" applies in full. See the ADR for how
this reuses the signal state machinery with only a vocabulary conversion at the edges.

Expect grey barriers when scrubbing playback back beyond an area's decoded S-Class history: like
signals, a crossing resolves from decoded `td_s_event` rows, and history predating Milestone 36a
is undecoded until that area is backfilled. Grey there means "not recorded", not "up".

**Realistic barriers (Milestone 58, owner request 2026-09-21).** An optional
`realisticBarriers` tickbox ("Realistic crossing barriers") swaps the schematic lines for a drawing
that looks like the real thing: asphalt on each approach with a dashed white centreline, and on
each side of the railway a red-and-white banded arm lowered across the road with a white picket
skirt hanging beneath it. It is drawn as if viewed from a slight angle, not strictly top down
(owner), which is what lets the skirt read as a fence below the arm; at the usual orientation 0
both skirts hang straight down. The arms sit exactly where the schematic `down` arms do, so ticking
the box restyles a crossing without moving anything, and the band count is always odd so both ends
of an arm are red.

It is **always the down pose** and is **only offered on a crossing with no S-Class binding** —
a fixed piece of scenery, not a barrier position (see the ADR 0014 addendum). The tickbox is
disabled on a bound crossing, binding is refused while it is ticked, `validateMapDocument` rejects
the combination (`realistic_barriers_on_bound_crossing`), and the public renderer falls back to
the live state if one ever arrives for a realistic crossing. The span between the two barriers is
left unsurfaced on purpose: a crossing paints above the rails, so a solid road there would hide the
running line, whereas leaving it open keeps every track through the crossing visible without
splitting the element across paint layers. Drawn from `realisticLevelCrossingGeometry`, shared by
the public renderer and the editor canvas (CLAUDE.md rule 13).

### `label`

Plain sanitized text with position, alignment and size. `\n` in the text wraps to a new line
(rendered as stacked `<tspan>`s); `station.name` wraps the same way. The editor's label Text
field is a textarea. `align` (left/center/right, defaults to **center** as of 2026-09-11 — a
multi-line label reads oddly left-anchored by default) is editable via the Properties panel's
"Align" field; both renderers already center each wrapped line correctly (SVG `textAnchor` per
`<tspan>`, Konva `align` + a fixed layout width in `anchoredText`). Milestone 31 (owner request):
a label can also carry optional `crs`/`tiploc`/`stanox` — the same place identifiers a `station`
already had — so a junction (which gets a plain label, not a `station` element) is searchable by
name or identifier too. Not rendered, same as a station's `tiploc`/`stanox`.

Milestone 32, folded into `label` 2026-09-13 (owner request — no separate element type for this,
normal label style preferred): a label can also carry optional `adjacentMapSlug`/
`adjacentBoundaryName`/`direction` to become a **boundary link**. `adjacentBoundaryName` names
this same physical boundary as it's authored on the adjacent map — kept separate from the label's
own `text` because the two sides are typically named from their own perspective (e.g. one map's
"Carlisle PSB" is the other's "Preston PSB" for the identical crossing), not assumed to match.
When `adjacentMapSlug` is set the label is clickable on the public map (still rendered in the
normal label style — no marker or icon) and jumps to `/map/<adjacentMapSlug>` centred on the
target map's own label (or legacy `boundary` element, see below) of that name; falls back to the
target's default view (never errors) if nothing matches there.

### Place search (Milestone 31)

Any `station` or `label` carrying at least one of `crs`/`tiploc`/`stanox` becomes a row in
`map_place_index` at publish time (`compileMapDocument`'s `placeBindingIndex`, parallel to
`berthBindingIndex`/`sBitBindingIndex` but for discovery rather than live delta routing — no
uniqueness enforced, since this isn't a routing-correctness-critical path).
`GET /api/v1/places/search?q=` (public) matches the query against `location_reference`
(CORPUS-sourced, nationwide, already ingested — no new ingestion needed) by name/CRS/TIPLOC/STANOX,
left-joined against `map_place_index` restricted to each map's currently-effective version. A hit
with a covering map is clickable straight to `/map/{slug}?center={elementId}`, which centres the
public renderer's initial view on that element (`MapRenderer`'s `centerElementId` prop); a hit
with no covering map renders inert ("not on any published map yet") rather than erroring — map
scope never gates capture, but it can gate what a search can jump to (CLAUDE.md rule 17).

### Map metadata

`map.name` is the map's display heading on the public renderer (e.g. "Preston PSB") and is
editable in the editor's Properties panel when nothing is selected — the per-map variable for
naming as more maps are authored. `map.id` (the slug) is fixed.

Optional `map.homePoint` (owner request, 2026-09-16), also editable there as X/Y fields: the point
the public renderer centres its fixed-magnification default view on for a visitor with no
remembered view yet — a landing-page click-through, or the "Reset view" button — instead of the
map's plain bounding-box centre. An explicit boundary-link or places-search click-through
(`?boundary=`/`?center=`) still takes priority over it, and a returning visitor's saved pan/zoom
(`localStorage`, per map) is untouched either way.

### `boundary` (legacy)

Superseded 2026-09-13 by `label`'s `adjacentMapSlug`/`adjacentBoundaryName`/`direction` fields
above (owner request: no separate element type, normal label style preferred). Same shape and
behavior as a boundary-carrying label, kept parseable/renderable only so already-published
immutable map versions (CLAUDE.md rule 11) that still contain one keep working; the editor no
longer offers a tool to author new ones (its Properties panel still edits an existing one, for
whichever map still has one).

### `group/templateInstance`

Used for editor operations. Published output may flatten simple groups while preserving stable child IDs.

## 4. Separation of concerns

### Geometry

Position, size, rotation, points and visual style token.

### Railway topology

Logical connectivity. Visual line crossings do not imply connected track.

### Feed binding

For a berth:

```json
{
  "id": "bind-berth-1",
  "elementId": "berth-1",
  "type": "tdBerth",
  "tdArea": "${CONFIRMED_PRESTON_AREA_ID}",
  "berth": "1008"
}
```

For a combined berth (Milestone 50) — up to 4 of these sharing one `elementId`, each with its own
`combinedOrder` (the join order, 1-4):

```json
[
  {
    "id": "bind-a",
    "elementId": "berth-1",
    "type": "tdBerth",
    "tdArea": "PX",
    "berth": "A001",
    "combinedOrder": 1
  },
  {
    "id": "bind-b",
    "elementId": "berth-1",
    "type": "tdBerth",
    "tdArea": "PX",
    "berth": "B001",
    "combinedOrder": 2
  }
]
```

For a signal (Milestone 36c — bound in the editor's Properties panel, by picking a defined label
for the area or entering the hex address and bit; `address` must be 1-2 hex digits and `bit`
0-7; a signal may have at most one, and only signals may have one):

```json
{
  "id": "bind-signal-1",
  "elementId": "signal-1",
  "type": "tdSBit",
  "tdArea": "XX",
  "address": "1A",
  "bit": 4,
  "activeMeans": "off"
}
```

### Presentation rules

Use semantic style tokens, not arbitrary per-element CSS. Signal style tokens are `signal-blank`, `signal-on`, `signal-off`.

### Style profile (ADR 0004 D4)

Geometry and colour constants live in one module, `packages/map-schema/src/style.ts`
(`MAP_STYLE`, `MAP_CSS_TOKENS`), imported by the compiler, the public SVG renderer and the
editor canvas — no literal duplicated across the three.

| Constant                     | Value        | Note                                                       |
| ---------------------------- | ------------ | ---------------------------------------------------------- |
| Row pitch                    | 30           | matches OpenTrainTimes; provisional, owner may revisit     |
| Diagonal slope               | 1:2 (26.57°) | the only permitted non-horizontal track angle              |
| Track stroke width           | 3            | `stroke-linejoin: round`, `stroke-linecap: butt`           |
| Berth box height             | 20           | fixed; centred on the bound track's row                    |
| Signal offset from track     | 12           | standard perpendicular gap                                 |
| Endpoint weld tolerance      | 6            | editor endpoint magnet + compiler coincident-endpoint weld |
| Platform bar height / offset | 12 / 12      | fill `--map-platform-fill` (`#ffa500`)                     |

The compiler welds `trackPath` segments that are topology-joined **and** have coincident
endpoints into a single polyline, so a diagonal-to-horizontal junction is a rounded
`stroke-linejoin` inside one stroke rather than a gap between two `butt`-capped elements — no
junction dots (ADR 0004 D2). A purely visual crossing with no topology is never merged.

## 5. Signal rules

Internal future states:

- `unmapped`
- `unknown`
- `on`
- `off`

Public display:

- unmapped/unknown = blank
- on = red
- off = green

Green must be labelled `off`, never `green aspect`. There is no calculation from multiple aspects or route logic. A future compound boolean binding may be added only after observed data requires it.

**Editor live state (Milestone 36c, owner request):** a signal with an S-Class binding shows its
live state on the editor canvas in every view (not only Test mode), polled from
`GET /api/v1/editor/state/{slug}` for the saved draft — same colours and the same
`computeLiveState` as the public map (rule 13), with a dashed ring marking it as live. Unbound
signals keep their static `symbolStyle` preview. Validation warns (`signal_bit_never_changed`)
when a bound bit hasn't been seen changing in the last 7 days.

## 6. Editor layout

Desktop-first responsive interface:

- Top toolbar: file/edit/view/test/validate/publish.
- Left symbol/tool palette.
- Central pan/zoom canvas.
- Right properties/binding/validation panel.
- Bottom status bar with cursor, zoom, selected count and validation summary.

Modes:

1. Layout — draw/move/resize.
2. Binding — edit TD/reference bindings without moving objects.
3. Test — simulated/live/historical state.
4. Review — compare and publish.

## 7. Required editing functions

- Pan and wheel/pinch zoom.
- Configurable grid and snap-to-grid.
- Magnetic track endpoints — an endpoint dropped within the weld tolerance of another track's
  endpoint snaps onto it and the pair is given a shared `topologyEdgeId` so the publish-time
  weld merges them (ADR 0005 E1).
- Track endpoint drags snap **unconditionally** to the nearest of `{0°, ±1:2, ±1:1, 90°}`
  (distance along the ray quantised to the grid); hold Alt for a free angle (ADR 0005 E1).
- Multi-vertex editing for tracks and platforms: double-click an edge to insert a corner,
  double-click a corner handle to remove it (track ≥ 2 points, platform polygon ≥ 3) (ADR 0005
  E2). Platform corners snap to **half the grid step**; everything else to the full grid.
- Click and marquee selection (shift-click to add/remove one at a time; drag a marquee in the
  dedicated multiselect tool to select everything a rectangle intersects, mixed element types
  included).
- Multi-select and move: dragging any one element of an active multi-selection moves the whole
  group together — mixed types included (e.g. berths, signals and track paths at once) — as one
  undoable step (`moveElements`, `apps/web/src/editor/commands.ts`). Fixed 2026-09-11: dragging a
  `trackPath`/`platform` used to move only that element even when part of a larger selection,
  unlike every position-based element type, which already respected it.
- Numeric geometry editing.
- Align/distribute.
- Copy, cut, paste, duplicate and repeat offset.
- Undo/redo using a command model.
- Layer visibility/lock/order.
- Group and ungroup.
- Reusable templates.
- Keyboard shortcuts with visible help.
- Autosave draft without publishing.
- Import/export canonical JSON.
- Optional locked reference-image layer, excluded from published output by default.

Copying a bound element must create a validation warning until the duplicated binding is confirmed or changed.

## 8. Commands and audit

Represent edits as commands such as:

- `AddElement`
- `DeleteElements`
- `MoveElements`
- `ResizeElement`
- `SetProperty`
- `SetBinding`
- `ConnectTopology`
- `DisconnectTopology`
- `ReorderLayer`

Each committed command/batch records affected IDs, before/after data, author and time. Autosave stores draft revisions; it never publishes.

## 9. Validation

### Publication-blocking errors

- Invalid schema.
- Duplicate element IDs.
- Missing referenced layer/element/node.
- Invalid or empty required berth binding.
- Duplicate berth binding unless explicitly allowed and justified.
- Topology edge with missing node.
- Adjacent-map link to unknown map where required.
- Unsupported binding type.
- Published effective range overlap.

### Warnings

- Track endpoints nearly touch but are not connected.
- Element outside canvas.
- Overlapping berth text.
- Berth not attached to nearby track.
- Binding not seen in the nationwide retained data in the last 90 days (bounded so the check
  stays fast on the live recorder — an all-history scan of `td_berth_event` was timing publish
  out).
- Duplicated binding.
- Signal has no S-Class binding; expected for Lancaster and suppressible per map.
- Experimental future S-Class mapping.

### Informational diagnostics

- element counts by type
- bound/unbound berth count
- observed berth percentage
- last observed time per binding
- current value preview

## 10. Test mode

Support:

- manually set/clear a berth description
- simulate CA, CB and CC
- load current live state
- load historical state at a selected local date/time
- play a recorded fixture
- set future signal state blank/on/off in editor preview only

The preview must use the same reducers/style semantics as the public application.

## 11. Version and publication lifecycle

`Draft -> Validated -> Published -> Superseded -> Archived`

A published version is immutable and has an effective interval. Publishing compiles:

- element lookup by ID
- berth lookup by `(td_area, berth)`
- optional S-bit lookup
- bounding boxes
- topology adjacency
- map continuation links
- stripped editor-only metadata

Playback selects the map version effective at the requested timestamp.

## 12. Renderer choices

- Editor canvas: Konva/react-konva for selection, transforms and hit testing.
- Public renderer: SVG for sharp scalable schematic display and direct element interaction.
- Maintain visual regression fixtures for each symbol in both renderers.
