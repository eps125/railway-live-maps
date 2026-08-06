-- Milestones 11/12 (docs/IMPLEMENTATION_PLAN.md): editor draft persistence, ahead of
-- publication. Per docs/DATA_MODEL.md §9's `map_draft`/`map_draft_revision` field lists.
--
-- One draft per map slug for this MVP (no multi-user collaborative editing, matching
-- docs/PROJECT_SPEC.md §10's explicit MVP exclusion) — `slug` is unique. A draft can exist
-- before the map has ever been published (`map_id` is nullable, set once the first publish
-- links it); this doesn't block future "create a brand-new map" support even though the
-- Milestone 11 editor UI itself only targets the single already-configured map slug.

create table map_draft (
  id bigserial primary key,
  slug text not null unique,
  map_id bigint references map (id),
  canonical_document jsonb not null,
  revision integer not null default 1,
  base_map_version_id bigint references map_version (id),
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Immutable per-revision snapshots (docs/PROJECT_SPEC.md §9: "Draft revision history: at
-- least 90 days" — automatic pruning after that window is an M13 operational-hardening
-- concern, not implemented here). `command_summary` carries the editor's own command-model
-- audit fields (docs/MAP_EDITOR_SPEC.md §8: "records affected IDs, before/after data, author
-- and time") for whichever commands produced this revision.
create table map_draft_revision (
  id bigserial primary key,
  map_draft_id bigint not null references map_draft (id),
  revision integer not null,
  canonical_document jsonb not null,
  command_summary jsonb,
  author text,
  comment text,
  created_at timestamptz not null default now(),
  unique (map_draft_id, revision)
);

create index map_draft_revision_draft_id_idx on map_draft_revision (map_draft_id, revision desc);
