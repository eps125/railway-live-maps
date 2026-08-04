-- Milestone 5 (docs/IMPLEMENTATION_PLAN.md): canonical map schema + published map tables.
-- Scoped to exactly what Milestone 5 needs (docs/DATA_MODEL.md §9): `map` and `map_version` only.
-- Drafts/revisions/binding-index/state-snapshots are Milestone 6/11/12 concerns, not created here.

create table map (
  id bigserial primary key,
  slug text not null unique,
  name text not null,
  description text,
  owner_metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- Exclusion constraints mixing an equality column (map_id) with a range overlap check need
-- btree_gist. This is what enforces "Published effective range overlap" as a blocking error
-- (docs/MAP_EDITOR_SPEC.md §9) at the database level, not just in application code.
create extension if not exists btree_gist;

create table map_version (
  id bigserial primary key,
  map_id bigint not null references map (id),
  version_number integer not null,
  canonical_document jsonb not null,
  compiled_runtime_bundle jsonb not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  published_by text,
  published_at timestamptz not null default now(),
  schema_version integer not null,
  checksum text not null,
  unique (map_id, version_number),
  constraint map_version_no_overlap exclude using gist (
    map_id with =,
    tstzrange(effective_from, coalesce(effective_to, 'infinity'::timestamptz)) with &&
  )
);

create index map_version_map_id_effective_idx on map_version (map_id, effective_from);
