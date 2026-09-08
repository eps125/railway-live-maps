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

A named station: `crs` (optional 3-letter code), `name`, optional `tiploc`, position and font
size. Renders `name` (plus `[CRS]`) in the standard station-label style. The `crs` is the hook
the deferred station-berth schedule deduction (ADR 0004 D7) will build on. A zone bracket
around member platforms is later work.

### `label`

Plain sanitized text with position, alignment and size.

### `boundary`

Named map continuation with optional adjacent map slug and direction.

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

For a future signal:

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
- Click and marquee selection.
- Multi-select and move.
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
