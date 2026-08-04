-- Every accepted broker frame must reference an archived original body (docs/DATA_MODEL.md §3).
-- unique(feed_name, body_hash) is the primary idempotency guard against broker redelivery:
-- recording a byte-identical frame twice is a safe no-op (see apps/worker/src/td/recorder.ts).
create table feed_frame (
  id bigserial primary key,
  feed_name text not null check (feed_name in ('TD', 'TRUST', 'VSTP')),
  topic text not null,
  broker_message_id text,
  headers_json jsonb not null default '{}'::jsonb,
  received_at timestamptz not null,
  body_hash text not null,
  archive_object_id bigint not null references raw_archive_object (id),
  child_count integer not null default 0,
  parsed_child_count integer not null default 0,
  unsupported_child_count integer not null default 0,
  failed_child_count integer not null default 0,
  parse_status text not null default 'ok' check (parse_status in ('ok', 'partial', 'failed')),
  acked_at timestamptz,
  connection_session_id bigint references feed_connection_session (id),
  constraint feed_frame_feed_body_uk unique (feed_name, body_hash)
);

create index feed_frame_received_at_brin on feed_frame using brin (received_at);
