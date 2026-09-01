-- Milestone 16 follow-up (ADR 0003). `apps/worker/src/td/liveProjector.ts` seeds a fresh
-- `td-live-berth-state` checkpoint from the currently-open occupancy intervals:
--   select ... from berth_occupancy where projection_version = $1 and left_at is null
-- `berth_occupancy` is range-partitioned by `entered_at` and has no index on `left_at`, so that
-- seed was a sequential scan of every monthly partition (nationwide history). On the live stack
-- it exceeded `project-td-live-daemon`'s 10s statement_timeout on every tick, and because the
-- seed runs before the checkpoint advance a failure pinned the checkpoint in its "fresh" state
-- forever -- the live projector never processed an event and never published a WebSocket delta.
--
-- The open intervals are a tiny fraction of the table (only berths a train currently sits in),
-- so a partial index scoped to exactly them makes the seed an index scan regardless of how much
-- closed history has accumulated. Propagates to future partitions created by
-- packages/database/src/partitions.ts automatically.
create index if not exists berth_occupancy_open_idx
  on berth_occupancy (projection_version, td_area, berth_code)
  where left_at is null;
