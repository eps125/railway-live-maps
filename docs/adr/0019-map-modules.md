# ADR 0019 — Map modules: draw once, use on many maps

- **Status:** accepted (owner, 2026-10-01)
- **Date:** 2026-10-01
- **Implemented by:** Milestone 85
- **Relates to:** CLAUDE.md rules 11 (immutable published versions) and 12 (canonical JSON)

## Context

The owner wants the same railway on more than one map (the Grand Junction Railway on its own map
and inside a Wolverhampton map) without drawing it twice, and to stop large maps (Carlisle) being
edited by selecting everything to one side of a change and dragging it across. Asked
(2026-10-01) for:

- maps assembled from **modules**, which never appear in the public map list;
- joins between modules drawn with a tool, and no manual x/y offsets;
- a module change to appear on every published map that uses it without republishing each one
  by hand — playback changing as a result is acceptable;
- elements that span modules allowed; a module may not be used twice in one map; no nesting.

## Decision

### 1. Modules are maps of kind `module`

`map.kind` is `map` or `module`. A module has a draft and is edited in the same editor, with a
**Join** tool and a Joins panel. Publishing it records an immutable `map_module_version` — never a
`map_version`, so nothing that reads published maps (the public list, binding and place indexes,
state snapshots, run resolution) ever sees a module on its own.

### 2. Joins

A join is a named two-point line in the module's document (`joins`), drawn across the track ends
at an edge. The track ends it catches are those within 3 units of the line, ordered along it.
Joins are authoring aids: never compiled, never published, never rendered publicly.

### 3. Assembled maps

An ordinary map's document may list `modules: [{ slug, placement }]`. A placement is either
`at` (x, y — the first module, or one dragged into place on the canvas) or `attached`: this
module's join meets a join of a module already placed. Attached positions are **calculated**:
the joins must run the same way (either way round); their track ends are lined up first to first,
and every track end must meet one on the other side (within 1 unit) — otherwise the map can't
publish and the editor says why. A module that grows moves its join, and everything attached
beyond it moves along.

`flattenAssembledMap` produces one ordinary map document: the map's own elements first, then
each module's elements, bindings and topology, moved into place, with ids qualified as
`<module>/<id>`. A reference already containing `/` is a deliberate reference into another
module (how elements spanning modules work) and is left alone. Topology nodes from different
modules at the same point become one node. Joins and the module list are not part of the result.

### 4. Publishing and the cascade (rule 11 kept)

An assembled map publishes its **flattened** document as an ordinary immutable `map_version`,
built from each module's latest published version, and keeps its source (`source_document`) and
the module versions used (`module_versions`) alongside. Publishing a module then **republishes
every map currently assembled from it**, automatically, each from its last published source —
the maps' own unpublished draft edits stay unpublished. Each republish is a new immutable
version (effective from all time, as every publish already is), so rule 11 is unchanged; only the
manual step is gone. A map whose assembly no longer works after the module change (e.g. a join
removed) is left as it was and reported to the author. An admin **Republish all maps** action
rebuilds every published map the same way (for after a compiler change).

### 5. Editing

- An assembled map's editor shows its modules dimmed behind its own elements (from the modules'
  drafts), each named; a freely placed module can be dragged (snapped to the grid). The Modules
  panel adds, attaches (choose this module's join, the other module and its join), frees and
  removes modules, and lists problems.
- **Edit module here** opens the module with the rest of the map drawn around it, moved so the
  module sits at its own coordinates — so the area being edited is just the module.
- **Make module…** (admins) moves the selected elements, their bindings and topology into a new
  module placed at 0,0, so nothing moves on screen. A selected element that refers to something
  outside the selection stays in the map; anything left in the map that referred to a moved
  element now refers to it by its qualified id.
- A module still used by a map (published or draft) can't be deleted.

## Consequences

- Element ids on a published assembled map change (`<module>/<id>`) when a map is first split into
  modules. Nothing outside a map version relies on them across versions.
- Test mode for an assembled map previews with its modules' drafts; the canvas shows live state
  only for the map's own elements, not the dimmed modules.
- New elements spanning modules are authored by typing the qualified id where a reference is
  entered; drawing one by clicking across modules is later work.
