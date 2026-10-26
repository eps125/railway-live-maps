-- Milestone 97d (docs/adr/0021): backfilling held-train estimates for days before they were
-- recorded live.
--
-- 1. `maintenance_job.kind` gains 'estimate_backfill': replay the held-train sweep over a past
--    window, as known at each moment, and record what the live map would have shown.
-- 2. `estimated_delay_band_change.source`: 'live' (the sweep, as it happened) or 'backfill' (a
--    replay). A backfill only ever replaces its own earlier 'backfill' rows in its window and
--    never runs over a window with live rows, so live history is never rewritten.
--
-- Both changes are catalog-only: the check is swapped (no rows to revalidate beyond the small
-- queue), and a constant default on a new column needs no table rewrite (PostgreSQL 11+).
-- Re-runnable.

alter table maintenance_job drop constraint if exists maintenance_job_kind_check;
alter table maintenance_job add constraint maintenance_job_kind_check
  check (kind in ('berth_allowances', 'link_backfill', 'estimate_backfill'));

alter table estimated_delay_band_change
  add column if not exists source text not null default 'live';
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'estimated_delay_band_change_source_check'
  ) then
    alter table estimated_delay_band_change add constraint estimated_delay_band_change_source_check
      check (source in ('live', 'backfill'));
  end if;
end $$;
