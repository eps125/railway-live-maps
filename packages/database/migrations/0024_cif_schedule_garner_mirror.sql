-- ADR 0002 (2026-09-01), owner-approved scope expansion. RLM stops deriving CIF/VSTP schedule
-- data from its own Network Rail SCHEDULE/VSTP subscription and instead mirrors the operator's
-- openrail-eps ("garner") `cif_schedules` / `cif_schedule_locations` near-verbatim. garner is
-- itself NR-subscribed and retains/archives raw frames, so it is the retention layer for this
-- feed (ADR 0002 exception to CLAUDE.md non-negotiable 1).
--
-- All prior RLM SCHEDULE/VSTP data is discarded per explicit owner approval. The bespoke
-- `schedule` table itself is dropped in migration 0025 (train_run.schedule_id /
-- run_schedule_link.schedule_id FKs still reference it until that migration removes those
-- tables); here we drop only its child/staging tables and create the garner-shaped mirror.
--
-- Column names mirror garner's (openrail-eps `database.c`), lowercased for PostgreSQL. Epoch
-- INT columns are converted to real `timestamptz` / `date` by the bridge
-- (apps/worker/src/garner/bridge.ts), and garner's per-day `runs_*` BOOLEAN columns are kept
-- as-is with a generated CIF-style 7-char `days_runs_bitmask` alongside for convenience.

drop table if exists schedule_location cascade;
drop table if exists schedule_import_staging;
drop table if exists schedule_location_import_staging;

-- garner `cif_schedules`. `id` is garner's own INT UNSIGNED AUTO_INCREMENT primary key — the
-- stable key `trust_activation.cif_schedule_id` points at — mirrored verbatim, not re-generated.
create table cif_schedules (
  id bigint primary key,
  update_id integer,
  created timestamptz not null,
  -- garner (openrail cifdb) marks a *live* row with `deleted = 0xffffffff` (the NOT_DELETED
  -- sentinel) and a withdrawn row with the real withdrawal epoch. The bridge writes NULL for the
  -- sentinel (and 0), and the real timestamp otherwise; every "candidate for matching" query
  -- filters `deleted is null`.
  deleted timestamptz,
  cif_bank_holiday_running text,
  cif_stp_indicator text not null,
  cif_train_uid text not null,
  applicable_timetable text,
  atoc_code text,
  uic_code text,
  runs_mo boolean not null,
  runs_tu boolean not null,
  runs_we boolean not null,
  runs_th boolean not null,
  runs_fr boolean not null,
  runs_sa boolean not null,
  runs_su boolean not null,
  -- CIF-style Mon..Sun runs-on-day string, derived from the booleans above (never fabricated —
  -- it is exactly those seven columns rendered as '1'/'0').
  days_runs_bitmask text generated always as (
    (case when runs_mo then '1' else '0' end) ||
    (case when runs_tu then '1' else '0' end) ||
    (case when runs_we then '1' else '0' end) ||
    (case when runs_th then '1' else '0' end) ||
    (case when runs_fr then '1' else '0' end) ||
    (case when runs_sa then '1' else '0' end) ||
    (case when runs_su then '1' else '0' end)
  ) stored,
  schedule_start_date date not null,
  schedule_end_date date not null,
  signalling_id text,
  cif_train_category text,
  cif_headcode text,
  cif_train_service_code text,
  cif_business_sector text,
  cif_power_type text,
  cif_timing_load text,
  cif_speed text,
  cif_operating_characteristics text,
  cif_train_class text,
  cif_sleepers text,
  cif_reservations text,
  cif_connection_indicator text,
  cif_catering_code text,
  cif_service_branding text,
  train_status text,
  deduced_headcode text not null default '',
  deduced_headcode_status text not null default '',
  synced_at timestamptz not null default now()
);

create index cif_schedules_train_uid_idx
  on cif_schedules (cif_train_uid, schedule_start_date, schedule_end_date);
create index cif_schedules_signalling_id_idx on cif_schedules (signalling_id, schedule_start_date);
create index cif_schedules_deleted_idx on cif_schedules (deleted);

-- garner `cif_schedule_locations`. garner has no explicit ordering column — the bridge assigns
-- `seq_no` by ordering each schedule's rows on `sort_time` (garner's own within-day ordering
-- key), so `(cif_schedule_id, seq_no)` is a stable calling-order key on the RLM side.
-- `location_type` is garner's own (misnamed) column: it actually holds the activity string.
-- `record_identity` is the CIF LO/LI/LT record type.
create table cif_schedule_locations (
  cif_schedule_id bigint not null references cif_schedules (id) on delete cascade,
  seq_no integer not null,
  update_id integer,
  location_type text,
  record_identity text not null,
  tiploc_code text not null,
  tiploc_instance text,
  -- Raw CIF HHMM / HHMMH working+public time strings exactly as garner supplies them — never
  -- derive a normalized timestamp from a missing raw one (CLAUDE.md: no silent source repair).
  arrival text,
  departure text,
  pass text,
  public_arrival text,
  public_departure text,
  sort_time integer,
  next_day boolean not null default false,
  platform text,
  line text,
  path text,
  engineering_allowance text,
  pathing_allowance text,
  performance_allowance text,
  primary key (cif_schedule_id, seq_no)
);

create index cif_schedule_locations_tiploc_idx on cif_schedule_locations (tiploc_code);
