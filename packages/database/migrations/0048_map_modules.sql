-- Milestone 85 (docs/adr/0019): map modules.
--
-- A module is a `map` row of kind `module`, drawn and drafted like any map, but never shown on its
-- own: publishing it records an immutable `map_module_version` (not a `map_version`, so nothing
-- that reads published maps — the public list, binding and place indexes, snapshots, run
-- resolution — ever sees a module by itself) and then republishes every map assembled from it.
--
-- An assembled map's published `map_version.canonical_document` is the flattened, ordinary map
-- document every consumer already understands. Its `source_document` is what the author edits
-- (local elements plus the list of modules and how they attach), kept so a module publish can
-- re-flatten it; `module_versions` records which module versions went into it (lineage).

alter table map
  add column kind text not null default 'map',
  add constraint map_kind_check check (kind in ('map', 'module'));

create table map_module_version (
  id bigserial primary key,
  map_id bigint not null references map (id),
  version_number integer not null,
  canonical_document jsonb not null,
  published_by text,
  published_at timestamptz not null default now(),
  checksum text not null,
  unique (map_id, version_number)
);

alter table map_version
  add column source_document jsonb,
  add column module_versions jsonb;

-- Finding the maps assembled from a module: a containment test on the current versions' sources.
create index map_version_source_modules_idx on map_version
  using gin ((source_document -> 'modules') jsonb_path_ops)
  where source_document is not null;
