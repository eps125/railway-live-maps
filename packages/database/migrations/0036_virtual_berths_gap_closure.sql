-- Closes three gaps left open by migration 0035 / docs/adr/0012 (owner request, 2026-09-19):
-- manual clear for a stuck virtual berth, and automatic hand-off back to TD coverage.

-- 1. Manual clear: widen the existing TD manual-clear audit trail (migration 0017) to also cover
-- a virtual berth, rather than a parallel table for the same "who/when/why overrode live state"
-- concept. td_area/berth_code become nullable (a virtual clear has neither); stanox and a second
-- FK pair into virtual_berth_occupancy are added; a check constraint keeps every row identifying
-- exactly one kind of berth.
alter table operator_berth_action alter column td_area drop not null;
alter table operator_berth_action alter column berth_code drop not null;
alter table operator_berth_action add column stanox text;
alter table operator_berth_action add column closed_virtual_occupancy_id bigint;
alter table operator_berth_action add column closed_virtual_occupancy_entered_at timestamptz;

alter table operator_berth_action add constraint operator_berth_action_closed_virtual_occupancy_fk
  foreign key (closed_virtual_occupancy_id, closed_virtual_occupancy_entered_at)
  references virtual_berth_occupancy (id, entered_at);

alter table operator_berth_action add constraint operator_berth_action_target_check check (
  (td_area is not null and berth_code is not null and stanox is null)
  or
  (stanox is not null and td_area is null and berth_code is null)
);

create index operator_berth_action_stanox_idx
  on operator_berth_action (stanox, performed_at desc)
  where stanox is not null;

-- 2. Automatic hand-off back to TD coverage on re-entry (docs/adr/0012 follow-up): a new
-- exit_reason so project-virtual-berths-daemon can close a virtual occupancy when a corroborated
-- TD reappearance is detected, distinct from a GPS-evidenced step or a manual override.
alter table virtual_berth_occupancy drop constraint virtual_berth_occupancy_exit_reason_check;
alter table virtual_berth_occupancy add constraint virtual_berth_occupancy_exit_reason_check
  check (exit_reason in ('stepped_to_virtual', 'terminated', 'manual_clear', 'stepped_to_td', 'superseded'));

-- The corroboration query ("does any currently-open virtual occupancy share this TD event's
-- headcode") must stay bounded regardless of how large virtual_berth_occupancy grows over time —
-- a partial index on only the (small, roughly constant-size) set of currently-open rows keeps it
-- an index lookup rather than a scan of the whole partitioned history (Milestone 15 standing
-- rule: every projector query is bounded or reads a rollup).
create index virtual_berth_occupancy_headcode_open_idx
  on virtual_berth_occupancy (headcode)
  where left_at is null;

-- 3. Redis live-delta path (docs/adr/0012's own noted gap): project-virtual-berths-daemon can now
-- optionally publish to the same `railway:live:{slug}` channels apps/worker's project-map-deltas
-- (TD) already does. The two run as independent daemons with no shared in-memory counter, so a
-- shared Postgres sequence is the monotonic clock both draw from when constructing a delta
-- message's `sequence` field — without it, a virtual delta's own natural counter (e.g.
-- trust_movement.id) could read lower than a TD delta's (td_berth_event.ingestion_sequence) that
-- the client already saw on the same channel, which apps/web/src/map/useLiveMapSocket.ts treats
-- as a sequence regression and forces a spurious reconnect.
create sequence live_delta_sequence;
