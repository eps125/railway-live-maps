-- One row for every child event in every subscribed broker frame (docs/DATA_MODEL.md §3).
-- Nationwide capture requires partitioning from the first migration that creates this table
-- (CLAUDE.md engineering rules) — partitioned by normalized_event_at_utc. Concrete month
-- partitions are created/topped-up at runtime by packages/database/src/partitions.ts
-- (ensureMonthlyPartitions), not hardcoded here; this migration creates the parent and a
-- default partition only.
--
-- normalized_event_at_utc is NOT NULL (required for the partitioned primary key): when a
-- source timestamp can't be normalized, the recorder falls back to received_at_utc as the
-- normalized value and records the reason in timestamp_correction_code/_details, per the
-- "never silently repair source data, always record the reason" rule — raw_source_timestamp_*
-- retain the untouched original values regardless.
create sequence ingestion_sequence_seq as bigint;
create sequence raw_feed_event_id_seq as bigint;

create table raw_feed_event (
  id bigint not null default nextval('raw_feed_event_id_seq'),
  ingestion_sequence bigint not null default nextval('ingestion_sequence_seq'),
  frame_id bigint not null references feed_frame (id),
  child_index integer not null,
  feed_name text not null check (feed_name in ('TD', 'TRUST', 'VSTP')),
  event_type text not null,
  message_class text check (message_class in ('C', 'S')),
  td_area text,
  raw_event_json jsonb not null,
  raw_source_timestamp_ms bigint,
  raw_source_timestamp_text text,
  normalized_event_at_utc timestamptz not null,
  received_at_utc timestamptz not null,
  broker_queue_at_utc timestamptz,
  timestamp_correction_code text not null default 'none',
  timestamp_correction_details text,
  semantic_hash text not null,
  parse_status text not null
    check (parse_status in ('parsed', 'unsupported', 'malformed', 'duplicate-redelivery')),
  parse_error_code text,
  parse_version integer not null,
  -- Defense-in-depth: the primary idempotency guard is feed_frame's unique(feed_name, body_hash),
  -- which makes redelivery a no-op before any child row is inserted at all.
  constraint raw_feed_event_frame_child_uk unique (frame_id, child_index, normalized_event_at_utc),
  primary key (id, normalized_event_at_utc)
) partition by range (normalized_event_at_utc);

alter sequence raw_feed_event_id_seq owned by raw_feed_event.id;
alter sequence ingestion_sequence_seq owned by raw_feed_event.ingestion_sequence;

create table raw_feed_event_default partition of raw_feed_event default;

create index raw_feed_event_seq_brin on raw_feed_event using brin (ingestion_sequence);
create index raw_feed_event_time_brin on raw_feed_event using brin (normalized_event_at_utc);
create index raw_feed_event_area_type_btree on raw_feed_event (td_area, event_type);
