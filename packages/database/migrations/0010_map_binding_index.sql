-- Milestone 6 (docs/IMPLEMENTATION_PLAN.md): live WebSocket delta fan-out needs a queryable
-- binding index instead of re-parsing each map_version's compiled_runtime_bundle JSON per
-- event. Per docs/DATA_MODEL.md §9 ("Generated at publication: map version, element ID,
-- binding type, TD area, berth/address/bit as relevant").
--
-- Populated by apps/worker's publish-map command going forward, and backfilled once for any
-- map_version published before this migration existed via the backfill-map-bindings command.
-- Never mutated after insertion for a given map_version — map versions are immutable
-- (CLAUDE.md non-negotiable #11), so their bindings are too.

create table map_binding_index (
  id bigserial primary key,
  map_version_id bigint not null references map_version (id),
  element_id text not null,
  binding_type text not null check (binding_type in ('td_berth', 'td_s_bit')),
  td_area text not null,
  berth text,
  address text,
  bit text,
  created_at timestamptz not null default now(),
  constraint map_binding_index_berth_fields_check check (
    (binding_type = 'td_berth' and berth is not null and address is null and bit is null)
    or
    (binding_type = 'td_s_bit' and address is not null and bit is not null and berth is null)
  )
);

-- The real invariant is per-binding-type, not "every column together": one element bound to
-- one TD berth source, or one element bound to one S-bit source, per published map version.
create unique index map_binding_index_berth_unique
  on map_binding_index (map_version_id, td_area, berth)
  where binding_type = 'td_berth';

create unique index map_binding_index_s_bit_unique
  on map_binding_index (map_version_id, td_area, address, bit)
  where binding_type = 'td_s_bit';

-- Hot-path lookups for the live-delta join: "which elements (across every currently published
-- map) does this TD event's (area, berth) or (area, address, bit) bind to?"
create index map_binding_index_berth_lookup_idx
  on map_binding_index (td_area, berth)
  where binding_type = 'td_berth';

create index map_binding_index_s_bit_lookup_idx
  on map_binding_index (td_area, address, bit)
  where binding_type = 'td_s_bit';

create index map_binding_index_map_version_idx on map_binding_index (map_version_id);
