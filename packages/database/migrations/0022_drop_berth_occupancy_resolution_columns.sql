-- Live-path hardening (2026-09-01). `berth_occupancy.resolved_run_id`/`resolution_status`
-- (migration 0008, uuid-typed by 0019) were written by project-resolver on every occupancy row it
-- touched — a second writer into the same partitioned table project-td writes into, in a
-- different row order, which is exactly what forced `BERTH_OCCUPANCY_WRITE_LOCK_KEY` to exist
-- after a real production deadlock (40P01, 2026-08-14). `berth_run_resolution` already carries
-- the same information keyed by `occupancy_id` (docs/DATA_MODEL.md §7) and is the only place any
-- reader needs it — apps/api/src/routes/td.ts's history endpoints now left-join it instead of
-- reading these columns. Dropping them removes project-resolver as a `berth_occupancy` writer
-- entirely, which removes the deadlock condition, which removes the need for the shared lock (see
-- apps/worker/src/shared/advisoryLock.ts, apps/worker/src/td/projector.ts and
-- apps/worker/src/resolver/projector.ts for the corresponding code changes).
--
-- Plain DROP COLUMN on a partitioned parent is catalog-only (no per-partition rewrite) and
-- auto-drops the column's own index/FK/check constraint — no CASCADE needed for those.
alter table berth_occupancy drop column resolved_run_id;
alter table berth_occupancy drop column resolution_status;
