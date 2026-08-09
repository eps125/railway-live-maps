-- Milestone 9: berth_occupancy.resolved_run_id was declared `bigint` in migration 0008
-- (Milestone 4), before train_run existed — its own comment already flagged it as
-- "Populated by the berth-run resolver (Milestone 9)" and it has never been written to since,
-- so this retype is safe: no real bigint values exist anywhere this migration has run. train_run
-- (migration 0015, Milestone 8) uses a uuid primary key, so the column needs to match before the
-- resolver projector can actually store a real train_run reference in it.
alter table berth_occupancy alter column resolved_run_id type uuid using null::uuid;
alter table berth_occupancy add constraint berth_occupancy_resolved_run_fk
  foreign key (resolved_run_id) references train_run (id);
