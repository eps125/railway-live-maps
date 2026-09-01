# ADR 0003 — Dedicated fast live-berth-state projector

## Status

Accepted (2026-09-01). Implemented as Milestone 16. Tier 3 (below) is deferred as an optional
milestone.

## Context

After the 2026-09-01 stability work, end-to-end latency (a TD frame arriving at `ingest-td` → the
change visible on the public map) settled at **6–20 seconds**. The owner's requirement is
sub-second (~500 ms), and 6–20 s is unusable for a "live" signalling map.

The latency is architectural, not tuning:

- `ingest-td` → `raw_feed_event` is ~0.3 s (capture is effectively instant).
- The entire 6–20 s is `raw_feed_event` → `berth_current_state`, i.e. `project-td-daemon`.
- `project-td-daemon` reads events in 500-row batches and, per event, runs the berth reducer with
  **~5–10 sequential single-row SQL round-trips** (read open occupancy, close it, open the new
  one, upsert `berth_current_state`, insert `td_berth_event`, anomaly checks…). Thousands of
  round-trips per batch ⇒ seconds per batch, regardless of how fast each query is. A queue of
  ~1500 events ≈ 15 s of lag because that is how long 1500 events take to grind through.
- `runProjectMapDeltas` (which publishes the Redis deltas the WebSocket layer forwards) runs
  _after_ `runProjectTd` in the same daemon tick, so while the projector is behind, no deltas are
  published at all and the map only updates on a manual refresh.

This is the event-sourcing-vs-liveness tension ADR 0002 called out, in the implementation.

## Decision (Tier 2 — this ADR)

Split the single TD projector into two, each with its own checkpoint and its own Portainer
service:

- **`project-td-live` (new, `projector-td-live` service).** The _only_ thing on the hot path.
  Reads `raw_feed_event` (TD, `message_class = 'C'`, CA/CB/CC only) in tiny batches on a ~100 ms
  tick, folds each batch to the final `description` per berth (a pure function — CA clears
  `from`/sets `to`, CB clears `from`, CC sets `to`), writes `berth_current_state` in **one bulk
  `INSERT … ON CONFLICT`** per tick, and publishes the Redis deltas itself (bindings cached
  in-process, refreshed every 30 s). No `td_berth_event`, no `berth_occupancy`, no anomalies, no
  S-Class. One table, one statement, per tick — microseconds of DB work.

- **`project-td-daemon` (existing, `projector-td` service).** Everything else — `td_berth_event`,
  `berth_occupancy` (history), `td_s_*`, `td_area_summary`, `td_heartbeat`, anomalies. Bigger
  batches; nobody watches its latency. It **no longer runs `runProjectMapDeltas`** (the live
  projector publishes now).

Both write `berth_current_state`, so both upserts carry a **monotonic guard**
(`… WHERE excluded.source_ingestion_sequence >= berth_current_state.source_ingestion_sequence`)
and sort their rows by `(td_area, berth_code)` for a deterministic lock order. In steady state
the live projector is ahead, so the history projector's writes are guard-rejected no-ops; during
a catch-up or `--rebuild` the history projector fills `berth_current_state` and the live
projector takes over once it starts.

`berth_current_state.occupancy_id` is set to `NULL` by the live projector (it does not manage
occupancy rows). It was already vestigial after the resolver removal (ADR 0002); the one reader
that used it as an "is this berth occupied?" check (`GET …/current-run`) now checks
`description IS NOT NULL`. `occupancy_entered_at` stays correct — the live projector sets it to
the `event_at` of the CA/CC that put the description there.

**Fresh-start / gap handling.** On a fresh `td-live-berth-state` checkpoint the live projector
sets its checkpoint to the history projector's current position **first and unconditionally**,
then best-effort seeds `berth_current_state` from the history projector's open `berth_occupancy`
rows (one `INSERT … SELECT`), then tails forward — no 14-day replay, no gap. If `ingest-td` is
down, NR does not replay, so the gap is permanent regardless; the history projector still
catches `berth_occupancy` up from `raw_feed_event` and the live projector re-seeds on its next
fresh start.

**Hotfix 2026-09-02 (migration 0026).** The seed originally ran _before_ the checkpoint
advance. `berth_occupancy` is partitioned by `entered_at` with no `left_at` index, so
`where projection_version = $1 and left_at is null` was a seq-scan of every partition and blew
the daemon's 10 s `statement_timeout` on the live stack. Because the failure left the checkpoint
"fresh", every subsequent tick re-attempted the same doomed seed and the projector never
processed an event or published a delta — the public map only updated on manual refresh. Fixed
by (a) partial index `berth_occupancy (projection_version, td_area, berth_code) where left_at is
null`, and (b) advancing the checkpoint first + running the seed best-effort (`try/catch`, log
and continue) since `project-td-daemon` also maintains `berth_current_state`.

### Expected latency

`ingest-td` (~0.3 s) + live-projector tick lag (~0.1–0.3 s while it keeps pace) + Redis publish +
WebSocket push ≈ **sub-second**, most of the remainder being browser/network.

## Tier 3 (deferred — Milestone 17, optional)

If Tier 2's ~0.1–0.3 s projector hop is still too much, move the live-state update **into
`ingest-td` itself**, synchronous with recording the frame (the garner/`livesig` model): when
`ingest-td` records a TD frame it also applies the berth fold to `berth_current_state` and
publishes the deltas, before moving to the next frame. `project-td-live` then goes away; the
history projector is unchanged. End-to-end becomes NR → parse → 1 bulk upsert → Redis publish →
WS ≈ tens of ms + network. The cost is putting a (small, bounded) DB write + Redis publish on
the ack-critical path; it is only worth doing if Tier 2 measurably misses the target.

## Consequences

- One more always-on worker service (`projector-td-live`).
- `berth_current_state` has two writers again — mitigated by the monotonic guard + deterministic
  lock order (the ADR 0002 deadlock was resolver-vs-projector with different write semantics;
  here both writers derive the same value the same way in the same order).
- `berth_current_state.occupancy_id` is `NULL` in steady state. Any future reader must not treat
  it as the occupancy signal — use `description`.
- `--rebuild` must run against both projectors (or the live projector re-seeds from history,
  which the daemon does automatically on a fresh checkpoint).
