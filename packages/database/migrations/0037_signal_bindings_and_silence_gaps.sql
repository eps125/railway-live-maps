-- Milestone 36b (docs/IMPLEMENTATION_PLAN.md, docs/adr/0013): live signal state.
--
-- Both tables are small (map_binding_index: a few hundred rows; feed_gap: empty in production on
-- 2026-09-19), so nothing here is slow or locks a busy table for long.

-- What a set bit means for a `td_s_bit` binding (the map binding's `activeMeans`), so the live
-- publishers can turn a bit into on/off without loading every compiled bundle. Nullable: only
-- `td_s_bit` rows carry it, and none existed before this migration.
alter table map_binding_index add column active_means text
  check (active_means is null or active_means in ('on', 'off'));

-- A TD receive silence longer than the signal-trust tolerance, recorded by `project-td` from
-- receive times (`detection_reason = 'td_receive_silence'`). One row per silence: keyed on the
-- ingestion sequence of the last row before it, so re-projecting the same rows is a no-op.
create unique index feed_gap_td_receive_silence_uk
  on feed_gap (feed_name, affected_sequence_start)
  where detection_reason = 'td_receive_silence';
