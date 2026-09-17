-- Combined berths (owner request 2026-09-17, docs/MAP_EDITOR_SPEC.md's berth section): up to 4
-- tdBerth bindings may share one element_id, for a physical split-berth group displayed as one
-- box (permissive-working platform splits). This column carries each member's join order (1-4);
-- null for every ordinary, non-combined binding. Population/validation of "every binding sharing
-- an element_id has a distinct order" happens in packages/map-schema (author time, before
-- publish) — this column just stores what was already validated.
alter table map_binding_index
  add column combined_order smallint;

alter table map_binding_index
  add constraint map_binding_index_combined_order_range
  check (combined_order is null or combined_order between 1 and 4);

-- Live-delta fan-out (apps/worker's mapDelta projectors) needs "what are this element's other
-- combined-berth members?" on every changed, bound berth — a lookup by (map_version_id,
-- element_id) that map_binding_index_map_version_idx alone doesn't serve well once a map version
-- has many elements.
create index map_binding_index_element_idx
  on map_binding_index (map_version_id, element_id);
