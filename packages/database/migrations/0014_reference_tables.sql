-- Milestone 7 (docs/DATA_MODEL.md §6): CORPUS (TIPLOC/STANOX/CRS/NLC/UIC location reference)
-- and SMART (berth-step) reference data, plus a catch-all for record types outside either
-- importer's modeled scope (CLAUDE.md rule 18: "never silently discard" — file-based ingestion
-- has no per-message ack to hang lineage off the way STOMP frames do, so this table is that
-- lineage for files instead).

create table location_reference (
  id bigserial primary key,
  tiploc text not null unique,
  stanox text,
  crs text,
  nlc text,
  uic text,
  name text,
  latitude numeric,
  longitude numeric,
  source text not null default 'CORPUS',
  source_file_import_id bigint references source_file_import (id),
  -- Authoritative safety net: only the fields above are individually modeled, everything else
  -- CORPUS supplies is retained raw rather than silently dropped.
  raw_source_json jsonb not null,
  imported_at timestamptz not null default now()
);

-- "Evidence, not proof that every relationship is complete" (docs/DATA_MODEL.md §6) — every
-- permitted SMART field is retained in raw_source_json; only what Milestone 9's resolver needs
-- to query by is individually modeled.
create table smart_berth_step (
  id bigserial primary key,
  td_area text not null,
  from_berth text,
  to_berth text,
  stanox text,
  platform text,
  event_type text,
  route_indicator text,
  source_file_import_id bigint references source_file_import (id),
  raw_source_json jsonb not null,
  imported_at timestamptz not null default now()
);

create index smart_berth_step_area_berths_idx on smart_berth_step (td_area, from_berth, to_berth);

-- Natural-key dedup for reimport idempotency (apps/worker/src/reference/smartImporter.ts
-- upserts on conflict here) — coalesced since from_berth/to_berth/event_type are legitimately
-- absent for some SMART record shapes (e.g. a BERTH_CANCEL with no to_berth).
create unique index smart_berth_step_natural_key_idx on smart_berth_step (
  td_area, coalesce(from_berth, ''), coalesce(to_berth, ''), coalesce(event_type, '')
);

create table import_unhandled_record (
  id bigserial primary key,
  source_file_import_id bigint not null references source_file_import (id),
  record_type text not null,
  seq_no_in_file bigint,
  raw_json jsonb not null,
  created_at timestamptz not null default now()
);

create index import_unhandled_record_import_idx on import_unhandled_record (source_file_import_id);
