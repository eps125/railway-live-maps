# ADR 0003 — Dedicated fast live-berth-state projector

## Status

Accepted (2026-09-01). Tier 2 implemented as Milestone 16. **Tier 3 implemented 2026-09-02 as
Milestone 17** — measured Tier 2 end-to-end latency (NR `eventAt` → browser) was mean 3.9 s
(0.98–7.5 s, n=16) against a target of ~500 ms, so the deferred option was taken.

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

## Tier 3 (Milestone 17 — implemented 2026-09-02)

Tier 2 still ran a rolling few-second backlog: `projector-td-live` re-scans **all** nationwide
C-Class `raw_feed_event` rows on its 100 ms tick, with ~4 checkpoint-framework round-trips per
cycle, so each event sat in `raw_feed_event` for 1–7 s before the projector's checkpoint reached
it (measured on the live stack: mean 3.9 s NR→browser).

Tier 3 moves the live-state update **into `ingest-td` itself**. In `onFrame`, immediately after
`recordFrame` has run the full archive-before-ack sequence and the broker frame is acked,
`ingest-td` takes the C-Class rows it just inserted (`recordBrokerFrame` now returns their
identities in `insertedEvents`), folds them with the same pure `foldLiveBerthState`, does one
guarded `bulkUpsertCurrentState`, and publishes the same Redis deltas — reusing
`applyLiveFromEvents` in `apps/worker/src/td/liveProjector.ts`. No projector poll, tick,
checkpoint round-trip, or nationwide re-scan between the frame arriving and the delta going out.

Ordering and invariants:

- **Strictly after the ack.** Rule 2 (archive the frame + durably index every child before
  acking) is untouched — the inline work is extra, after. A crash between ack and the inline
  upsert just means `projector-td-live` re-derives that berth from its checkpoint on the next
  tick or a restart; `berth_current_state` is a rebuildable projection.
- **Non-fatal.** `ingest-td` wraps the call in `try/catch` — a live-path or Redis failure can
  neither block ingestion nor delay acks.
- **`projector-td-live` stays running** as the catch-up / `--rebuild` path and the restart-gap
  filler. It is no longer the hot path; in steady state its upserts are guard-rejected no-ops.
- **`berth_current_state` has two writers** — `ingest-td` inline (at the feed head, almost
  always wins the `source_ingestion_sequence` monotonic guard) and `projector-td-live` (catch-up
  / restart-gap; its later writes for the same event are guard-rejected no-ops). Both sort by
  `(td_area, berth_code)`. **`projector-td` originally wrote it too but stopped 2026-09-03** —
  as a third writer its catch-up batches (per-row writes in event order) deadlocked against the
  other two every tick and the history projection froze; on `--rebuild`, `projector-td-live`
  re-seeds `berth_current_state` from the rebuilt `berth_occupancy`.
- The S3/MinIO PUT inside `recordFrame` is still ahead of the inline publish (~10–30 ms to local
  MinIO). Taking it off the path would mean reordering archive-before-ack — a separate ADR call,
  only if this still misses the target.

Expected end-to-end: NR → `ingest-td` parse + `recordFrame` (S3 PUT + ~5 DB round-trips) + 1
upsert + Redis publish + WS ≈ sub-200 ms server-side, ~1–1.3 s including NR's own wire lag.

**Measured after deploy (2026-09-02, WebSocket sniffer, n=18):** NR `eventAt` → browser
**median 1.1 s, min 0.9 s** (mean 1.9 s, inflated by duplicate re-sends). Down from Tier 2's
3.9 s median. The ~1 s floor is NR's whole-second `eventAt` truncation + wire lag, matching OTT.

**Delta dedupe (2026-09-03, `apps/worker/src/td/deltaPublisher.ts`).** Two publishers
(`ingest-td` inline, `projector-td-live`) derive the same value for the same event, so a naive
"publish after you write" double-sends every berth step (~1 s in, then again ~80 ms–7 s later,
identical payload — idempotent, invisible, but wasteful). A first attempt (`forwardWritesOnly`:
publish only if this write strictly advances `berth_current_state.source_ingestion_sequence`)
was **reverted** — the _third_ writer, `project-td`, advances that row without ever publishing,
so when it won the race both publishers skipped and the delta was **dropped** (stuck berths;
a refresh fixed them).

The fix keys the dedupe off state the **publishers** own, not `berth_current_state`:
`publishDeltaIfNewer(mapSlug, berthKey, sequence, message)` runs a Redis Lua script that, in one
atomic call replacing the plain `PUBLISH`, checks a per-berth "last published sequence" hash
(`railway:live:<slug>:pubseq`, 1-day EXPIRE), and publishes + advances it only if `sequence` is
newer. Whichever publisher reaches an event first sends it; the other's call returns 0.
`project-td` never calls it, so it cannot suppress anything. One round-trip, no latency cost.
Redis is memory-only here, so a Redis restart re-seeds the watermark on the next delta per berth
— at worst one duplicate per berth, once.

## Consequences

- One more always-on worker service (`projector-td-live`).
- `berth_current_state` has two writers again — mitigated by the monotonic guard + deterministic
  lock order (the ADR 0002 deadlock was resolver-vs-projector with different write semantics;
  here both writers derive the same value the same way in the same order).
- `berth_current_state.occupancy_id` is `NULL` in steady state. Any future reader must not treat
  it as the occupancy signal — use `description`.
- `--rebuild` must run against both projectors (or the live projector re-seeds from history,
  which the daemon does automatically on a fresh checkpoint).
- **(Tier 3)** `berth_current_state` has two writers (was three until 2026-09-03); `ingest-td` now depends on Redis (gated
  by `LIVE_WS_REDIS_PUBSUB_ENABLED`, degrades to upsert-only without it) and on
  `map_binding_index` via an in-process `BindingsCache`.
- **(Tier 3)** `recordBrokerFrame` does a `RETURNING` on the `raw_feed_event` insert it already
  ran — no extra round-trip, just a wider result.
