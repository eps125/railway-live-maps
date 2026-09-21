-- Milestone 62 (2026-09-21): `trust_movement`'s idempotency key
-- `(trust_id, created, loc_stanox, actual_timestamp)` collapsed genuinely distinct TRUST reports —
-- an arrival and a departure at the same location in the same minute differ only in `flags`
-- (event type; see packages/domain/src/trust/garnerMovement.ts) — and the bridge's
-- `on conflict do nothing` silently dropped one of each pair: ~0.07% of all movements, every day
-- (garner 418,918 rows on 2026-09-20 vs 418,575 distinct old keys = RLM's exact count). Adding
-- `flags` recovers all but a handful of exact repeat reports (418,913 distinct).
--
-- Written idempotently because production was NOT migrated through this file: on a populated
-- ~15M-row table a plain `create unique index` blocks writes for the whole build (see
-- 0033_td_berth_event_ingestion_sequence_idx.sql and the `migrate_verify_schema_migrations_first`
-- incident). Production got the index via `CREATE UNIQUE INDEX CONCURRENTLY` by hand, the new
-- bridge code deployed, then the old constraint dropped and `schema_migrations` backfilled. On a
-- fresh/CI database this runs instantly as written.
create unique index if not exists trust_movement_event_key
  on trust_movement (trust_id, created, loc_stanox, actual_timestamp, flags);

alter table trust_movement
  drop constraint if exists trust_movement_trust_id_created_loc_stanox_actual_timestamp_key;
