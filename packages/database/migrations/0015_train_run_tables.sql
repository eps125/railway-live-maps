-- Milestone 8 (docs/DATA_MODEL.md §7): nationwide train-run lifecycle and the exact
-- activation-to-schedule link. Renumbered to 0015 because migrations 0011 (map_draft, M11/12)
-- and 0012-0014 (source_file_import/schedule/reference, M7) were inserted ahead of it during
-- this project's reprioritized execution order.

-- `id` is a **uuid**, not the bigint-ID convention used elsewhere, because it is exposed
-- directly in a public URL (`GET /api/v1/runs/{runId}`) and docs/DATA_MODEL.md §7 explicitly
-- calls for an "internal UUID." `gen_random_uuid()` is a PostgreSQL 13+ built-in — no
-- extension required.
create table train_run (
  id uuid primary key default gen_random_uuid(),
  trust_train_id text not null,
  -- The four-character signalling description/headcode TRUST activation reports — a resolver
  -- candidate key only (CLAUDE.md rule 5: never assume this uniquely identifies a run).
  signalling_id text,
  service_date date not null,
  schedule_id bigint references schedule (id),
  activated_at timestamptz,
  origin_departure_at timestamptz,
  call_type text,
  call_mode text,
  operator_code text,
  service_code text,
  lifecycle_state text not null default 'activated'
    check (lifecycle_state in ('activated', 'unidentified', 'cancelled', 'completed', 'superseded')),
  -- Set when a Change of Identity supersedes this run with a newly-activated one — history is
  -- preserved via this pointer rather than rewritten in place.
  superseded_by_train_run_id uuid references train_run (id),
  last_event_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (trust_train_id, service_date)
);

create index train_run_signalling_id_idx on train_run (signalling_id, service_date);
create index train_run_schedule_id_idx on train_run (schedule_id);

-- Every normalized nationwide TRUST message with raw lineage (docs/DATA_MODEL.md §7: "Do not
-- filter to map corridors"). Partitioned by `raw_event_normalized_at_utc` — the denormalized
-- copy of `raw_feed_event.normalized_event_at_utc` also required by the composite FK below —
-- same parent+default-partition-only pattern as `raw_feed_event`/`td_berth_event`; concrete
-- month partitions are created at runtime by packages/database/src/partitions.ts and this
-- table is added to apps/worker/src/commands/ensurePartitions.ts's PARTITIONED_TABLES.
create sequence train_run_event_id_seq as bigint;

create table train_run_event (
  id bigint not null default nextval('train_run_event_id_seq'),
  train_run_id uuid not null references train_run (id),
  raw_event_id bigint not null,
  raw_event_normalized_at_utc timestamptz not null,
  trust_message_type text not null check (trust_message_type in (
    'activation', 'cancellation', 'movement', 'unidentified', 'reinstatement',
    'change_of_origin', 'change_of_identity', 'change_of_location', 'unsupported'
  )),
  event_at timestamptz not null,
  ingestion_sequence bigint not null,
  normalization_version integer not null,
  raw_event_json jsonb not null,
  constraint train_run_event_raw_event_fk
    foreign key (raw_event_id, raw_event_normalized_at_utc)
    references raw_feed_event (id, normalized_event_at_utc),
  -- Idempotency guard: a redelivered/replayed raw TRUST event must never be applied twice.
  constraint train_run_event_raw_event_uk unique (raw_event_id, raw_event_normalized_at_utc),
  primary key (id, raw_event_normalized_at_utc)
) partition by range (raw_event_normalized_at_utc);

alter sequence train_run_event_id_seq owned by train_run_event.id;
create table train_run_event_default partition of train_run_event default;
create index train_run_event_train_run_idx on train_run_event (train_run_id, event_at desc);

-- One row per run, created at Activation. `activation_*`/`activation_at` are the immutable
-- audit trail of what TRUST actually reported at activation time; `schedule_id`/
-- `match_outcome`/`resolved_at` are the mutable resolution outcome, updated in place (not
-- re-inserted) if a later pass resolves a previously-missing schedule — docs/DATA_MODEL.md §7:
-- "Retain exact activation fields and outcome if the referenced schedule is temporarily
-- missing and linked later." `match_outcome` reuses the exact vocabulary Milestone 9's berth
-- resolver will also use (CLAUDE.md rule 7: matched/ambiguous/unmatched, never hidden).
create table run_schedule_link (
  id bigserial primary key,
  train_run_id uuid not null unique references train_run (id),
  -- Retained specifically so a later deferred-resolution pass can re-query `schedule` for the
  -- same train_uid without needing to re-parse the original activation event.
  activation_train_uid text,
  activation_signalling_id text,
  activation_operator_code text,
  activation_service_code text,
  activation_at timestamptz not null,
  schedule_id bigint references schedule (id),
  match_outcome text not null check (match_outcome in ('matched', 'ambiguous', 'unmatched')),
  resolved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index run_schedule_link_schedule_id_idx on run_schedule_link (schedule_id);
