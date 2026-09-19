-- Milestone 36a (docs/IMPLEMENTATION_PLAN.md, docs/adr/0013): S-Class decoding.
--
-- Numbered 0036, not 0035: `0035_virtual_berths.sql` exists on the `gps-berths` branch (and was
-- applied in production before the 2026-09-19 revert). The migration runner applies by name, so the
-- gap is harmless and this avoids a name collision when that work is re-merged.
--
-- Every statement here is metadata-only or touches small/empty tables: `td_s_event` (~160M rows)
-- only gains nullable columns with no default, which Postgres records without rewriting or scanning
-- the table. No existing row is modified or deleted.

-- Per-event decode outcome. `decode_status` keeps its existing values ('decoded' | 'raw_only' |
-- 'unsupported'); an event the decoder rejects is 'unsupported' with the reason recorded here,
-- never dropped (CLAUDE.md rule 18). Rows written before decoding stay 'raw_only' with nulls.
alter table td_s_event add column decode_version integer;
alter table td_s_event add column decode_error_code text;

-- Per-byte decoded current state. Rows written by the decoder use projection_version 2
-- (`TD_S_STATE_PROJECTION_VERSION`); the pre-existing version-1 rows were keyed on the message
-- address (an SG's four-byte word overwrote the SF byte at the same address) and are left as-is.
alter table td_s_current_state add column byte_value smallint
  check (byte_value is null or byte_value between 0 and 255);
alter table td_s_current_state add column source_kind text
  check (source_kind is null or source_kind in ('update', 'refresh'));
alter table td_s_current_state add column last_refresh_at timestamptz;

-- Bit transitions: never populated before this milestone (every partition is empty), so NOT NULL
-- columns can be added without defaults.
alter table td_s_bit_transition add column source_kind text not null
  check (source_kind in ('update', 'refresh'));
alter table td_s_bit_transition add column source_ingestion_sequence bigint not null;

-- Idempotency: replaying the same source event can never insert a second row for the same bit.
-- Includes the partition key (event_at), as Postgres requires for a unique index on a partitioned
-- table.
create unique index td_s_bit_transition_source_uk
  on td_s_bit_transition (projection_version, source_event_id, address, bit_index, event_at);
