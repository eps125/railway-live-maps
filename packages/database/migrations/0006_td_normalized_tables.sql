-- Normalized TD C-Class/S-Class tables (docs/DATA_MODEL.md §4-5). DDL only in this
-- migration — population is Milestone 4 (CA/CB/CC/CT reducers), not Milestone 2/3.
-- Partitioned per docs/DATA_MODEL.md §11; parent + default partition only here, concrete
-- month partitions come from packages/database/src/partitions.ts at runtime.
create sequence td_berth_event_id_seq as bigint;

create table td_berth_event (
  id bigint not null default nextval('td_berth_event_id_seq'),
  raw_event_id bigint not null,
  -- Denormalized copy of raw_feed_event.normalized_event_at_utc: Postgres requires a
  -- partitioned table's unique/PK columns in any FK that targets it.
  raw_event_normalized_at_utc timestamptz not null,
  td_area text not null,
  message_type text not null check (message_type in ('CA', 'CB', 'CC', 'CT')),
  from_berth text,
  to_berth text,
  description text,
  event_at timestamptz not null,
  ingestion_sequence bigint not null,
  normalization_version integer not null,
  constraint td_berth_event_raw_event_fk
    foreign key (raw_event_id, raw_event_normalized_at_utc)
    references raw_feed_event (id, normalized_event_at_utc),
  primary key (id, event_at)
) partition by range (event_at);

alter sequence td_berth_event_id_seq owned by td_berth_event.id;
create table td_berth_event_default partition of td_berth_event default;
create index td_berth_event_area_idx on td_berth_event (td_area, event_at desc);

-- Heartbeats update feed/area health only (no occupancy semantics) and are much lower
-- volume than berth events, so this table is not partitioned.
create table td_heartbeat (
  id bigserial primary key,
  raw_event_id bigint not null,
  raw_event_normalized_at_utc timestamptz not null,
  td_area text not null,
  report_time timestamptz,
  event_at timestamptz not null,
  received_at timestamptz not null,
  constraint td_heartbeat_raw_event_fk
    foreign key (raw_event_id, raw_event_normalized_at_utc)
    references raw_feed_event (id, normalized_event_at_utc)
);

create index td_heartbeat_area_idx on td_heartbeat (td_area, event_at desc);

create sequence td_s_event_id_seq as bigint;

create table td_s_event (
  id bigint not null default nextval('td_s_event_id_seq'),
  raw_event_id bigint not null,
  raw_event_normalized_at_utc timestamptz not null,
  td_area text not null,
  message_type text not null,
  address text,
  raw_value text,
  decoded_bitset jsonb,
  event_at timestamptz not null,
  ingestion_sequence bigint not null,
  normalization_version integer not null,
  decode_status text not null check (decode_status in ('decoded', 'raw_only', 'unsupported')),
  constraint td_s_event_raw_event_fk
    foreign key (raw_event_id, raw_event_normalized_at_utc)
    references raw_feed_event (id, normalized_event_at_utc),
  primary key (id, event_at)
) partition by range (event_at);

alter sequence td_s_event_id_seq owned by td_s_event.id;
create table td_s_event_default partition of td_s_event default;
create index td_s_event_area_idx on td_s_event (td_area, event_at desc);
