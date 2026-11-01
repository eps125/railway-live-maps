-- 2026-10-31 (ADR 0008 amendment): an audit row for every run link the run-lineage daemon moves
-- to another traffic day.
--
-- A train set up in its berth before midnight for a departure after it is linked to the earlier
-- day's run (the resolver probes today and yesterday only). When the later day's TRUST activation
-- appears, `run-lineage` re-resolves the open occupancy and, if the resolver now gives the same
-- schedule on the activation's day, repoints that one link. Each move is recorded here with the
-- run it came from, so it can be reviewed and undone exactly (docs/IMPLEMENTATION_PLAN.md,
-- "Fix — run links a day out", Undo).
--
-- New table only: additive and re-runnable. Dropping it removes nothing else.

create table if not exists run_link_day_correction (
  id bigserial primary key,
  berth_occupancy_id bigint not null,
  occupancy_entered_at timestamptz not null,
  td_area text not null,
  berth_code text not null,
  description text not null,
  old_train_run_id bigint not null,
  new_train_run_id bigint not null,
  -- The new run was created by this correction (no live run of that identity existed yet).
  new_run_created boolean not null,
  old_traffic_day date not null,
  new_traffic_day date not null,
  cif_schedule_id bigint not null,
  trust_id text not null,
  match_basis text not null,
  corrected_at timestamptz not null default now(),
  constraint run_link_day_correction_days_differ check (old_traffic_day <> new_traffic_day)
);

create index if not exists run_link_day_correction_corrected_at_idx
  on run_link_day_correction (corrected_at);
create index if not exists run_link_day_correction_occupancy_idx
  on run_link_day_correction (berth_occupancy_id, occupancy_entered_at);
