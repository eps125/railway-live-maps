-- 2026-09-03. `apps/worker/src/td/projector.ts`'s `getOpenOccupancy` (and
-- `liveProjector.ts`'s seed) do:
--   select ... from berth_occupancy
--    where projection_version = $1 and td_area = $2 and berth_code = $3 and left_at is null
--    order by entered_at desc limit 1
-- Migration 0026's partial index `(projection_version, td_area, berth_code) where left_at is
-- null` matches the WHERE but not the ORDER BY, so Postgres still heap-fetches every open row
-- for the berth and sorts. Normally that's ~1 row. But when the open set is temporarily huge
-- (the ADR 0003 regression left ~3.5M intervals un-closed) the planner's row estimate for
-- `left_at is null` blows up, it abandons this partial index for
-- `berth_occupancy_area_berth_idx (td_area, berth_code, entered_at desc)`, and then scans EVERY
-- historical occupancy of a busy berth (hundreds of cold rows) to find the still-open one —
-- `project-td` ground to a near halt for hours.
--
-- Adding `entered_at desc` to the partial index makes the query a pure index seek: match the
-- `(projection_version, td_area, berth_code)` prefix, take the first entry (already in
-- `entered_at desc` order), done — no heap fetch, no sort, and no dependence on planner
-- row estimates. The index still only covers open intervals, so it stays tiny.
drop index if exists berth_occupancy_open_idx;
create index berth_occupancy_open_idx
  on berth_occupancy (projection_version, td_area, berth_code, entered_at desc)
  where left_at is null;
