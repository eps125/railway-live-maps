-- Milestone 82 (docs/IMPLEMENTATION_PLAN.md): the public map's "Delay colours".
--
-- Each row is one change in a TRUST train's lateness band, recorded by `ingest-garner` when a
-- newly mirrored `trust_movement` report moves the train into a different band:
--   none (under 15 min late, early, on time, off route), minor (15-29), moderate (30-59),
--   severe (60+).
-- Append-only: a later change is a new row, never an edit. It is a derived projection of the
-- `trust_movement` / `trust_changeid` mirror and can be rebuilt from it (CLAUDE.md rule 3): delete
-- the rows and reset the `trust-delay-bands` checkpoint, and the projection re-fills the last 24 h
-- (a fresh checkpoint starts there — which is also how the first deploy back-fills playback).
--
-- Keyed by the train's *activation* TRUST id (the root of any Change of Identity chain, since
-- reports after a CoI arrive under the new id — docs/adr/0009), because that is what a mapped
-- berth's run link reaches: berth_occupancy_run_link -> train_run.cif_schedule_id ->
-- trust_activation.trust_id. It is independent of RLM's own berth matching, so a band recorded
-- before a berth is linked is still found once it is.
--
-- `effective_at` is the report's own actual_timestamp (when it happened), which is what playback
-- asks about. `source_movement_id` is lineage to the mirrored report; not a foreign key, since
-- the TRUST mirror carries none (ADR 0002's deliberate choice) and a later retention job must not
-- be blocked by a derived table.
create table trust_delay_band_change (
  id bigserial primary key,
  trust_id text not null,
  band text not null check (band in ('none', 'minor', 'moderate', 'severe')),
  effective_at timestamptz not null,
  source_movement_id bigint not null,
  recorded_at timestamptz not null default now(),
  -- A report can only ever cause one change; re-running the projection over it is a no-op.
  constraint trust_delay_band_change_source_uk unique (source_movement_id)
);

-- "The band in force for this train at time T": the newest change at or before T.
create index trust_delay_band_change_trust_idx
  on trust_delay_band_change (trust_id, effective_at desc, id desc);
