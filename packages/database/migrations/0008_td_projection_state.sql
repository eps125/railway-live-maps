-- Milestone 4 (docs/IMPLEMENTATION_PLAN.md): nationwide TD current-state/history projections.
-- Populated by apps/worker/src/td/projector.ts. All FKs to raw_feed_event/td_berth_event/td_s_event
-- follow the same composite-FK pattern migration 0006 uses (partitioned targets require the
-- partition column in the FK) and mirror packages/domain/src/lineage.ts's SourceLineage shape.

-- Idempotency guards for the projector's `on conflict do nothing` inserts. Safe to add now:
-- these tables are still unpopulated (migration 0006's comment: "population is Milestone 4").
alter table td_berth_event add constraint td_berth_event_raw_event_uk unique (raw_event_id, event_at);
alter table td_s_event add constraint td_s_event_raw_event_uk unique (raw_event_id, event_at);
alter table td_heartbeat add constraint td_heartbeat_raw_event_uk unique (raw_event_id);

-- Occupancy intervals per (td_area, berth_code), partitioned by entered_at month like
-- raw_feed_event/td_berth_event (docs/DATA_MODEL.md §11). Parent + default partition only here;
-- concrete month partitions come from packages/database/src/partitions.ts at runtime.
create sequence berth_occupancy_id_seq as bigint;

create table berth_occupancy (
  id bigint not null default nextval('berth_occupancy_id_seq'),
  projection_version integer not null,
  td_area text not null,
  berth_code text not null,
  description text not null,
  entered_at timestamptz not null,
  left_at timestamptz,
  entry_event_id bigint not null,
  entry_event_normalized_at_utc timestamptz not null,
  exit_event_id bigint,
  exit_event_normalized_at_utc timestamptz,
  entry_reason text not null,
  exit_reason text,
  -- Populated by the berth-run resolver (Milestone 9); every row starts unmatched.
  resolved_run_id bigint,
  resolution_status text not null default 'unmatched'
    check (resolution_status in ('matched', 'ambiguous', 'unmatched')),
  anomaly_flags text[] not null default '{}',
  constraint berth_occupancy_entry_event_fk
    foreign key (entry_event_id, entry_event_normalized_at_utc)
    references raw_feed_event (id, normalized_event_at_utc),
  constraint berth_occupancy_exit_event_fk
    foreign key (exit_event_id, exit_event_normalized_at_utc)
    references raw_feed_event (id, normalized_event_at_utc),
  primary key (id, entered_at)
) partition by range (entered_at);

alter sequence berth_occupancy_id_seq owned by berth_occupancy.id;
create table berth_occupancy_default partition of berth_occupancy default;

create index berth_occupancy_area_berth_idx on berth_occupancy (td_area, berth_code, entered_at desc);
create index berth_occupancy_description_idx on berth_occupancy (description, entered_at desc);
create index berth_occupancy_resolved_run_idx on berth_occupancy (resolved_run_id, entered_at);
create index berth_occupancy_entered_at_brin on berth_occupancy using brin (entered_at);

-- Map-independent nationwide current state, keyed by (projection_version, td_area, berth_code) —
-- covers every observed TD area, including areas with no published map (docs/DATA_MODEL.md §4).
create table berth_current_state (
  projection_version integer not null,
  td_area text not null,
  berth_code text not null,
  description text,
  occupancy_id bigint,
  occupancy_entered_at timestamptz,
  event_at timestamptz not null,
  source_event_id bigint not null,
  source_event_normalized_at_utc timestamptz not null,
  source_ingestion_sequence bigint not null,
  data_quality_state text not null default 'ok',
  updated_at timestamptz not null default now(),
  primary key (projection_version, td_area, berth_code),
  constraint berth_current_state_occupancy_fk
    foreign key (occupancy_id, occupancy_entered_at)
    references berth_occupancy (id, entered_at),
  constraint berth_current_state_source_event_fk
    foreign key (source_event_id, source_event_normalized_at_utc)
    references raw_feed_event (id, normalized_event_at_utc)
);

-- Mismatches/anomalies that have no occupancy row to attach to (e.g. CA/CB on an empty `from`),
-- per docs/DATA_MODEL.md §4 "State mismatches ... are anomalies to log, not reasons to drop the
-- source event." Low volume relative to the event tables, so not partitioned.
create table td_projection_anomaly (
  id bigserial primary key,
  projection_version integer not null,
  td_area text not null,
  berth_code text,
  raw_event_id bigint not null,
  raw_event_normalized_at_utc timestamptz not null,
  anomaly_code text not null,
  details jsonb not null default '{}',
  event_at timestamptz not null,
  ingestion_sequence bigint not null,
  created_at timestamptz not null default now(),
  constraint td_projection_anomaly_raw_event_fk
    foreign key (raw_event_id, raw_event_normalized_at_utc)
    references raw_feed_event (id, normalized_event_at_utc)
);

create index td_projection_anomaly_area_idx on td_projection_anomaly (td_area, event_at desc);

-- Generic map-independent S-Class current state, keyed by (projection_version, td_area, address).
-- data_quality_state is derived from the source row's timestamp_correction_code at write time
-- (genuinely known then) rather than a live-clock freshness computation, which belongs at query
-- time in the API layer, not stored here.
create table td_s_current_state (
  projection_version integer not null,
  td_area text not null,
  address text not null,
  raw_value text,
  decoded_bitset jsonb,
  event_at timestamptz not null,
  source_event_id bigint not null,
  source_event_normalized_at_utc timestamptz not null,
  source_ingestion_sequence bigint not null,
  decode_status text not null check (decode_status in ('decoded', 'raw_only', 'unsupported')),
  data_quality_state text not null default 'ok',
  updated_at timestamptz not null default now(),
  primary key (projection_version, td_area, address),
  constraint td_s_current_state_source_event_fk
    foreign key (source_event_id, source_event_normalized_at_utc)
    references raw_feed_event (id, normalized_event_at_utc)
);

-- Optional normalized bit transitions (docs/DATA_MODEL.md §5). Table created now but left
-- unpopulated by Milestone 4: there is no verified S-Class bit-decode spec/fixture in this repo
-- yet, and inventing decode semantics would violate "do not silently repair source data." Decoding
-- lands once a real, tested decode spec exists (see docs/IMPLEMENTATION_PLAN.md Milestone 0).
create sequence td_s_bit_transition_id_seq as bigint;

create table td_s_bit_transition (
  id bigint not null default nextval('td_s_bit_transition_id_seq'),
  projection_version integer not null,
  td_area text not null,
  address text not null,
  bit_index integer not null,
  previous_value boolean,
  new_value boolean not null,
  event_at timestamptz not null,
  source_event_id bigint not null,
  source_event_normalized_at_utc timestamptz not null,
  constraint td_s_bit_transition_source_event_fk
    foreign key (source_event_id, source_event_normalized_at_utc)
    references raw_feed_event (id, normalized_event_at_utc),
  primary key (id, event_at)
) partition by range (event_at);

alter sequence td_s_bit_transition_id_seq owned by td_s_bit_transition.id;
create table td_s_bit_transition_default partition of td_s_bit_transition default;
create index td_s_bit_transition_area_idx on td_s_bit_transition (td_area, address, event_at desc);
