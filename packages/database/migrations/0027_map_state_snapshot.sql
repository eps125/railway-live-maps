-- Milestone 10 (docs/IMPLEMENTATION_PLAN.md, docs/DATA_MODEL.md §9 `map_state_snapshot`):
-- periodic point-in-time snapshots of a published map's compiled berth/signal state.
--
-- Written by the `snapshot-maps` worker role (apps/worker/src/mapProjector/snapshotMaps.ts),
-- one row per currently-effective `map_version` per interval. The stored `state` is exactly
-- what `apps/api/src/lib/reconstructState.ts` produces for `snapshot_time` — a snapshot is a
-- cached reconstruction, never an independent source of truth (CLAUDE.md rule 3: current
-- state, history and playback are derived projections and must be rebuildable). `/state?at=`
-- reconstructs from `berth_occupancy` directly; snapshots exist so that state stays
-- reconstructable and auditable if the hot `berth_occupancy`/`td_berth_event` rows are ever
-- pruned under a retention policy (docs/PROJECT_SPEC.md §9: "at least 90 days; older state
-- remains reconstructable from retained nationwide events").
create table map_state_snapshot (
  id bigint generated always as identity primary key,
  map_version_id bigint not null references map_version (id),
  -- Which TD projection produced the state (matches `berth_occupancy.projection_version`); a
  -- projection-version bump makes old snapshots identifiably stale rather than silently wrong.
  projection_version integer not null,
  snapshot_time timestamptz not null,
  -- Highest `td_berth_event.ingestion_sequence` for any of this map's bound berths at or before
  -- `snapshot_time` — the deterministic "source sequence" for that instant.
  last_event_sequence bigint not null,
  -- { "berths": { "<elementId>": { "description": string|null, "enteredAt": string|null } },
  --   "signals": { "<elementId>": { "state": "blank" } } }
  -- jsonb is TOAST-compressed by Postgres, so this is the "compressed state" DATA_MODEL asks for.
  state jsonb not null,
  -- sha256 of the canonical-JSON serialisation of `state` — lets a rebuild verify a snapshot
  -- reproduces byte-for-byte without diffing the whole document.
  checksum text not null,
  created_at timestamptz not null default now(),
  constraint map_state_snapshot_unique unique (map_version_id, projection_version, snapshot_time)
);

-- The lookup `/state?at=` and the snapshot job both do: "latest snapshot for this version at or
-- before T".
create index map_state_snapshot_lookup_idx
  on map_state_snapshot (map_version_id, projection_version, snapshot_time desc);
