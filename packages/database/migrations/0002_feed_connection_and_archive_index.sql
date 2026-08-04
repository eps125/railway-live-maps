create table feed_connection_session (
  id bigserial primary key,
  feed_name text not null check (feed_name in ('TD', 'TRUST', 'VSTP')),
  client_id text not null,
  connected_at timestamptz not null,
  disconnected_at timestamptz,
  disconnect_reason text,
  last_frame_at timestamptz,
  -- Informational only, not a FK: feed_gap is created in a later migration and gaps
  -- are frequently detected/recorded after the session row already exists.
  created_gap_id bigint
);

create index feed_connection_session_feed_name_idx
  on feed_connection_session (feed_name, connected_at desc);

-- Index for immutable objects in S3-compatible storage. The bytes live in object
-- storage; this table is the authoritative index and checksum record (docs/DATA_MODEL.md §3).
create table raw_archive_object (
  id bigserial primary key,
  object_key text not null unique,
  bucket text not null,
  content_sha256 text not null,
  content_encoding text,
  content_type text,
  compressed_size_bytes bigint not null,
  uncompressed_size_bytes bigint,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'ok', 'missing', 'corrupt')),
  source_kind text not null
    check (source_kind in ('broker-frame', 'schedule-file', 'reference-file', 'export', 'backup'))
);

create index raw_archive_object_source_kind_idx
  on raw_archive_object (source_kind, created_at desc);
