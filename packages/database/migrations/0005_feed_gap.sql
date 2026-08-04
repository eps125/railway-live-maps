create table feed_gap (
  id bigserial primary key,
  feed_name text not null check (feed_name in ('TD', 'TRUST', 'VSTP')),
  td_area text,
  detected_start timestamptz not null,
  detected_end timestamptz,
  detection_reason text not null,
  recoverability text not null check (recoverability in ('recoverable', 'unrecoverable', 'unknown')),
  affected_sequence_start bigint,
  affected_sequence_end bigint,
  affected_time_start timestamptz,
  affected_time_end timestamptz,
  operator_note text,
  created_at timestamptz not null default now()
);

create index feed_gap_feed_name_idx on feed_gap (feed_name, detected_start desc);
