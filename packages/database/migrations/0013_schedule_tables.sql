-- Milestone 7 (docs/IMPLEMENTATION_PLAN.md, docs/DATA_MODEL.md §6): nationwide schedule
-- reference data, imported from the complete SCHEDULE full extract and updated incrementally
-- by VSTP. "Import the complete available dataset, not only schedules that traverse published
-- maps" (docs/DATA_MODEL.md §6) — deliberately unpartitioned per docs/DATA_MODEL.md §11 (lower
-- volume than the event-stream tables, natural-key based instead).

create table schedule (
  id bigserial primary key,
  source_file_import_id bigint references source_file_import (id),
  train_uid text not null,
  schedule_start_date date not null,
  schedule_end_date date not null,
  -- STP precedence source: Cancellation > Overlay > New > Permanent (packages/domain/src/schedule/resolveStpPrecedence.ts).
  stp_indicator text not null check (stp_indicator in ('C', 'N', 'O', 'P')),
  -- 7-char Mon..Sun runs-on-day bitmask, raw as supplied — never fabricated.
  days_runs_bitmask text,
  signalling_id text,
  operator_code text,
  train_service_code text,
  train_category text,
  train_status text,
  power_type text,
  origin_tiploc text,
  destination_tiploc text,
  source text not null check (source in ('SCHEDULE', 'VSTP')),
  raw_source_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (train_uid, schedule_start_date, schedule_end_date, stp_indicator, source)
);

create index schedule_train_uid_idx on schedule (train_uid, schedule_start_date, schedule_end_date);

create table schedule_location (
  id bigserial primary key,
  schedule_id bigint not null references schedule (id) on delete cascade,
  seq_no integer not null,
  location_type text not null check (location_type in ('origin', 'intermediate', 'pass', 'destination')),
  tiploc text not null,
  stanox text,
  -- Raw HHMM(H) time strings, exactly as supplied — never derive a normalized timestamp from a
  -- missing raw one (CLAUDE.md: "do not silently repair source data").
  arrival_public text,
  arrival_working text,
  departure_public text,
  departure_working text,
  pass_public text,
  pass_working text,
  platform text,
  path text,
  line text,
  activity_codes text[] not null default '{}',
  raw_activity_text text,
  day_offset smallint not null default 0,
  unique (schedule_id, seq_no)
);

create index schedule_location_tiploc_idx on schedule_location (tiploc);

-- Unlogged scratch space for the full-file swap (apps/worker/src/schedule/scheduleImporter.ts):
-- stream-parsed here in chunked transactions, then one final transaction moves the whole batch
-- into the real tables and truncates these — "readers never see a half-imported file."
-- Correlated to `schedule` purely by the same natural key `schedule` itself is unique on, so
-- no synthetic per-file sequence number is needed to join locations back to their schedule.
create unlogged table schedule_import_staging (
  staging_import_id bigint not null,
  train_uid text not null,
  schedule_start_date date not null,
  schedule_end_date date not null,
  stp_indicator text not null,
  days_runs_bitmask text,
  signalling_id text,
  operator_code text,
  train_service_code text,
  train_category text,
  train_status text,
  power_type text,
  origin_tiploc text,
  destination_tiploc text,
  source text not null,
  raw_source_json jsonb not null
);

create index schedule_import_staging_batch_idx on schedule_import_staging (staging_import_id);

create unlogged table schedule_location_import_staging (
  staging_import_id bigint not null,
  train_uid text not null,
  schedule_start_date date not null,
  schedule_end_date date not null,
  stp_indicator text not null,
  source text not null,
  seq_no integer not null,
  location_type text not null,
  tiploc text not null,
  stanox text,
  arrival_public text,
  arrival_working text,
  departure_public text,
  departure_working text,
  pass_public text,
  pass_working text,
  platform text,
  path text,
  line text,
  activity_codes text[] not null default '{}',
  raw_activity_text text,
  day_offset smallint not null default 0
);

create index schedule_location_import_staging_batch_idx on schedule_location_import_staging (staging_import_id);
