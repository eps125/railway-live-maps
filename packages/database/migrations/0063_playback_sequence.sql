-- 2026-10-31: where a recovered TD message sits in arrival order, for playback.
--
-- Playback orders by event time, then ingestion sequence. A message recovered from openrail-eps is
-- sequenced when it is imported (31 Oct 06:43–06:54: that evening), so within one second it sorts
-- after every message RLM held — and a train's recovered step into a berth then plays after its
-- held step out of it (57 such pairs). `playback_sequence` is the sequence of the held message
-- just before the recovered one in openrail-eps's arrival order; playback sorts by
-- coalesce(playback_sequence, ingestion_sequence), then ingestion_sequence. Null for everything
-- RLM received itself. Never read by the projectors.
--
-- Nullable with no default: a catalog-only change on these partitioned tables (no rewrite, no
-- scan). Additive and re-runnable.

alter table td_berth_event add column if not exists playback_sequence bigint;
alter table td_s_event add column if not exists playback_sequence bigint;
