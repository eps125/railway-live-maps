-- Milestone 97b (docs/adr/0021): estimated delay for held trains.
--
-- `estimated_delay_band_change`: one row each time a run's *estimated* lateness band changes, or
-- its estimate ends (`band = 'cleared'`). Kept apart from `trust_delay_band_change`, which only
-- ever holds what TRUST reported. Keyed, like that table, by the run's activation TRUST id
-- (`activated_at` bounds it to this run: TRUST ids are reused a month later). The band shown for a
-- run at time T is the estimate in force at T if there is one (latest row at or before T is not
-- `cleared`), otherwise its TRUST band.
--
-- Recorded by `ingest-garner`'s held-train sweep. Lineage: the occupancy whose hold produced the
-- row (or, for a clear, the berth the run was in), plus `minutes_late` and `basis`.
--
-- New table only. Re-runnable.

create table if not exists estimated_delay_band_change (
  id bigserial primary key,
  trust_id text not null,
  activated_at timestamptz not null,
  band text not null check (band in ('on_time', 'minor', 'moderate', 'severe', 'cleared')),
  minutes_late integer,
  basis text check (basis in ('timing_point', 'held_in_berth')),
  clear_reason text,
  td_area text not null,
  berth_code text not null,
  berth_occupancy_id bigint not null,
  occupancy_entered_at timestamptz not null,
  effective_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  constraint estimated_delay_band_change_shape check (
    (band = 'cleared' and basis is null and minutes_late is null and clear_reason is not null)
    or (band <> 'cleared' and basis is not null and minutes_late is not null and clear_reason is null)
  )
);

-- "The estimate in force for this run at T": the newest row at or before T.
create index if not exists estimated_delay_band_change_trust_idx
  on estimated_delay_band_change (trust_id, effective_at desc, id desc);
