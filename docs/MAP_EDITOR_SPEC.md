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

### `signal`

- position and orientation
- signal label
- symbol style
- optional associated track
- optional future S-Class binding

For Lancaster, no S-Class binding is required and operational state is blank.

### `platform`

Schematic platform shape/line, number/name and optional TIPLOC/platform metadata.

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
- Magnetic track endpoints.
- Horizontal, vertical and optional 45-degree track drawing.
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
- Binding never observed in the nationwide retained data.
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
