# ADR 0002 — Source TRUST/VSTP/SCHEDULE/CORPUS/SMART from the operator's openrail instance; harden the live path

## Status

Accepted (2026-09-01). Live-path hardening (steps 1–6) and the resolver removal implemented under
Milestone 15. The garner bridge — CORPUS/SMART, CIF schedules and TRUST — is implemented against
the openrail-eps C-source schema (`openrail-master/database.c`); still to run against a live
instance with real `GARNER_DB_*` credentials.

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

### Data source — full mirror, not a mapping layer (Milestone 15 step "2 new"; scope expanded 2026-09-01)

Railway Live Maps will **source TRUST, VSTP, SCHEDULE, CORPUS and SMART data from the operator's
openrail-eps MariaDB** instead of subscribing to Network Rail a second time. The owner agreed
(2026-09-01) to **discard RLM's existing VSTP/CIF/schedule data and reshape those tables to
mirror garner's schema near-verbatim** — the bridge becomes a plain upsert-by-id + a `deleted`
sweep, not a schema-mapping layer with its own impedance mismatch and mapping bugs.

- openrail-eps publishes its `db` service port and the operator creates a **read-only**
  `GRANT SELECT` user for the bridge (never the admin credentials).
- `ingest-garner` daemon (`GARNER_BRIDGE_ENABLED`, off by default, same discipline as
  `TD_LIVE_ENABLED`) reads garner via `mysql2`. Each source table is watermarked by its
  `created` epoch / auto-increment `id` in `projection_checkpoint` under a `garner-<table>` name.
- **CORPUS → `location_reference`, SMART → `smart_berth_step`** — full re-sync (small, ~daily).
  Implemented (commit 43f56ac).
- **`cif_schedules` / `cif_schedule_locations`** — RLM's `schedule` / `schedule_location` tables
  are dropped and recreated as `cif_schedules` / `cif_schedule_locations` in garner shape
  (garner's column names lowercased, garner's `id` as the PK so the mirror is a pure upsert-by-id,
  garner's `deleted` epoch column instead of `withdrawn_at`, dates converted from garner's epoch
  INTs, a generated `days_runs_bitmask` from garner's `runs_*` booleans so `resolveStpPrecedence.ts`
  needs no change). Watermarked by `GREATEST(created, deleted)` so deletions are caught. Migration 0024. **Implemented 2026-09-01.**
- **`trust_activation` (+`_extra`) / `trust_movement` / `trust_cancellation` / `trust_changeorigin`
  / `trust_changeid` / `trust_changelocation` → new garner-shaped RLM tables**, watermarked by
  `created`. RLM's bespoke `train_run` / `train_run_event` / `run_schedule_link` model and
  `runReducer.ts` are **dropped** — a bespoke run model with its own reducer is exactly the
  impedance layer being removed. RLM's mirror still accumulates its own long-term history (it keeps
  synced rows after garner archives them at 15 days). Migration 0025. **Implemented 2026-09-01.**
- The NR-direct `ingest-trust` / `ingest-vstp` / `download-schedule` / `import-schedule` /
  `project-trust` / `project-vstp` / `reparse-vstp-archive` commands and roles, their Portainer
  services (`ingest-vstp`, `ingest-trust`, `projector-schedule`), and the worker code
  `apps/worker/src/{trust,vstp,schedule}/` are **removed**. The pure feed parsers
  (`packages/feed-parsers/src/{vstp,trust}/`, `parseScheduleFileStream`) and domain helpers
  (`runReducer.ts`, `mapToScheduleRow.ts`, `serviceDate.ts`, the `*_NORMALIZATION_VERSION`
  constants) are left in place as now-unused code rather than chased down. **Implemented 2026-09-01.**

### The berth-run resolver is removed and deferred (2026-09-01)

RLM's Milestone 9 resolver (`packages/domain/src/resolver/`, `apps/worker/src/resolver/`,
`berth_run_resolution` — a 23 GB table — the `project-resolver` daemon/`--backfill`/version-bump
machinery, `computeRunSummaries`, `publishResolutionDeltas`, the `run.resolution.updated` WS
message and `runSummary` delta field) was the single largest source of production incidents this
session and is **removed wholesale**. It is to be **rebuilt in a later phase** on top of garner's
own correlation work — garner's `trust_activation.cif_schedule_id` link, its
`deduced_headcode`/`deduced_headcode_status`, and its SMART berth-offset tracking (what drives
`livesig`) already do most of the job.

**Interim popup (implemented 2026-09-01):** the click-a-berth popup shows the TD headcode, then
every mirrored `cif_schedules` row whose `signalling_id` equals that headcode and that runs
today. `selectEffectiveSchedule` (STP precedence) picks one; if that is ambiguous but exactly one
candidate has a `trust_activation` today, that one is picked instead (garner's own confirmation
breaks the tie). For the effective schedule the popup shows its calling points, its
`trust_activation` (+`_extra`), and the latest `trust_movement` (late/early/off-route + event
kind decoded from garner's `flags` bit-field via `packages/domain/src/trust/garnerMovement.ts`).
A fixed `note` on every response states this is garner's data, not an RLM identification. What is
**not** yet done: consuming garner's own TD→trust_id deduction (garner's `td_states`/`livesig`
link is not mirrored), so the popup cannot show garner's single-winner pick for the ambiguous
no-activation case — that waits for the rebuild phase. `GET /api/v1/runs/{runId}` (the Milestone
8 `train_run` endpoint) is **removed** with no replacement — nothing consumed it after
run-following left the web client.

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
