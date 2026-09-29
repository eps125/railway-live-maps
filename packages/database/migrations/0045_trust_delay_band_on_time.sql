-- Milestone 82 revision (owner, 2026-09-29): a train with a report that is under 15 minutes late
-- (or early) is now its own band, `on_time` (drawn green), instead of sharing `none` with "no
-- information" (no report, or off route — drawn blue).
--
-- The rows already recorded use the old meaning of `none`, so they are replaced rather than
-- kept (owner decision: "just replace the old rows"). The table is a derived projection
-- (CLAUDE.md rule 3); the code that uses the new band runs as projection version 2 of
-- `trust-delay-bands`, whose fresh checkpoint re-fills the last 24 hours.
--
-- Apply AFTER the version-2 code is deployed: until then the version-1 code would keep writing
-- old-meaning rows. Before this runs, version-2 inserts of `on_time` are rejected by the old
-- check, so that code retries the same batch every tick and loses nothing.
delete from trust_delay_band_change;

alter table trust_delay_band_change
  drop constraint trust_delay_band_change_band_check;
alter table trust_delay_band_change
  add constraint trust_delay_band_change_band_check
  check (band in ('none', 'on_time', 'minor', 'moderate', 'severe'));
