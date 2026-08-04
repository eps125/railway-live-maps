-- Scaffolding only (docs/DATA_MODEL.md §10) — no projector calls this yet (Milestone 4).
create table projection_definition (
  id bigserial primary key,
  name text not null,
  code_version integer not null,
  config_hash text not null,
  created_at timestamptz not null default now(),
  unique (name, code_version)
);

create table projection_checkpoint (
  projection_definition_id bigint primary key references projection_definition (id),
  last_ingestion_sequence bigint not null default 0,
  last_completed_at timestamptz,
  error_state jsonb,
  updated_at timestamptz not null default now()
);
