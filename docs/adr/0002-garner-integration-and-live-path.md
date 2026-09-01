# ADR 0002 — Source TRUST/VSTP/SCHEDULE/CORPUS/SMART from the operator's openrail instance; harden the live path

## Status

Accepted (2026-09-01). Live-path steps implemented incrementally under Milestone 15; the garner
bridge is in progress, blocked on live-schema verification.

## Context

Between 2026-08-31 and 2026-09-01 the deployment suffered repeated production incidents — a
`RESOLVER_VERSION`-bump grinding oldest-first through 14 days of nationwide history, `project-vstp`
wedged for two weeks on a schedule-delete foreign-key violation, unbounded projector queries
turning into multi-minute disk-saturating scans, orphaned Postgres connections whose queries kept
running server-side, and the live map repeatedly flipping to "data may be stale". None were
domain-logic bugs; all were consequences of _where_ work was placed:

- The live path was `ingest-td → raw_feed_event → projector-td → berth_current_state →
map-delta projector → Redis → WebSocket`, with the two middle stages each a
  `while true; do node dist/index.js <cmd>; sleep 1; done` shell loop paying a full Node cold
  start every cycle.
- `project-td` and `project-resolver` both wrote `berth_occupancy` (the resolver via denormalised
  `resolved_run_id`/`resolution_status` columns), forcing a shared advisory lock that serialised
  the two and let a slow resolver batch stall live berth positions.
- Several projector/API queries had no bounded range and scanned tables that grow without limit.
- The database reached 137 GB (~60 GB/month growth) with no retention mechanism — monthly
  partitions and no prune tooling.

The owner already runs their own instance of the openrail suite (Phil Wieland's `garner` —
`stompy`/`trustdb`/`vstpdb`/`cifdb`/`corpusdb`/`smartdb`, deployed as `eps125/openrail-eps`),
which independently subscribes to the same Network Rail feeds and maintains normalised
`trust_movement`/`trust_activation`/`cif_schedules`/`corpus`/`smart` tables in MariaDB, with a
15-day archive-to-`*_arch` retention cycle already built in. Railway Live Maps re-ingesting the
same TRUST/VSTP/SCHEDULE/CORPUS/SMART feeds duplicates the subscription, the parsing (and its
wire-format surprises), the storage, and the failure surface.

garner makes the opposite architectural bet on nearly every axis: synchronous state update in the
ingest process, no raw event log for TD, tiny fixed-size state tables, table-to-arch retention at
15 days, no run resolution (it shows the headcode and TRUST info side by side and leaves the
correlation to the human), hand-drawn SVG maps, stateless CGI + polling. It has run reliably in
the community for a decade. RLM's ambitions (replayable raw log, nationwide berth history,
playback, an editor with immutable published versions, honest `matched`/`ambiguous`/`unmatched`
resolution) are legitimately more than garner does — but the _implementation_ let liveness and
event-sourcing fight each other.

## Decision

### Live-path hardening (Milestone 15, steps 1–6)

1. **Daemonise** `projector-td`+`map-deltas` and `projector-resolver` into long-lived processes
   (`project-td-daemon`, `project-resolver-daemon`) on a short internal tick, one warm connection
   pool each — no per-cycle Node cold start.
2. **Drop** `berth_occupancy.resolved_run_id`/`resolution_status` (migration 0022). The resolver
   writes only `berth_run_resolution`; readers join it. Remove `BERTH_OCCUPANCY_WRITE_LOCK_KEY` —
   with one writer left, the deadlock it guarded against cannot occur.
3. **Bound every projector/bridge query** to an explicit range, or read an incrementally-maintained
   rollup (`td_area_summary`, migration 0023) — never an unbounded scan of an unbounded table.
   Standing rule.
4. **Retention**: a `prune-partitions --before <date> --dry-run` tool for the existing monthly
   partitions now; switching new partitions to **weekly** and partitioning `berth_run_resolution`
   are deferred to their own careful pass (documented, not lost).
5. The fully-synchronous-with-ingest write (garner-style) is explicitly _not_ adopted for now —
   daemonising removes the dominant latency without touching the ack-critical recorder path. It
   remains an available follow-up.

### Data source (Milestone 15, step "2 new")

Railway Live Maps will **source TRUST, VSTP, SCHEDULE, CORPUS and SMART data from the operator's
openrail-eps MariaDB** instead of subscribing to Network Rail a second time:

- openrail-eps publishes its `db` service port and the operator creates a **read-only**
  `GRANT SELECT` user for the bridge (never the admin credentials).
- A new flag-gated `ingest-garner` daemon (`GARNER_BRIDGE_ENABLED`, off by default, same
  discipline as `TD_LIVE_ENABLED`) reads garner's tables via `mysql2` and writes into RLM's
  **existing** Postgres shapes (`schedule`/`schedule_location`/`location_reference`/
  `smart_berth_step`/`train_run`/`train_run_event`), tagged `source = 'GARNER'`, each source table
  watermarked by its `created`/auto-increment id in `projection_checkpoint`.
- TRUST movement/cancellation/change events reuse the existing pure reducer
  (`packages/domain/src/trust/runReducer.ts`) — only the garner-row → identity/effect extraction
  layer is new; the NR-direct TRUST projector is untouched and retained for fallback.
- garner's own `trust_activation.cif_schedule_id` / `deduced` (its single-winner schedule guess)
  is **not** consumed. RLM keeps its own `resolveScheduleForTrainUid` / STP-precedence logic so
  ambiguity stays honestly reported (CLAUDE.md rule 7). `deduced` may be used as one additional
  evidence input, cross-checked.
- `train_run.origin_departure_at` and other fields RLM's TRUST projector hardcodes `null` can be
  populated from garner's richer `trust_activation_extra` (`origin_dep_timestamp`, `train_uid`,
  `schedule_wtt_id`, …).

### CLAUDE.md rule 1 exception

CLAUDE.md non-negotiable #1 (raw events retained before projection, with lineage to the source
frame) is **narrowed for these five feeds**: for TD, RLM continues to retain raw NR broker frames.
For TRUST/VSTP/SCHEDULE/CORPUS/SMART, RLM's "raw" becomes garner's already-normalised row, with
lineage recorded as `(garner_table, garner_row_id, garner_created)` rather than an NR wire frame —
because garner (itself NR-subscribed, itself retaining and archiving) is the recorder of record
for those feeds. The raw NR frames for these feeds live in garner's `stompy` spool / `*_arch`
tables, not RLM's. This is a deliberate, documented trade, not a silent violation.

## Consequences

- RLM stops holding two of the three NR STOMP subscriptions and the CIF/CORPUS/SMART downloaders;
  its own TRUST/VSTP/SCHEDULE storage shrinks substantially (compact typed rows, not JSONB, and a
  bounded mirror window rather than "forever").
- New operational coupling: garner's uptime and schema stability become RLM's, for these feeds.
  Mitigated by mirroring (not read-through) into RLM's own Postgres so recent history survives a
  garner outage, and by the bridge being a single well-scoped daemon that fails loudly.
- The garner-side change (`eps125/openrail-eps` commit 549d4af) exposes a database port — fine for
  a single-operator host behind a firewall/VPN, documented as such.
- The bridge is built against the garner C-source schema (documented in this ADR's companion
  Milestone 15 notes); it must be verified against the operator's running instance before
  `GARNER_BRIDGE_ENABLED` is turned on.
- The live map's end-to-end update latency drops from seconds (cold-start-bound) toward garner's
  sub-second liveness, without giving up the replayable log / history / playback / editor that
  distinguish RLM from garner.
