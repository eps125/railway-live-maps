-- ADR 0002 (2026-09-01), owner-approved scope expansion. Companion to migration 0024.
--
-- Drops RLM's bespoke Milestone 8 run model (`train_run`, `train_run_event`,
-- `run_schedule_link`) and the Milestone 9 berth-run resolver's store (`berth_run_resolution`),
-- plus the now-orphaned `schedule` table. All prior RLM TRUST-derived run data and the resolver
-- output are discarded per explicit owner approval — run<->schedule correlation is deferred to a
-- later phase rebuilt on garner's data. In its place: a near-verbatim mirror of garner's
-- (openrail-eps) `trust_*` tables, populated by apps/worker/src/garner/bridge.ts.
--
-- IMPORTANT: stop the `projector-schedule` service and any `ingest-trust` / `ingest-vstp` /
-- `project-trust` / `project-vstp` workers before applying — they write into the tables dropped
-- here. Those roles are removed from the worker in the same change.

drop table if exists berth_run_resolution cascade;
drop table if exists run_schedule_link cascade;
-- Partitioned parent; CASCADE drops every month partition, the default partition, the composite
-- FK into raw_feed_event, and the owned `train_run_event_id_seq`.
drop table if exists train_run_event cascade;
drop table if exists train_run cascade;
drop table if exists schedule cascade;

-- garner `trust_activation`. `(trust_id, created)` is unique in practice (one activation per
-- TRUST train id at a given second). `cif_schedule_id` is garner's link to `cif_schedules.id`;
-- garner writes 0 when it could not deduce a schedule, the bridge writes NULL. Deliberately
-- NOT a foreign key — a `cif_schedules` row can lag its activation in mirror order, and ADR
-- 0002's honesty requirement (a missing schedule must be visible, not an error) is better served
-- by a nullable plain column than a constraint that would reject the activation.
create table trust_activation (
  trust_id text not null,
  created timestamptz not null,
  cif_schedule_id bigint,
  deduced smallint not null default 0,
  synced_at timestamptz not null default now(),
  primary key (trust_id, created)
);
create index trust_activation_cif_schedule_id_idx on trust_activation (cif_schedule_id);
create index trust_activation_created_idx on trust_activation (created);

-- garner `trust_activation_extra` — the full activation payload (train_uid, TOC, origin
-- timestamps, WTT id, ...). Epoch INT columns converted to timestamptz/date by the bridge.
create table trust_activation_extra (
  trust_id text not null,
  created timestamptz not null,
  schedule_source text,
  train_file_address text,
  schedule_end_date date,
  tp_origin_timestamp timestamptz,
  creation_timestamp timestamptz,
  tp_origin_stanox text,
  origin_dep_timestamp timestamptz,
  train_service_code text,
  toc_id text,
  d1266_record_number text,
  train_call_type text,
  train_uid text,
  train_call_mode text,
  schedule_type text,
  sched_origin_stanox text,
  schedule_wtt_id text,
  schedule_start_date date,
  synced_at timestamptz not null default now(),
  primary key (trust_id, created)
);
create index trust_activation_extra_train_uid_idx on trust_activation_extra (train_uid);

-- garner `trust_movement`. garner has no natural key (a train reports many movements), so RLM
-- adds a surrogate `id`; the `(trust_id, created, loc_stanox, actual_timestamp)` unique key is
-- the bridge's idempotency guard for re-syncs across the `created` watermark boundary.
-- `timetable_variation` is stored as garner has it: an unsigned magnitude in minutes; direction
-- (early/late/on-time/off-route) and event type (arrival/departure/terminated) are encoded in
-- `flags` — see packages/domain/src/trust/garnerMovement.ts for the bit layout.
create table trust_movement (
  id bigserial primary key,
  trust_id text not null,
  created timestamptz not null,
  platform text,
  loc_stanox text,
  actual_timestamp timestamptz,
  gbtt_timestamp timestamptz,
  planned_timestamp timestamptz,
  timetable_variation integer,
  next_report_stanox text,
  next_report_run_time integer,
  flags integer,
  synced_at timestamptz not null default now(),
  unique (trust_id, created, loc_stanox, actual_timestamp)
);
create index trust_movement_trust_id_idx on trust_movement (trust_id, actual_timestamp desc);
create index trust_movement_created_idx on trust_movement (created);

create table trust_cancellation (
  trust_id text not null,
  created timestamptz not null,
  reason text,
  type text,
  loc_stanox text,
  reinstate smallint not null default 0,
  synced_at timestamptz not null default now(),
  primary key (trust_id, created)
);
create index trust_cancellation_created_idx on trust_cancellation (created);

create table trust_changeorigin (
  trust_id text not null,
  created timestamptz not null,
  reason text,
  loc_stanox text,
  synced_at timestamptz not null default now(),
  primary key (trust_id, created)
);
create index trust_changeorigin_created_idx on trust_changeorigin (created);

create table trust_changeid (
  trust_id text not null,
  created timestamptz not null,
  new_trust_id text not null,
  synced_at timestamptz not null default now(),
  primary key (trust_id, created)
);
create index trust_changeid_created_idx on trust_changeid (created);
create index trust_changeid_new_trust_id_idx on trust_changeid (new_trust_id);

create table trust_changelocation (
  trust_id text not null,
  created timestamptz not null,
  original_stanox text,
  stanox text,
  synced_at timestamptz not null default now(),
  primary key (trust_id, created)
);
create index trust_changelocation_created_idx on trust_changelocation (created);
