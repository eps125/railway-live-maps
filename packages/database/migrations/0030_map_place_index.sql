-- Milestone 31 (docs/IMPLEMENTATION_PLAN.md): place identifiers on labels + nationwide
-- CRS/TIPLOC/STANOX search. Parallel to map_binding_index (migration 0010), but for the
-- "which map (if any) covers this named place" question rather than live TD delta routing:
-- every station/label element carrying at least one of crs/tiploc/stanox becomes a row here at
-- publish time, and GET /api/v1/places/search left-joins location_reference against this to
-- decide whether a search hit has a map to jump to.
--
-- Never mutated after insertion for a given map_version — map versions are immutable (CLAUDE.md
-- non-negotiable #11), so their place tags are too. Unlike map_binding_index there is no unique
-- constraint here: this only powers discovery/search, not a routing-correctness-critical path,
-- so nothing needs a DB-enforced "at most one" invariant.

create table map_place_index (
  id bigserial primary key,
  map_version_id bigint not null references map_version (id),
  element_id text not null,
  element_type text not null check (element_type in ('station', 'label')),
  tiploc text,
  stanox text,
  crs text,
  created_at timestamptz not null default now(),
  constraint map_place_index_has_identifier check (
    tiploc is not null or stanox is not null or crs is not null
  )
);

-- Partial indexes: a search only ever joins on whichever identifier is present, and most rows
-- will only have one or two of the three set.
create index map_place_index_tiploc_idx on map_place_index (tiploc) where tiploc is not null;
create index map_place_index_stanox_idx on map_place_index (stanox) where stanox is not null;
create index map_place_index_crs_idx on map_place_index (crs) where crs is not null;
create index map_place_index_map_version_idx on map_place_index (map_version_id);
