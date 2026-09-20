# Bounded Implementation Plan

Do not ask Claude to build the entire product in one task. Complete and verify one milestone before moving on.

## Execution order

Milestone numbers below are stable labels (referenced by code comments throughout the repo,
e.g. `berth_occupancy.resolution_status`'s "Milestone 9" note, `/api/v1/maps/{slug}/state`'s
"Milestone 10" 501 message) — not a mandated sequence. Actual implementation order:

**Done, in the order actually built:**
0 → 1 → 2 → 3 → 4 → 5 → 6 → 11 → 12 → 7 → 8 → 9 (→ removed/superseded by ADR 0002, see M9) → 10
→ 14a → 14c → 15 → 16 → 17 → 18 → 19 → 20 → 21 → 22 → 23 → 24 → 25 → 26 → 27 → 28 → 29 → 30 → 31
→ 32 → 34 → 35 → 39 → 40 → 41 → 42 → 43 → 44 → 45 → 46 → 47 → 48 → 49 → 50 → 51 → 53; 33 (owner,
done 2026-09-19). Milestone 52 (virtual GPS-fed berths) was reverted on `main` 2026-09-19 and
lives on the `gps-berths` branch. **That number stays reserved for it** — the 2026-09-20 editor
work took 53 rather than reusing 52, so the branch can come back without a clash.

**Planned next, in current priority order (updated 2026-09-19):**
36 (36a → 36b → 36c → 36d) → 37 → 38 → 13 → _Later/unscheduled_.

**Milestone 33 was the owner's own task** (Blackpool Line map, authored in the editor) — done,
confirmed 2026-09-19; it was the prerequisite for Milestone 36. 36d is likewise the owner's task.

Milestone 13 (operational hardening) was drafted early (right after M12) and never started; it
now sits last in the priority order above rather than where its number would suggest — the
number is a stable label per the note below, not a position. Everything under "Later/unscheduled"
at the end of this file is deliberately unsequenced — pull an item forward only when it's
actually next.

M11 (visual editor MVP) and M12 (editor publishing workflow) were moved ahead of M7–M10:
both only depend on M4 (nationwide observed TD area/berth discovery) and M5 (canonical map
schema/compiler) — already done — not on schedule/TRUST/resolver/playback data, so moving
them up let maps be authored and published through the editor instead of hand-edited JSON plus
the `publish-map` CLI. M9 (the original berth-run resolver) was later removed wholesale by ADR
0002 (2026-09-01); M34 is its planned rebuild, not a continuation.

## Milestone 0 — decisions, subscriptions and fixtures

Deliverables:

- Confirm Network Rail account subscriptions and permitted source files.
- Capture sanitized TD fixtures from several distinct areas, including CA, CB, CC, CT, representative S-Class and an unsupported/unknown message type.
- Confirm the actual Preston TD `area_id` from live messages for Lancaster map bindings only.
- Capture sanitized nationwide TRUST activation/movement and VSTP fixtures.
- Define the exact Lancaster map boundary and initial berth list.
- Estimate daily PostgreSQL and object-archive growth from a representative capture.
- Confirm development-server disk capacity and backup destination.

Done when fixtures exist, nationwide capture is explicit, and no production credential appears in Git.

## Milestone 1 — repository and Docker foundation

- pnpm workspace structure.
- Strict TypeScript configuration.
- API, worker and web hello-world builds.
- PostgreSQL, Redis and S3-compatible archive connectivity.
- Portainer-suitable Compose stack and `.env.example`.
- Archive bucket creation/check command.
- `/health/live` and `/health/ready`.
- Formatter, lint, typecheck, unit-test and build commands.
- CI that runs checks and builds images.

No railway semantics yet.

## Milestone 2 — nationwide raw event store and archive

- Feed connection/session schema.
- Deterministic immutable raw-frame archive adapter.
- Partitioned `feed_frame` and `raw_feed_event` schema.
- Monotonic ingestion sequence.
- Migration runner and automatic future-partition creation.
- Projection checkpoint framework.
- Explicit redelivery/idempotency tests.
- Archive/DB reconciliation command.
- Test database and local archive setup.

Done when a complete frame and every child event can be archived/indexed, read in sequence, redelivered safely and reprocessed.

## Milestone 3 — nationwide TD recorder

- Gzip/frame parsing.
- C-Class, S-Class and generic unsupported-child envelopes.
- Store every child event from every TD area; no Preston/map allow-list.
- Durable archive-plus-database-before-ack boundary.
- Connection/backoff/heartbeat logic behind an interface.
- Fixture replay command that does not require live credentials.
- Connection/session/gap/archive metrics.
- Live feed enablement only after fixture and redelivery tests pass.

Acceptance must prove that messages from multiple areas are retained and an unknown message type is preserved rather than dropped.

## Milestone 4 — nationwide TD projections and history

- CA/CB/CC/CT reducers for every observed area.
- `berth_current_state` and `berth_occupancy` nationwide.
- Mismatch/anomaly recording.
- Generic S-Class event/current-state storage and optional bit transitions.
- Area/berth discovery and history REST endpoints.
- Projector checkpoint/rebuild command.

Acceptance fixtures include normal step, cancel, interpose overwrite, empty source, destination overwrite, duplicate delivery, equal timestamp ordering, month partition boundary and restart/replay.

**Status: implemented.** Migration `0008_td_projection_state.sql`; pure reducers in
`packages/domain/src/td/berthReducer.ts`; orchestrator in `apps/worker/src/td/projector.ts`
(`project-td [--rebuild]` command) with integration tests in `projector.integration.test.ts`
covering every acceptance scenario above; REST endpoints in `apps/api/src/routes/td.ts`. Known
limitation: S-Class bit decoding (`td_s_bit_transition`) is created but left unpopulated — there
is no verified S-Class decode spec/fixture yet (see Milestone 0), only raw storage.

## Milestone 5 — canonical map schema and basic Lancaster renderer

- Versioned map schema/validator.
- One hand-authored minimal Lancaster test document.
- Published map tables/compiler.
- SVG renderer with pan/zoom and berth click target.
- REST map definition/state endpoint.
- Lancaster signals render blank.
- Lancaster TD area identifier comes from verified map configuration, not ingestion filtering.

No visual editor yet; prove the canonical model first.

**Status: implemented.** New `packages/map-schema` package (`document.ts`/`validate.ts`/
`compiler.ts`); migration `0009_map_tables.sql` (`map`/`map_version`, DB-enforced no-overlap via
a `btree_gist` exclusion constraint); `publish-map` worker command; REST endpoints in
`apps/api/src/routes/maps.ts`; SVG renderer in `apps/web/src/map/`. The one hand-authored test
document is `packages/map-schema/fixtures/lancaster-minimal.json`. Known limitations: its `PX`
(Preston) and `CL` (Carlisle) berth bindings are **owner-asserted, not yet verified against live
captured TD messages** — confirm before treating them as real bindings (see "Confirm before
hardcoding" in CLAUDE.md and Milestone 0); `/maps/{slug}/state` only serves current live state,
point-in-time playback is Milestone 10; `map_binding_index`/drafts/snapshots are Milestone 6/11/12.
Deployed and live-tested against the owner's Portainer instance the same day (2026-08-05); two
real bugs surfaced there that unit/integration tests hadn't caught: the app Dockerfiles didn't
copy/build the new `@railway/domain`/`@railway/map-schema` workspace deps, and the map page's
`definition` fetch had no retry — a page loaded before `publish-map` ran got stuck on a stale 404
forever even after the map was published (both fixed; the second also surfaced that `apps/web`'s
test setup never ran RTL's cleanup between tests, fixed in `setupTests.ts`).

## Milestone 6 — live WebSocket

- Snapshot plus sequenced delta protocol.
- Redis pub/sub optional adapter.
- Map-specific filtering after nationwide projection.
- Browser gap detection/resync.
- Live/stale banner.
- Reconnect behavior.

Done when nationwide fixture replay updates Lancaster only for its published bindings, without discarding other-area events.

**Status: implemented.** New `packages/protocol` package (`liveWsMessages.ts`) holds the
shared WS wire-format types/zod schemas, matching `docs/API_CONTRACT.md` §2 exactly. New
`map_binding_index` table (migration `0010_map_binding_index.sql`, two partial unique
indexes — one per binding type — plus lookup indexes), populated automatically by
`publish-map` going forward and backfilled once for pre-existing versions by the new
`backfill-map-bindings` command (both share `apps/worker/src/mapBindingIndex.ts`'s
`insertMapBindingIndexRows`). `GET /api/v1/maps/{slug}/live`
(`apps/api/src/routes/liveMap.ts`) sends a snapshot (shared with `/state` via
`apps/api/src/lib/liveState.ts`'s `computeLiveState`) then forwards deltas from a
`LiveDeltaSource`; sends `resync.required` and closes if the map's published version changes
mid-connection. Two delta-source implementations: the default
`pollingDeltaSource.ts` (polls `berth_current_state` joined through `map_binding_index`, no
extra infrastructure) and the optional `redisDeltaSource.ts`
(`LIVE_WS_REDIS_PUBSUB_ENABLED=true`), fed by a new worker daemon-style one-shot command
`project-map-deltas` (`apps/worker/src/mapProjector/`) — a second, independently checkpointed
projector reading `td_berth_event` and publishing to `railway:live:{slug}` on Redis. Web:
`useLiveMapSocket.ts` hook (snapshot+delta application, exponential-backoff reconnect,
sequence-regression detection) and `LiveStatusBanner.tsx`; `useMapData.ts` now sources
berth/signal/quality state from the live socket whenever connected, falling back to the
Milestone 5 REST `/state` poll otherwise (initial connect, drop, reconnect backoff). The
literal "done" acceptance scenario is proven directly in
`apps/api/src/live/pollingDeltaSource.integration.test.ts`: a multi-area scenario shows the
delta stream for a published map emits only its own bound area/berth while an unrelated
area's `berth_current_state` row remains present and untouched in the database. Known
limitation: the Redis pub/sub path's true network round trip isn't exercised in this sandbox
(no Redis server available here, mirroring the existing no-MinIO situation) — proven instead
via a capturing fake publisher (`mapProjector/projector.integration.test.ts`) and a fake
subscriber (`apps/api/src/live/redisDeltaSource.test.ts`) that both use the exact same message
shape; confirm the real round trip against a live Redis before enabling
`LIVE_WS_REDIS_PUBSUB_ENABLED` in any real deployment.

## Milestone 7 — complete schedule/reference and VSTP import

- Archive complete source files before import.
- Daily full schedule importer using streaming parsing.
- Transactional staging/import swap or versioned activation.
- Nationwide VSTP parser/storage.
- Complete TIPLOC/location/SMART/reference import.
- Schedule query endpoint.
- Import status and metrics.

Test STP precedence, natural keys, complete-file checksums and restart/reimport behavior.

**Status: implemented.** Migrations `0012_source_file_import.sql` (tracks every downloaded/
imported file, `unique(source_kind, checksum_sha256)` recognizes a byte-identical reimport),
`0013_schedule_tables.sql` (`schedule`/`schedule_location`, natural key
`(train_uid, schedule_start_date, schedule_end_date, stp_indicator, source)`, plus `unlogged`
staging twins for the full-file swap), `0014_reference_tables.sql` (`location_reference`,
`smart_berth_step` — with a `smart_berth_step_natural_key_idx` added for reimport idempotency,
since SMART has no natural key on the wire — and `import_unhandled_record`, the catch-all
lineage table for record types outside any importer's modeled scope). VSTP is genuinely XML
(`fast-xml-parser`, `packages/feed-parsers/src/vstp/parseVstpFrame.ts`); SCHEDULE/CORPUS/SMART
full extracts are JSON (JSONL for SCHEDULE, single-document for CORPUS/SMART) — all four
fixture sets (`packages/feed-parsers/fixtures/{vstp,schedule,reference}/`) are **constructed
from the publicly documented wire formats, not captured real extracts** (same M0 fixture-gap
caveat as the rest of this milestone; confirm field names against a real capture before
treating them as verified). `apps/worker/src/vstp/projector.ts` upserts `schedule`/
`schedule_location` directly (VSTP is incremental: Create/Overwrite/Update upsert by natural key,
Delete **soft-deletes** the matching row — no staging/swap needed). Delete was originally a hard
`DELETE FROM schedule`; once Milestone 8 added the `train_run.schedule_id` /
`run_schedule_link.schedule_id` foreign keys (both ON DELETE NO ACTION), a Delete for any
schedule a TRUST activation had already linked raised `23503` and left `project-vstp` wedged on
that one event (production, stuck from 2026-08-16 until fixed 2026-08-31). `schedule` is a
rebuildable projection but one others FK into, so migration `0021_schedule_withdrawn_at.sql` adds
`schedule.withdrawn_at`: `applyDelete` stamps it instead of deleting, the row and its inbound
references survive for lineage/history, and every reader that selects a schedule _as a match
candidate_ (`resolveScheduleForTrainUid` in the TRUST projector, `GET /api/v1/schedule/{trainUid}`)
filters `withdrawn_at is null`. A later Create/Overwrite/Update for the same natural key clears
`withdrawn_at`. `--rebuild`'s `clearProjectionRows` nulls the FK references before its hard delete
(it reprocesses from sequence 0, and the TRUST deferred-relink pass re-establishes them). `apps/worker/src/schedule/
scheduleImporter.ts` implements the staging-table + single-swap-transaction pattern per
`docs/DATA_MODEL.md`: chunked staging-table inserts, then one final transaction that replaces
every `source='SCHEDULE'` row and flips `source_file_import.is_active` — "readers never see a
half-imported file." A missing header or trailer record is treated as a truncated file and
fails the whole import rather than partially applying it. `corpusImporter.ts`/
`smartImporter.ts` are simpler (smaller datasets): upsert-by-natural-key in place, no staging.
`packages/domain/src/schedule/resolveStpPrecedence.ts` implements `C` > `O` > `N` > `P`
precedence with an explicit `ambiguous` outcome for same-precedence ties (CLAUDE.md rule 7:
never hide ambiguity) — exposed via the new `GET /api/v1/schedule/{trainUid}?date=` route
(`apps/api/src/routes/schedule.ts`, documented in `docs/API_CONTRACT.md`). The shared
TD/VSTP/TRUST broker connection and archive-before-ack recorder were generalized in this
milestone (`apps/worker/src/shared/`) so TRUST (Milestone 8) doesn't need a third copy.
Download commands (`download-schedule`/`download-corpus`/`download-smart`) exist but are
gated behind `SCHEDULE_DOWNLOAD_ENABLED` and require `NR_USERNAME`/`NR_PASSWORD` — CORPUS/SMART
confirmed correct against the real NR file service 2026-08-10 (SCHEDULE's URL was wrong at
first — `SupportingFileAuthenticate` 404s for it; the real CIF full extract lives at
`CifFileAuthenticate` with an extra `day=toc-full` param, fixed same day). `ingest-vstp`/
`project-vstp` are similarly gated behind `VSTP_LIVE_ENABLED`. Known limitation:
`location_reference` upserts never remove a TIPLOC absent from a newer CORPUS extract (an
intentional "upsert in place, no delete-and-swap" design choice for this smaller dataset, not
an oversight).

2026-08-13: these three downloads were manual-only (a console command run by hand) until real
usage made clear that was a gap — reference data was silently going stale unless someone
remembered to run it. `refresh-reference-data` (`apps/worker/src/commands/
refreshReferenceData.ts`) now runs all three back to back, each independently of the others'
outcome so one bad fetch doesn't block the rest, and `schedule-reference-refresh`
(`apps/worker/src/commands/scheduleReferenceRefresh.ts`) is a new long-running worker role that
calls it once a day at `REFERENCE_DATA_REFRESH_TIME` (Europe/London wall clock, default
`01:00`) — wired up as the always-running `reference-data-refresh` service in
`deploy/docker-compose.portainer.yml`, idling unless `SCHEDULE_DOWNLOAD_ENABLED=true` (same
pattern as `ingest-td`/`ingest-vstp`/`ingest-trust`). The daily-time calculation
(`msUntilNextLondonTime`) uses the same `Intl.DateTimeFormat`-based Europe/London wall-clock
technique as `packages/domain/src/trust/serviceDate.ts`'s traffic-day boundary rather than fixed
UTC math, so the refresh stays pinned to local clock time across the BST/GMT transition — it can
land up to an hour early/late specifically on the one or two days a year the clocks actually
change (documented limitation in the function's own doc comment), which is immaterial for a
once-daily, non-safety-critical reference-data job. A failed night is logged, not thrown, so one
bad run doesn't crash-loop the container or cost the next day's attempt.

## Milestone 8 — nationwide TRUST runs and activation linkage `[implemented 2026-08-06, then superseded 2026-09-01]`

Original design and full build: a dedicated `train_run`/`train_run_event`/`run_schedule_link`
schema, a pure effects-based run reducer (mirroring `td/berthReducer.ts`), exact
activation-to-schedule resolution with a deferred-relink pass, and
`GET /api/v1/runs/{runId}`/`GET /api/v1/runs/{runId}/schedule`. Shipped and verified, then
**entirely dropped by migration 0025** (ADR 0002 / Milestone 15's "Scope expanded" step) in
favour of mirroring garner's own `trust_*` tables: `trust_activation.cif_schedule_id` is now the
activation↔schedule link (CLAUDE.md rule 6), `ingest-trust`/`project-trust` and the `runs`
routes were retired outright, and RLM no longer ingests TRUST directly from Network Rail's STOMP
broker at all — it's one of the five feeds now sourced already-normalized from garner (CLAUDE.md
rule 1's exception; only TD is still ingested raw by RLM itself). `packages/domain/src/trust/
serviceDate.ts` (UK traffic-day calculation) is the one piece of code left behind, now unused.
See ADR 0002 for the full rationale and Milestone 15 for the migration detail.

## Milestone 9 — berth-to-run resolver and popup `[implemented 2026-08-09 through 2026-08-31, then removed 2026-09-01]`

Fully built, iterated on through several real production incidents, then **entirely removed** by
ADR 0002 (2026-09-01) — `berth_run_resolution`, `project-resolver`, `resolveBerthRun.ts`, and the
`run.resolution`/`currentRun` API surface are all gone. CLAUDE.md rules 5 and 7 are held in
abeyance until Milestone 34 rebuilds this on garner's data instead. What's kept here is only the
design knowledge worth not re-learning:

- **Evidence model**: exact `signalling_id` + service-date match (never a superseded identity) as
  the only candidate filter, then a _weighted_ score from schedule-link, temporal plausibility,
  live TRUST movement-report correlation, continuity from a preceding resolved berth, and
  SMART/STANOX correlation — an exact tie at the top score is always `ambiguous`, never an
  arbitrary pick (CLAUDE.md rule 5). Two evidence types were added live in response to real
  production ties the original five couldn't break (continuity, then movement-report
  correlation) — the lesson being that a fixed evidence set found real gaps only under live
  traffic, not in fixtures.
- **Enrich candidates at read time, not at write time** — storing human-readable identity
  (headcode/UID) on every stored candidate went stale; a real user complaint about "useless"
  bare UUIDs in the ambiguous-candidate popup was fixed by joining fresh at request time instead.
- **Version-bump freshness is a real operational hazard.** A `RESOLVER_VERSION` bump replays
  history oldest-first by default, which once turned a routine deploy into a multi-hour incident
  (the live map's "today" state stayed stuck behind a multi-day backlog drain). The fix that
  worked: a bounded live-freshness window plus jumping a freshly-bumped checkpoint straight to
  "now minus the window" instead of starting at zero, with a separate `--backfill` path for
  older history. A rebuild should design this in from the start, not add it after the same
  incident recurs.
- **Two independent projector loops writing the same table need an explicit lock, immediately.**
  Concurrent `project-td`/`project-resolver` batches taking `berth_occupancy` row locks in
  different orders caused a real Postgres deadlock; a second incident showed the fix itself (a
  lock held too early, across an unrelated read) could stall the _other_ loop for 16+ seconds.
  Scope any such lock to the narrowest possible write window from day one.
- The full incident-by-incident history (locking, checkpoint-ordering, evidence-weight tuning,
  popup polish) is preserved in git history on this file if it's ever needed — not restated here.

See ADR 0002 for the removal rationale and Milestone 34 for the rebuild plan.

## Milestone 10 — snapshots and playback `[done — 2026-09-03]`

- Periodic map snapshots.
- Point-in-time state reconstruction.
- Compact map playback event endpoint.
- Seek, pause, steps, speeds and return-to-live UI.
- Map-version selection by effective time.
- Data-gap warnings.

Acceptance: repeated requests for the same time/version produce the same state and source sequence.

**Status: implemented.**

- Migration `0027_map_state_snapshot.sql`: `map_state_snapshot` (`map_version_id`,
  `projection_version`, `snapshot_time`, `last_event_sequence`, `state` jsonb, `checksum`).
- `berthChangesForEvent` moved from `apps/worker/src/mapProjector/deltaBuilder.ts` to
  `@railway/domain` (`td/berthChanges.ts`), re-exported for existing worker imports, so the
  API's `/events` endpoint derives the same CA/CB/CC → berth-change semantics.
- `@railway/database` gains `reconstructMapStateAt` — the deterministic `berth_occupancy`
  interval reconstruction (half-open `[entered_at, left_at)`), dependency-free so both apps use
  it. `apps/api/src/lib/reconstructState.ts` wraps it with `feedGapWarnings`
  (`apps/api/src/lib/feedGaps.ts`, also wired into live `computeLiveState`'s `quality.gaps`).
- `GET /api/v1/maps/{slug}/state?at=`: past `at` → `mode: "historical"` reconstruction using the
  version **effective at `at`**; future `at` → 400. `GET /api/v1/maps/{slug}/events?from&to&after
&limit`: compact, element-resolved, sequence-ordered, cursor-paginated deltas — the same wire
  shape as live WS `berth.updated`/`berth.cleared`.
- Worker `snapshot-maps` (one-shot) / `snapshot-maps-daemon` (role, `SNAPSHOT_INTERVAL_MS`
  default 5 min) — `apps/worker/src/mapProjector/snapshotMaps.ts` writes one snapshot per
  effective map version via the same `reconstructMapStateAt`; a snapshot's `state` +
  `last_event_sequence` provably equal a fresh reconstruction at its `snapshot_time`.
- Web `apps/web/src/map/usePlayback.ts` + `PlaybackControls.tsx` + `MapView.tsx` mode toggle:
  date/time picker + Jump, play/pause, step ±10s/±1m/±10m, speeds 0.25/0.5/1/2/5/10×, a
  persistent "Historical playback" badge, Return to live, and feed-gap warnings.
- Tests: `berthChanges` unit; `usePlayback` + `PlaybackControls` web unit; `maps.test.ts`
  historical/`events` unit; `playback.integration.test.ts` (determinism, version-by-effective-
  time, gap warnings, `/events` order + cursor); `snapshotMaps.integration.test.ts`
  (snapshot == reconstruction, idempotent). typecheck / lint / 330 unit tests green.
- Deploy: run migration `0027`; add the `snapshot-maps` service (compose). No behavioural
  change to live-path services.
- Known limitations: `datetime-local` input renders in the browser's local zone (self-hosted
  browsers run Europe/London, matching); the playback clock uses a 200 ms `setInterval` so it
  throttles in a backgrounded tab; snapshot pruning is deferred to Milestone 13.

## Milestone 11 — visual editor MVP

- Konva canvas.
- Grid/pan/zoom/select/move.
- Track, berth, signal, platform and label tools.
- Property panel and bindings to any observed nationwide TD area/berth.
- Undo/redo command model.
- Layers and duplicate/copy/paste.
- Draft autosave and JSON import/export.
- Validation panel.

Editor uses the same schema and reducers as the public renderer.

**Status: implemented.** `apps/web/src/editor/`: `commands.ts` (pure command model —
`addElement`/`deleteElements`/`moveElements`/`resizeElement`/`setProperty`/`setBinding`/
`connectTopology`/`disconnectTopology`/`reorderLayer`/`setLayerProperty`, each producing its
own exact inverse, mirroring `packages/domain/src/td/berthReducer.ts`'s pure-effect style),
`EditorState.tsx` (`useReducer` + Context: document/selection/undo-redo history/tool mode/
viewport), `EditorCanvas.tsx` (Konva Stage/Layer/Transformer — grid, pan, wheel-zoom,
snap-to-grid placement for all six element types, click/shift-click selection, drag-to-move,
berth resize), `ToolPalette.tsx`, `PropertyPanel.tsx` (+ `useBindingAutocomplete.ts` against
the existing nationwide `/api/v1/td/areas` endpoints), `LayersPanel.tsx`,
`ValidationPanel.tsx`, `Toolbar.tsx` (undo/redo/copy/cut/paste/duplicate + JSON import/export,
with keyboard shortcuts). A minimal hand-rolled `useRoute()` router (`/` public map vs.
`/editor`) replaces the previous single-page `App.tsx`. Known limitations (deliberately scoped
out, see the implementation plan's own scope-decision note): align/distribute, 45°-constrained/
magnetic track drawing, grouping/templates, a keyboard-shortcut help overlay, a locked
reference-image layer, and multi-point polyline drawing beyond a default two-point segment.

## Milestone 12 — editor test and publishing workflow

- Simulated/live/historical test modes.
- Nationwide binding diagnostics and observed-berth autocomplete.
- Draft revisions and optimistic locking.
- Validation gates.
- Immutable publish with effective date.
- Compiled runtime bundle and binding index.
- Version diff/review.

Done when Lancaster can be created, edited and published with no frontend source edit.

**Status: implemented and verified end-to-end in a real browser** (2026-08-06). New workspace
package `packages/map-publish` (extracted from the Milestone 5 `publish-map` CLI's inline
transaction body — `publishMapVersion`/`insertMapBindingIndexRows`) is now the single shared
publish implementation both the CLI and the editor's `POST /api/v1/editor/maps/{slug}/publish`
route call. Migration `0011_map_draft.sql`: `map_draft` (one draft per slug, seeded from the
currently published version's canonical document on first access, or a blank scaffold if none
exists yet) and `map_draft_revision` (immutable per-save snapshots, `docs/PROJECT_SPEC.md` §9's
90-day retention requirement — automatic pruning is deferred to Milestone 13). New
`apps/api/src/routes/editor/` (registered only when `EDITOR_ENABLED=true` — routes don't exist
at all when false, matching `docs/ARCHITECTURE.md` §12): `drafts.ts` (`GET`/`PUT .../draft`
with `expectedRevision` optimistic locking → `409` with the current revision on conflict,
`GET .../revisions`), `validate.ts` (three-tier validation — blocking/warning/info — via
`apps/api/src/editor/validateWithContext.ts`, which adds the two DB-dependent checks
`packages/map-schema/src/validate.ts`'s own docstring named as out of scope for that pure
package: adjacent-map-slug existence and "ever observed in nationwide data" binding warnings),
`publish.ts` (re-checks the optimistic lock under a row lock, re-validates server-side, then
calls `publishMapVersion` — publication-blocking is enforced by the server, not only the
editor UI), `diff.ts` (structural element/binding/layer diff, defaulting to "current draft vs.
currently published version"), `bindingDiagnostics.ts`, `state.ts` (live test-mode state
compiled from the draft's own bindings on the fly, since a draft has no `map_version_id`/
`map_binding_index` row yet; historical is explicitly deferred to Milestone 10, 501-stubbed the
same way `routes/maps.ts`'s `/state` already is). Web: `useDraftSync.ts` (debounced autosave,
surfaces a `409` as a distinct "someone/something changed this draft" state rather than
silently overwriting), `TestModePanel.tsx` (simulated mode reuses the exact
`applyCA`/`applyCB`/`applyCC` pure functions from `packages/domain` per
`docs/MAP_EDITOR_SPEC.md` §10's "the preview must use the same reducers... as the public
application"; live mode polls the new state endpoint), `ReviewPanel.tsx` (diff view,
effective-date picker, publish button surfacing conflict/validation-failure/success states).
Verified manually end-to-end in a real browser (Vite dev server + API with
`EDITOR_ENABLED=true`): the editor seeded its draft from the real published
`packages/map-schema/fixtures/lancaster-minimal.json` content (4 layers, 5 berths), Validate
correctly surfaced 5 "never observed" warnings with zero blocking errors, Review's diff showed
zero changes against the just-seeded draft, and Publish created a new immutable `map_version`
(confirmed via `GET /api/v1/maps/lancaster/definition` returning the new version) that the
public `/` route immediately rendered. Known limitation: this session's browser pane couldn't
composite screenshots/pixel-coordinate clicks, so the Konva canvas's own pointer interactions
(placing an element by clicking, dragging to move, corner-resize) were proven only via the 53
integration + 136 unit tests (including a Konva-in-jsdom smoke-mount test via
`vitest-canvas-mock`), not visually in a live browser — re-verify those specific gestures
visually before treating the canvas UX itself as polished.

## Milestone 13 — operational hardening `[planned — sequenced last, see Execution order]`

Drafted early (right after M12) and never started. "Private editor/diagnostic access" below is
superseded by Milestone 29's login — this milestone's remaining scope is everything else in the
list. Rate limiting/security headers here can share groundwork with Milestone 29's login-endpoint
rate limiting rather than being built twice.

- Public status page.
- Feed/archive/database/projection metrics and alerts.
- Rate limiting and security headers.
- ~~Private editor/diagnostic access~~ — done via Milestone 29 instead.
- PostgreSQL and object-archive backups.
- Documented restore and raw-event reprocessing test.
- Log rotation and storage monitoring.
- Multi-day soak test using captured nationwide feed volume.
- Non-safety-critical notices and licence attribution.

## Milestone 14 — public renderer visual polish and theming

Owner reviewed reference examples (2026-08-05) of two quite different professional signalling-panel
aesthetics — a modern flat/dark control-room look and a retro monochrome CRT mimic-panel look —
and asked to pencil this in as a future milestone rather than pick a direction yet.

**Direction chosen 2026-09-07 — see `docs/adr/0004-map-track-platform-standardisation.md`.**
Modern flat/dark panel. Reference maps (OpenTrainTimes, Traksy) inspected once with owner
permission under CLAUDE.md rule 14. The ADR's open-question answers:

- Track: continuous polyline per running line, `stroke-linejoin: round`, **no junction dots**;
  1:2 diagonal slope; row pitch 30; points/switches as short blade stubs (later).
- Platforms: filled rect, Traksy orange `#FFA500` via `--map-platform-fill`, number in a white
  bordered box; new `station` element carrying a CRS.
- Berth colour semantics beyond occupied/vacant: still deferred (no change this phase).
- Berth boxes only-when-occupied: behind a per-viewer toggle, default on.

Split into an active phase (14a) and a later phase (14b).

### Milestone 14a — track/berth/platform standardisation `[done — 2026-09-07]`

Implemented in one pass; `pnpm run build:libs`, `pnpm -r typecheck`, `pnpm run lint`,
`prettier --check` and the map-schema + web `map`/`editor` vitest suites (117 tests, 8 new)
all green. No DB migration. Delivered:

- `packages/map-schema/src/style.ts` (`MAP_STYLE`, `MAP_CSS_TOKENS`) and
  `packages/map-schema/src/geometry.ts` (`berthRenderRect`, `pointOnPathAtX`), both exported
  from `index.ts` and unit-tested (`geometry.test.ts`, 10 tests).
- `document.ts`: `StationElementSchema` added to the union (`crs` optional, 3-upper regex;
  `name` required); `berth` gained optional `stationId` + `crs`; `platform` gained optional
  `trackElementId` + `stationId`. `schemaVersion` stays 1.
- `compiler.ts`: `weldTrackPaths` merges topology-joined coincident `trackPath` segments into
  one polyline before indexing, re-pointing `trackElementId` back-references; wired into
  `compileMapDocument`. Covered by 5 new `compiler.test.ts` cases (merge, remap, no-merge on a
  bare crossing, no-merge across different lines, full-pipeline).
- `MapRenderer.tsx`: berth `<rect>`/`<text>` positioned via `berthRenderRect`; track polyline
  `strokeLinejoin="round"` + `shapeRendering="geometricPrecision"` + `MAP_STYLE` width/colour;
  new `renderPlatform` (orange `var(--map-platform-fill, #ffa500)` bar + white number box);
  `station` text; `showEmptyBerths` prop (default true) hides vacant boxes when false. 4 new
  `MapRenderer.test.tsx` cases.
- `MapView.tsx`: "Show empty berths" checkbox, `localStorage`-persisted (try/catch), passed to
  both the live and playback renderers.
- `EditorCanvas.tsx`: same `berthRenderRect` centring (visual `yOffset`, group stays at
  authored x/y so drag/resize math is untouched); orange platform bar + number; `station`
  render; `station` tool default element + layer hint.
- `EditorState.tsx` / `ToolPalette.tsx`: `station` tool mode. `PropertyPanel.tsx`: `station`
  block (name/CRS/TIPLOC/x/y/font), `berth` gained a Station `<select>` + CRS field.
- `styles.css`: `--map-platform-*` / `--map-station-label` tokens on `:root`;
  `.map-page__toggle`.
- `docs/MAP_EDITOR_SPEC.md` §3: `station`, the new `berth`/`platform` fields, and a Style
  profile subsection.

**Files changed (for reference)**

- `packages/map-schema/src/style.ts` _(new)_ — the D4 style-profile constants (row pitch,
  diagonal slope, stroke widths, berth/platform dimensions, weld tolerance, colour tokens),
  exported from `index.ts`.
- `packages/map-schema/src/geometry.ts` _(new)_ — `berthRenderRect(berth, elementsById)` (D1)
  and `pointOnPathAtX(points, x)`; unit-tested in `geometry.test.ts`.
- `packages/map-schema/src/document.ts` — add `StationElementSchema` (`crs`, `name`, `tiploc?`,
  `x`, `y`) to `MapElementSchema`; add optional `stationId` and `crs` to `BerthElementSchema`.
  `schemaVersion` stays 1 (additive/optional).
- `packages/map-schema/src/compiler.ts` — D2 interim weld of coincident + topology-joined
  `trackPath` elements into single polylines; include `station` in `computeBoundingBox`.
- `packages/map-schema/src/compiler.test.ts`, `validate.test.ts`, `document.test.ts`,
  `lancasterFixture.test.ts` — cover the weld, the new element, the new berth fields.
- `apps/web/src/map/MapRenderer.tsx` — consume `berthRenderRect` for berth `<rect>`/`<text>`;
  `strokeLinejoin="round"` + `shapeRendering="geometricPrecision"` on track polylines; render
  `station`; upgraded `platform` (bound rect offset from track, `--map-platform-fill`, number
  box); read the "show empty berths" toggle.
- `apps/web/src/map/MapRenderer.test.tsx` — berth centred on bound track; platform number
  rendered; station name rendered; empty-berth toggle hides vacant boxes.
- `apps/web/src/map/MapView.tsx` (or the map chrome component) — the "show empty berths"
  toggle control + `localStorage` persistence (try/catch).
- `apps/web/src/app.css` (or the map stylesheet) — `--map-platform-fill: #ffa500` and the
  other colour tokens, defined on `:root` with the existing dark palette.
- `apps/web/src/editor/EditorCanvas.tsx` — same `berthRenderRect` for the berth node so the
  canvas matches the renderer (rule 13); draw `station`; upgraded `platform`.
- `apps/web/src/editor/ToolPalette.tsx`, `EditorState.tsx`/`commands.ts` — a Station tool
  (`addElement` already generic; add the default `station` shape).
- `apps/web/src/editor/PropertyPanel.tsx` — `crs` field on `station`; `stationId` (+ optional
  `crs`) on `berth`.
- `docs/MAP_EDITOR_SPEC.md` §3 — document the `station` element, the new `berth` fields and the
  D4 style profile.
- A visual-regression fixture per new/changed symbol in both renderers (MAP_EDITOR_SPEC §12).

**Acceptance criteria**

1. A berth bound via `trackElementId` renders vertically centred on that track in both the
   public renderer and the editor canvas; an unbound berth is unchanged. No map republish
   needed for the current Lancaster map.
2. Zooming the public map to maximum shows no gap where a diagonal `trackPath` meets a
   horizontal one, for tracks that are topology-joined. `compileMapDocument` welds those into a
   single polyline; a compiler test asserts the merged `points` and that non-joined visual
   crossings are left untouched.
3. `platform` elements render as an orange (`#FFA500`, via `--map-platform-fill`) filled bar
   offset from the bound track, with `number` in a white bordered box. Changing the token
   restyles every platform with no component edit.
4. A `station` element renders its `name`; `crs` round-trips through schema validation,
   compile, publish and the editor property panel. `berth.stationId` / `berth.crs` likewise.
   No deduction or API behaviour changes (D7 stays deferred).
5. "Show empty berths" toggle: on = today's behaviour; off = only occupied berths draw a box;
   choice persists across reloads; editor always shows outlines.
6. Style constants (row pitch 30, slope 1:2, berth height 20, weld tolerance 6, …) live only in
   `packages/map-schema/src/style.ts` and are imported by compiler, renderer and editor — no
   duplicated literals.
7. `pnpm -r lint typecheck test` green; `pnpm --filter @railway/database migrate` unaffected
   (no DB migration in 14a); `MAP_EDITOR_SPEC.md` updated in this change.

### Milestone 14b — structural track model and correlation `[merged into Milestone 38]`

Superseded by Milestone 38 ("editor structural track model & visual overhaul") near the end of
this file, which carries this milestone's full scope forward — including **D5's structural
"berth = span on a track" model**, deferred alongside D3/Route A per ADR 0004 — plus line-name
labels, the tunnels/viaducts/neutral-sections/boundary annotation family, arrow ticks,
points/switch glyphs, and "set route" highlighting. The one piece _not_ in M38, because it has
its own milestone instead: **D7 station-berth schedule deduction** is Milestone 35.

### Milestone 14c — editor authoring: track snapping, multi-vertex platforms, platform numbers, signal modes `[done — 2026-09-08]`

See `docs/adr/0005-editor-track-platform-signal-authoring.md`. Closes the editor-authoring gap
14a left (ADR 0004 D3 correction). No DB migration; `schemaVersion` stays 1. `build:libs`,
`pnpm -r typecheck`, `pnpm run lint`, `prettier --check` and `vite build` all green; the
map-schema + web `map`/`editor` vitest suites pass at 132 (15 new: geometrySnap ×9, document
×2, MapRenderer ×3, EditorCanvas ×1) and `apps/api` at 25.

Delivered: `packages/map-schema/src/document.ts` (`platformNumber` element, optional
`signal.renderMode`, `platform.number` marked deprecated) + `index.ts` export;
`apps/web/src/editor/geometrySnap.ts` (+ `.test.ts`, 9 tests — `SNAP_ANGLES_DEG`,
`snapSegmentAngle`, `weldToEndpoint`); `EditorCanvas.tsx` (E1 endpoint angle-snap + weld +
shared synthetic `topologyEdgeId` in `handlePointDragEnd`; E2 `handleInsertVertex` /
`handleRemoveVertex` on segment/handle double-click; `platformNumber` render + tool + layer
hint; signal `offset` branch); `EditorState.tsx` / `ToolPalette.tsx` (`platformNumber` tool);
`PropertyPanel.tsx` (`platformNumber` block; signal "Offset style" checkbox; `platform.number`
field removed); `MapRenderer.tsx` (shared `numberBox`, `renderPlatformNumber`, `renderSignal`
with `offset`); `apps/api/src/editor/draftStore.ts` (5-layer blank scaffold); `styles.css`
(`.field--checkbox`); `docs/MAP_EDITOR_SPEC.md` §3/§7.

**Revision (2026-09-08, follow-up):** `platform` with 3+ points is now a **filled polygon**
(vertices vary its width; new-platform default is a rectangle) in both renderers; a legacy
2-point platform stays a bar. `platform.number` is **no longer rendered at all** (was "still
drawn for old maps") — only standalone `platformNumber` elements draw a number, in the same
white-box style. Vertex insertion handles a polygon's closing edge; removal keeps a polygon
≥ 3 points. Consequence: a pre-0005 map using `platform.number` shows no number until
re-authored (Lancaster needs re-authoring for filled platforms regardless).

**Revision 2 (2026-09-08, follow-up):** track angle-snap is now **unconditional** (nearest of
`{0°,±1:2,±1:1,90°}`, no 6° window — it wasn't firing often enough to feel real) and the
snapped endpoint quantises its distance along the ray rather than grid-snapping x/y; platform
corners + platform/number placement snap to **half the grid step**. `apps/web/src/editor/apiJson.ts`
(`readApiJson`, + test) turns the `Unexpected token '<'` publish failure — the `/api` request
falling through to `index.html` — into a message naming the cause (`ReviewPanel.tsx`,
`EditorApp.tsx` now use it).

**Revision 3 (2026-09-10):** editor ↔ live-map parity. The editor canvas now **fits the view to
the document's bounding box on first load** (like `MapRenderer.tsx` does from
`bundle.boundingBox`) instead of opening at (0,0)/scale-1 — that alone was making the same map
look "in a different place / a different size" between the two. Text placement is reconciled via
`anchoredText()` in `EditorCanvas.tsx` (+ test): Konva anchors a `Text` at its top-left, SVG at
the alphabetic baseline with `text-anchor`, so station/label text was drawn left-aligned from
`x` in the editor vs centred on `x` in the live map — the helper offsets by ~0.8·fontSize
vertically and a fixed box width for centre/right. Boundary dot matched to the public r=4 grey
glyph; inline signal label matched to `x+10, baseline y+4`. (Also note: the **live map always
shows the last _published_ version** — a draft edited after publishing looks different until
re-published.)

Known limitations: E1 weld uses a synthetic `topologyEdgeId` (no real `topology` node/edge — a
14b concern); vertex removal is double-click only (no Delete-key selection); `platformNumber` is
not auto-linked to a platform on placement; the `offset` signal stem is always vertical; a
platform authored under the pre-0005 "thick centreline" model renders oddly as a filled polygon
until redrawn.

**Original plan (for reference):**

**E1 — track tool angle-snap + endpoint weld**

- Files: `apps/web/src/editor/EditorCanvas.tsx` (draw + endpoint-drag snap to
  `{0°, ±1:2, ±1:1, 90°}` within threshold, Alt to bypass; endpoint within
  `MAP_STYLE.weldTolerance` of another track endpoint snaps onto it and adds a `topology`
  node/edge if missing), a pure `apps/web/src/editor/geometrySnap.ts` (+ `.test.ts`) for the
  angle/weld math.
- Acceptance: a dragged track endpoint released near 26–27° lands exactly on 1:2 and near
  43–47° on 1:1; an endpoint released within 6 units of another track's end coincides with it
  and the published bundle then welds the two (ADR 0004 D2); Alt-drag leaves a free angle.

**E2 — multi-vertex polylines + vertex add/remove**

- Files: `EditorCanvas.tsx` (double-click a selected track/platform segment inserts a
  grid/angle-snapped vertex; a selected vertex handle + Delete/Backspace or right-click removes
  it, blocked below 2 points), reuses the existing `setProperty "points"` command.
- Acceptance: a platform can be given ≥ 4 corners (L-shape) and a corner removed; undo/redo is
  one step per add/remove; a 2-point element refuses vertex removal.

**E3 — independent `platformNumber` element + Platforms layer**

- Files: `packages/map-schema/src/document.ts` (`PlatformNumberElementSchema` → union;
  `platform.number` marked deprecated in a doc comment, still parsed/rendered),
  `index.ts` (type export), `compiler.ts` bounding box (covered by the generic x/y branch),
  `MapRenderer.tsx` (`platformNumber` render = the existing white-box glyph, standalone),
  `EditorCanvas.tsx` + `ToolPalette.tsx` + `EditorState.tsx` (`platformNumber` tool),
  `PropertyPanel.tsx` (`platformNumber` block: text/x/y/platformId; drop `platform.number`
  field), `apps/api/src/editor/draftStore.ts` (blank scaffold → Track/Platforms/Berths/
  Signals/Labels layers), `EditorCanvas.tsx` `defaultLayerIdForTool` + on-demand "Platforms"
  layer creation, default `zIndex` nudge so numbers paint above bars.
- Tests: `document.test.ts` (parse `platformNumber`, `platform.number` still valid),
  `MapRenderer.test.tsx` (standalone number renders; legacy `platform.number` still renders).
- Acceptance: a number is placed and moved independently of its platform; both sit on the
  Platforms layer with the number above the bar; a pre-ADR-0005 map with `platform.number`
  still shows its numbers.

**E4 — signal render mode `inline` | `offset`**

- Files: `document.ts` (`signal.renderMode` enum, default `inline`), `index.ts`,
  `MapRenderer.tsx` + `EditorCanvas.tsx` (shared `offset` branch: stem `MAP_STYLE.signal.offset`
  long off the track, filled aspect-colour head with a thin dark outline, label centred below;
  side from `orientation`), `PropertyPanel.tsx` (checkbox flipping `renderMode`).
- Look at OpenTrainTimes for inspiration (`.stem` / `.aspect` / `.sig_id`, left/right `g.sig`
  groups) — deliberately not identical (shorter stem, solid head, keep blank/on/off colours).
- Acceptance: toggling the checkbox switches a signal between the current on-track circle and a
  stem+offset-head form in both the canvas and the public renderer; aspect logic unchanged
  (blank/on/off only, no calculation — CLAUDE.md rule 9).

Deferred out of 14c: applying angle-snap retroactively to existing tracks; a dedicated
platform-shape template; auto-linking `platformNumber.platformId` on placement.

## Milestone 15 — live-path hardening and garner integration

Prompted by a run of production incidents (2026-08-31 → 09-01: RESOLVER_VERSION-bump grind,
project-vstp FK wedge, unbounded retry-pass and `/td/areas` scans, orphaned-connection scan
storms, repeated "data may be stale" banners). Root causes were architectural placement, not
domain logic — see `docs/adr/0002-garner-integration-and-live-path.md` for the full analysis and
the openrail (garner) comparison that informed it. Seven steps, tackled as one push; status per
step below.

**Step 1+2 — daemonise the live path. `[done — commit bc2f98b]`**
The `projector-td`/`map-deltas`/`projector-resolver` Portainer services ran
`while true; do node dist/index.js <cmd>; sleep 1; done` — a full Node cold start every cycle was
the dominant end-to-end latency, and td vs map-deltas were two unsynchronised loops that could
drift and stack their waits. New long-lived roles (`apps/worker/src/commands/projectTdDaemon.ts`,
`projectResolverDaemon.ts`, on the shared `apps/worker/src/shared/daemonLoop.ts` harness):
`project-td-daemon` runs `runProjectTd` then `runProjectMapDeltas` back-to-back on a 250ms tick in
one warm process; `project-resolver-daemon` runs the resolver live loop on a 500ms tick.
`--rebuild`/`--backfill` stay as the one-shot commands. The truly synchronous-with-ingest write
(garner-style, state updated in the recorder's ack transaction) was deliberately _not_ attempted —
higher risk against the ack-critical path, and daemonising already removes the dominant latency.
Follow-up if the daemon tick still isn't tight enough: move `berth_current_state` +
delta-publish into the `ingest-td` recorder transaction, keeping `td_berth_event`/`berth_occupancy`
history projection async.

**Step 3 — drop denormalised `berth_occupancy` resolution columns. `[done — commit c90bdc9]`**
Migration 0022 dropped `resolved_run_id`/`resolution_status`. project-resolver no longer writes
`berth_occupancy` at all (only `berth_run_resolution`), so the cross-projector row-order deadlock
condition is gone and `BERTH_OCCUPANCY_WRITE_LOCK_KEY` was removed from both projectors (it was
the lock-contention source behind the stale-data throttling). `apps/api/src/routes/td.ts` history
endpoints left-join `berth_run_resolution` — `resolution_status` is now nullable (null = "no
resolution recorded yet", distinct from an attempted-and-`unmatched`).

**Step 4 — retention. `[partial — prune tool done; weekly partitions + berth_run_resolution
partitioning deferred]`**
Done: `prune-partitions --before <YYYY-MM-DD> [--dry-run]` command drops whole existing (monthly)
partitions older than the cutoff in FK-safe order, dry-run by default. `TD_RAW_RETENTION_DAYS`
config knob documents the intended policy. **Deferred (own careful pass — DB is 137 GB, four
incidents in 24h):** (a) switching new partitions from monthly to **weekly** so pruning can
operate at sub-month granularity — `packages/database/src/partitions.ts` +
`ensurePartitions.ts` + tests, applies only to future data; (b) making `berth_run_resolution`
(23 GB, unpartitioned, 28.7M rows) prunable by partitioning it on `occupancy_entered_at` so old
months drop alongside the TD data — a create-partitioned-copy + swap migration.
Acceptance for both: existing history untouched, a dry-run reports exactly what a real run would
drop, and `ensure-partitions` keeps a safe lead of future weekly partitions.

**Step 5 — resolver scope + storage. `[partial — mapped-area scoping done; candidate-JSON
trimming / lazy resolution deferred]`**
Done: the eager forward scan is scoped to occupancies in areas a published map actually binds
(join `map_binding_index`) plus the existing recent-window bound — nationwide history for
unmapped areas is resolved on demand via `--backfill`, not eagerly forever. This caps
`berth_run_resolution` growth. **Deferred:** trimming the stored `candidates` JSON (drop the
per-candidate `reasons` strings; recompute for the popup) and/or moving to fully lazy
(resolve-on-view + cache) resolution — both change the resolver's trigger model and want their
own pass. Acceptance: `berth_run_resolution` per-row size roughly halves, or the table only holds
rows for occupancies someone has actually looked at.

**Step 6 — bounded queries. `[done — commits 900768b, 884e24a, c90bdc9]`**
Movement-correlation query bounded on the `train_run_event` partition key; retry-pass query
bounded to recently-decided resolutions and reversed to `desc` so `LIMIT` fills instantly;
`/td/areas` reads the new `td_area_summary` rollup (migration 0023, maintained incrementally by
project-td) instead of a full `group by` scan of `raw_feed_event`. Standing rule going forward:
every projector/bridge query carries an explicit bounded range or reads a rollup — never an
unbounded scan of a table that grows without limit.

**Step 2 (new) — garner bridge: source TRUST / VSTP / SCHEDULE / CORPUS / SMART from the owner's
openrail-eps instance instead of subscribing to Network Rail a second time. `[done — 2026-09-01]`**
See `docs/adr/0002-garner-integration-and-live-path.md`.

- openrail-eps side: MariaDB port exposed (`eps125/openrail-eps` commit 549d4af) with a
  documented read-only `GRANT SELECT` user.
- RLM side: `mysql2` dependency, `createGarnerPool` (read-only, fail-fast), `GARNER_BRIDGE_ENABLED`
  - `GARNER_DB_*` config (off by default; `loadConfig` fails fast if enabled without host/user),
    and the `ingest-garner` long-running role on the shared `daemonLoop` harness with its own
    Portainer service (safe no-op at the default). Ticks every 20s: TRUST every tick, schedules
    every 3rd, CORPUS/SMART every 15th.
- `runGarnerReferenceSync`: full re-sync of `corpus` → `location_reference` and `smart` →
  `smart_berth_step` (`source = 'GARNER'`).
- `runGarnerScheduleSync`: `cif_schedules` → `cif_schedules` (garner-shaped, migration 0024;
  upsert-by-id, watermarked by `GREATEST(created, deleted)` so soft-deletes are caught) and
  `cif_schedule_locations` → `cif_schedule_locations` (delete + re-insert per touched schedule,
  `seq_no` assigned in `sort_time` order).
- `runGarnerTrustSync`: `trust_activation` / `trust_activation_extra` / `trust_movement` /
  `trust_cancellation` / `trust_changeorigin` / `trust_changeid` / `trust_changelocation` →
  same-named garner-shaped RLM tables (migration 0025), watermarked by `created` in
  `projection_checkpoint` under `garner-<table>` names, `on conflict do nothing`.
- Schema reshaped from the C-source DDL in `openrail-master/database.c` (verified 2026-09-01):
  epoch INT columns → `timestamptz`/`date`, `runs_*` booleans kept + generated
  `days_runs_bitmask`, `trust_movement.flags` decoded by
  `packages/domain/src/trust/garnerMovement.ts`.
- Retired: `apps/worker/src/{trust,vstp,schedule}/`, the `project-vstp` / `project-trust` /
  `import-schedule` / `download-schedule` / `ingest-vstp` / `ingest-trust` / `reparse-vstp-archive`
  commands+roles, the `ingest-vstp` / `ingest-trust` / `projector-schedule` Portainer services,
  and `GET /api/v1/runs/{runId}`. `GET /api/v1/schedule/:trainUid`, `GET /api/v1/vstp/schedules`
  and the click-a-berth popup (`GET .../current-run`) were repointed at the garner mirror.

**Still deferred:** consuming garner's own TD-berth → `trust_id` deduction (its `td_states` /
`livesig` link is not mirrored), which would let the popup show a single-winner identification
for the ambiguous, no-activation-today case. That is part of the resolver-rebuild phase.

**Scope expanded 2026-09-01 (owner):** discard RLM's VSTP/CIF/schedule data and reshape those
tables to **mirror garner's schema near-verbatim**; drop RLM's bespoke `train_run` /
`train_run_event` / `run_schedule_link` model + `runReducer.ts` and mirror garner's `trust_*`
tables instead; **remove RLM's Milestone 9 berth-run resolver wholesale** (`berth_run_resolution`,
`packages/domain/src/resolver/`, `apps/worker/src/resolver/`, the `project-resolver` daemon and
all its machinery, `computeRunSummaries`, `publishResolutionDeltas`, the `run.resolution.updated`
WS message + `runSummary` delta field) and rebuild it in a later phase on garner's correlation
data. Interim the click-a-berth popup shows garner's deduced schedule + latest movement, labelled
as garner's. See ADR 0002's "full mirror" and "berth-run resolver is removed and deferred"
sections; CLAUDE.md non-negotiables 5/6/7 are held in abeyance. Migrations: 0024 (schedule →
garner shape), 0025 (drop `berth_run_resolution` + `train_run*` + `run_schedule_link`, add
garner-shaped `trust_*`).

**Step 7 (new) — remove the berth-run resolver from the live path. `[done — this change]`**
Deleted `packages/domain/src/resolver/` (`resolveBerthRun` + `RESOLVER_VERSION` + candidate
types), `apps/worker/src/resolver/`, `apps/worker/src/commands/projectResolver*.ts`, the
`project-resolver` / `project-resolver-daemon` roles and their Portainer service wiring.
Stripped the `run.resolution.updated` WS message and the `runSummary` field from the live
protocol (`packages/protocol`), the map-delta projector (`publishResolutionDeltas`,
`buildRunResolutionDeltaMessages`) and the web renderer (run-following, matched-vs-ambiguous
berth shading, the run-lost grace window — a clicked berth's popup is now keyed purely on the
element). Stripped `computeRunSummaries` and `runSummary` from `apps/api/src/lib/liveState.ts`
so the snapshot / `/state` responses no longer query `berth_run_resolution` / `train_run_event`;
reverted `apps/api/src/routes/td.ts`'s history endpoints to plain `berth_occupancy` reads (no
`resolution_status`). `berth_run_resolution`, `train_run`, `train_run_event` and
`run_schedule_link` still exist and still back `GET /api/v1/runs/{runId}` and the
`current-run` popup endpoint until migration 0025 drops them in the garner phase; `RESOLVER_*`
config knobs removed. See ADR 0002 "The berth-run resolver is removed and deferred".

**Milestone 9 (resolver) status changes to: superseded by ADR 0002; to be re-planned as its own
milestone before any rebuild.**

**Live-path robustness fixes, same rollout, still active today.** Three more bugs surfaced
running the garner mirror against the real openrail-eps instance for the first time, fixed in
one pass:

- `createPool` (`packages/database/src/pool.ts`) attaches a `pool.on('error')` listener and
  enables TCP keepalive on every pool — without the listener, an idle pooled client whose
  connection is dropped server-side (a Postgres restart) threw an uncaught exception and killed
  `project-td-daemon` outright; an opt-in `statementTimeoutMs` (`project-td-daemon` 15s,
  `ingest-garner` 30s) stops a query hung on a connection Postgres already killed from wedging
  the daemon loop forever.
- `runDaemonLoop` backs off (`errorBackoffMs`, default 5s) after a failing tick instead of
  retrying at the full 250ms rate.
- `StompConnection` gained a silent-stall watchdog: if nothing arrives from the broker (not even
  a heartbeat) for `max(heartbeatMs*3, 90s)`, the socket force-closes so the reconnect loop takes
  over — catches a feed that's gone dead while the TCP socket itself stays open.
- `ingest-garner` self-throttles: smaller per-batch caps, `synchronous_commit = off` (all mirror
  data is rebuildable), and it skips garner sync entirely on any tick where `project-td` is
  stalled or more than 5000 TD events behind — an unthrottled initial backfill had saturated
  disk write bandwidth and starved the live projector.
- `runProjectTd` gained a `maxBatches` cap (`project-td-daemon` uses 20/tick, ~10k events) so a
  large catch-up no longer blocks `runProjectMapDeltas` (which runs right after it in the same
  tick) for minutes at a time — without the cap, the WS delta stream went silent and the live map
  looked "stuck" during any real backlog drain even though the REST snapshot stayed fresh.

Postgres itself was also tuned live (`shared_buffers` 128MB→2GB, `wal_compression=on`, larger
`max_wal_size`) — folded into `deploy/docker-compose.portainer.yml`'s `postgres` `command:` flags.

## Milestone 16 — dedicated fast live-berth-state projector `[done — 2026-09-01]`

See `docs/adr/0003-dedicated-live-berth-state-projector.md`. After the Milestone 15 stability
work, end-to-end latency (TD frame → visible on the public map) sat at 6–20 s because the single
`project-td-daemon` did ~5–10 sequential single-row SQL round-trips per event and published
deltas only after the whole projection batch.

- **`project-td-live-daemon` (new, `projector-td-live` service, 100 ms tick).** The only thing on
  the hot path: reads `raw_feed_event` (TD, C-Class, CA/CB/CC) in tiny batches, folds each batch
  to the final `description` per berth (pure `foldLiveBerthState`), writes `berth_current_state`
  in **one bulk `INSERT … ON CONFLICT`** per tick, publishes the WebSocket Redis deltas itself
  (bindings cached in-process, 30 s TTL). Seeds `berth_current_state` from the history projector's
  open `berth_occupancy` rows on a fresh checkpoint, then tails from the history checkpoint
  position (no replay, no gap).
- **`project-td-daemon` (existing, `projector-td` service).** Everything else — `td_berth_event`,
  `berth_occupancy` history, `td_s_*`, `td_area_summary`, `td_heartbeat`, anomalies. No longer
  publishes deltas.
- Both write `berth_current_state`; both upserts carry a monotonic guard
  (`excluded.source_ingestion_sequence >= …`) and sort rows by `(td_area, berth_code)`.
- `berth_current_state.occupancy_id` is now `NULL` in steady state (the live projector doesn't
  manage occupancy rows). `GET …/current-run` checks `description IS NOT NULL` for "occupied";
  `POST …/editor/berths/{a}/{b}/clear` reads `berth_occupancy` directly.
- `project-td --rebuild` also resets the `td-live-berth-state` checkpoint so the live projector
  re-seeds.

**Hotfix, same day (migration 0026):** the fresh-checkpoint seed query (populating
`berth_current_state` from open `berth_occupancy` rows) had no index on `left_at`, so it blew the
10s statement timeout on every tick — the live projector never processed a single event or
published a delta after deploy. Fixed with a partial index (`where left_at is null`) and by
moving the seed to run once, best-effort, rather than being retried every tick.

Expected: `ingest-td` (~0.3 s) + live-projector hop (~0.1–0.3 s) + Redis + WS ≈ sub-second.

## Milestone 17 — synchronous live-state in `ingest-td` (Tier 3) `[done — 2026-09-02]`

Milestone 16 was measured on the live stack at mean 3.9 s NR→browser (0.98–7.5 s, n=16) — the
100 ms projector re-scans all nationwide C-Class events and runs a rolling few-second backlog.

Implemented: `ingest-td`'s `onFrame`, **after** `recordFrame` + ack, folds the C-Class rows it
just inserted (`recordBrokerFrame` now returns them in `insertedEvents`) via the shared
`applyLiveFromEvents` — one guarded `bulkUpsertCurrentState` + the same Redis deltas — so
`berth_current_state` is current and the delta is on the wire within the frame handler, no
projector poll in between. `project-td-live` stays as the catch-up / `--rebuild` / restart-gap
path (its steady-state upserts are now guard-rejected no-ops). Rule 2's archive-before-ack is
untouched (inline work is strictly after the ack) and the inline call is `try/catch` non-fatal.
`berth_current_state` now has three monotonic-guarded writers. See ADR 0003 "Tier 3".

Files: `apps/worker/src/shared/recordBrokerFrame.ts` (`insertedEvents` via `RETURNING`),
`apps/worker/src/td/liveProjector.ts` (`applyLiveFromEvents`, `publishBerthDeltas`,
`bulkUpsertCurrentState` exported), `apps/worker/src/commands/ingestTd.ts` (Redis client +
`BindingsCache` + inline call). Not-yet-done follow-up: take the S3 PUT off the path (needs an
ADR call on reordering archive-before-ack).

## Milestone 18 — batched writes in `project-td-daemon` (history projector) `[done — 2026-09-11]`

Symptom: after a stack restart, `project-td` (the non-hot-path history projector — `td_berth_event`,
`berth_occupancy`, `td_s_*`, `td_heartbeat`, `td_area_summary`) took far longer than expected to
catch up to the ingestion head, even on a 16-core/8GB box. Root cause: `runProjectTd`'s per-batch
loop (`apps/worker/src/td/projector.ts`) issued one `select`/`insert`/`update` round-trip **per
event** (up to ~2–4 for a CA row: two `getOpenOccupancy` selects, the `td_berth_event` insert, one
or more effect writes) — ~1,000–2,000 sequential round trips for a 500-row batch, all on one
connection under one Postgres advisory lock (`runProjectTd` only ever has one instance running at
a time). That's a serial, WAL-fsync-bound workload — confirmed on the live stack via
`pg_stat_activity` (`WalSync`/`WALWrite` wait events, one Postgres backend near 100% CPU while 15
other cores sat idle). Adding CPU/RAM does not help a workload with no concurrency to spread
across cores; only fewer, larger round trips do.

Fix: restructured the per-batch loop to run a fixed, small number of bulk statements per batch
instead of one round trip per row:

- `td_heartbeat` / `td_berth_event` / `td_s_event`: one multi-row `insert … on conflict do
nothing` each (`returning raw_event_id` on the latter two, to recover exactly which rows were
  newly projected vs. already-seen replays — the same idempotency guard as before, just resolved
  for the whole batch at once).
- `td_s_current_state`: newly-projected S-Class rows are folded to one-per-`(td_area,
currentStateKey)` (last-by-ingestion-order wins — Postgres can't `ON CONFLICT DO UPDATE` the same
  key twice in one statement) before a single bulk upsert.
- CA/CB/CC occupancy open/close/anomaly effects (`processCClassBatch`): one bulk read of every
  distinct `(td_area, berth)` pair the batch's newly-projected rows touch (replacing up to two
  `select`s per row), folded in-memory against the _same_ pure `applyCA`/`applyCB`/`applyCC`
  reducers (unchanged) while iterating strictly in ingestion order, then three bulk statements
  (`insert` opens, `update` closes, `insert` anomalies). A batch of `berth_occupancy_id_seq` values
  is reserved up front (one `nextval` round trip) so a same-batch close can reference an
  occupancy opened earlier in the same batch before that row is otherwise looked up; opens are
  written before closes so a same-batch open-then-close still finds its row (ordinary
  read-your-writes visibility within the one transaction — no in-memory merging needed).
- `td_area_summary` upsert and checkpoint advance: unchanged (already batched).

Verified against a disposable, loopback-only Postgres container (same host, migrated fresh, torn
down after — production untouched): all 15 existing `projector.ts` integration tests pass
unchanged, plus one new test (`same-batch churn: a long open/close chain for one berth within a
single batch …`) exercising a 5-step open/close/reopen chain for one berth inside a single batch,
the specific case the reserved-id/opens-before-closes ordering exists for. A 20,000-event synthetic
load (same host) measured **~968 events/sec**, vs. the ~187 events/sec observed on the live stack's
catch-up before this change — roughly 5x.

Files: `apps/worker/src/td/projector.ts` (rewrite), `apps/worker/src/td/projector.integration.test.ts`
(new test).

Known limitation / not done in this change: the live-status banner (`GET …/state`'s `quality.status`,
`apps/api/src/lib/mapVersion.ts`'s `liveDataStatus`) still determines freshness from
`td_heartbeat`/`td_berth_event` only — both owned by this same non-hot-path projector — so it can
still report "stale" for several minutes after a restart even though `berth_current_state` (the
actual live map, kept fresh by `projector-td-live`/Tier 3) is current. This change makes that window
shorter (catch-up is ~5x faster) but does not remove it; `liveDataStatus` should also treat
`berth_current_state.updated_at` as freshness evidence — separately scoped, not yet implemented.

## Milestone 19 — publish defaults to "all time" so playback always uses the latest map `[done — 2026-09-11]`

Owner decision 2026-09-11: for this deployment, older `map_version` rows only need to exist for
rollback, not for genuine time-scoped historical accuracy — the owner corrects map data (e.g. a
mis-bound berth code) and wants every playback timestamp, past and future, to reflect the fix
immediately, without having to remember to backdate `effectiveFrom` on every publish. This does
not weaken CLAUDE.md rule 11 ("published map versions are immutable and have effective date
ranges") — versions are still immutable rows with real effective-date columns, and a publish can
still specify a genuine time-scoped `effectiveFrom` when that's actually wanted (a real physical
resignalling, say). Only the _default_ changed.

- `packages/map-publish/src/publishMapVersion.ts`: new exported `EFFECTIVE_FROM_ALL_TIME` (Unix
  epoch — well before any TD data this project has ever captured). The three publish entry points
  (`apps/api/src/routes/editor/publish.ts`, `apps/worker/src/commands/publishMap.ts`'s
  `--effective-from` flag, and the editor's `ReviewPanel.tsx`) now default to this instead of
  `new Date()` when no explicit date is given.
- `apps/web/src/editor/ReviewPanel.tsx`: added an "Apply to all playback, including history
  (recommended)" checkbox, checked by default — when checked, `effectiveFrom` is omitted from the
  publish request entirely (letting the API's own default apply) rather than the component
  needing to know the sentinel value itself. Unchecking reveals the original date picker for a
  genuine time-scoped version.
- Bug caught by end-to-end verification (not by the unit/integration suites, which never exercised
  this ordering): `publishMapVersion`'s "close out the previously open version" step set that row's
  `effective_to` to the _new_ version's `effectiveFrom` unconditionally. When the new version's
  `effectiveFrom` (now potentially `EFFECTIVE_FROM_ALL_TIME`, i.e. 1970) is _earlier_ than the row
  being closed had as its own `effective_from` (e.g. a previous real-dated publish), that produces
  an invalid range (`upper < lower`) — Postgres's range type rejects this outright as a hard error,
  it does not silently treat it as empty. Fixed by clamping: `effective_to = greatest(effective_from, $newEffectiveFrom)`,
  which always produces a valid range — a zero-width, empty one exactly when the old row is meant
  to be immediately and fully superseded, which still correctly never matches any real `at`.

Verified end-to-end against a disposable Postgres container (same pattern as Milestone 18):
published a version with a real historical `effectiveFrom` (2026-06-01), then a second version
with the new default, and confirmed `currentVersionForSlug` resolves to the latest version for
`at` timestamps both before and after the first version's date (including 2020, years before
either version existed) — the specific behavior this milestone exists to deliver. Also re-ran the
full `publish`/`mapVersion`/`playback`/`drafts`/`diff`/`liveMap`/`backfillMapBindings` integration
suites (19 tests) against the same throwaway database; all pass, including the existing
"republishing closes the prior open version" test, confirming the range-clamp fix doesn't change
behavior for an ordinary now-or-later-dated republish.

Files: `packages/map-publish/src/publishMapVersion.ts`, `packages/map-publish/src/index.ts`,
`apps/api/src/routes/editor/publish.ts`, `apps/worker/src/commands/publishMap.ts`,
`apps/web/src/editor/ReviewPanel.tsx`.

**Follow-up fix (2026-09-11, found in production):** the first real Lancaster publish after this
landed hit `conflicting key value violates exclusion constraint "map_version_no_overlap"`. The
close-out step only closed the single row where `effective_to is null` — correct for the
end-to-end test above, which only ever had one prior version to worry about, but Lancaster had 38
real, already-closed, non-overlapping historical versions (a normal day-to-day editing history
predating this milestone). A new version published with `EFFECTIVE_FROM_ALL_TIME` inserts an
open-ended `[1970-01-01, infinity)` range, which genuinely overlaps _every one_ of those 38 rows,
not just the most recently open one. Fixed by widening the close-out `update` to
`where effective_to is null or effective_to > $2` — closing every row that could overlap the new
one, not only the currently-open row. For an ordinary same-day republish this changes nothing
(older rows already end before the new date, so the extra clause never matches anything new); for
the retroactive/epoch case it correctly collapses all prior versions to empty ranges. Reproduced
the exact failure against a disposable Postgres container (seeded 39 sequential real-dated
versions matching Lancaster's actual shape, then published a 40th with `EFFECTIVE_FROM_ALL_TIME`)
and confirmed the fix resolves it, with `currentVersionForSlug` correctly resolving the latest
version for timestamps before, during, and after the old history. Existing tests still pass
(`packages/map-publish` unit tests; `publish`/`mapVersion`/`playback`/`drafts`/`backfillMapBindings`
integration tests) — two unrelated integration tests flaked from a ~1.2s clock skew between this
session's dev machine and the remote throwaway-DB host used for ad-hoc verification, not a real
regression (neither touches `publishMapVersion` at all).

## Milestone 20 — auto-deploy on green CI `[implemented, awaiting one-time manual setup — 2026-09-11]`

Owner decision 2026-09-11: every push to `main` that passes CI should redeploy the box
automatically, no approval step. Two mechanisms were ruled out during investigation before
landing on this one:

- **Portainer stack webhook** — Business Edition only; this deployment is Community Edition.
- **GitOps (Portainer polling the git repo + CI auto-committing a SHA pin)** — technically sound
  (and would have doubled as the SHA-pinning `docs/ARCHITECTURE.md` §8 already recommends), but
  the owner preferred to keep going with the previously-proposed approach instead.
- **Raw SSH + `docker compose pull/up`** — this box only runs the Portainer _agent_; `docker
inspect` on a running container shows its compose config at `/data/compose/29/docker-compose.yml`,
  which does not exist on this host. The real Portainer server (and its rendered compose files)
  lives elsewhere, so there's no local compose file to target directly.

Landed on **Watchtower** (`containrrr/watchtower`, MIT-licensed, free): a service added to
`deploy/docker-compose.portainer.yml` that watches only the containers labeled
`com.centurylinklabs.watchtower.enable=true` (every api/web/worker-role service — a new
`x-watchtower-label` anchor applied to exactly those 9 services, never
postgres/redis/archive/the unrelated openrail-eps containers sharing this host) and, when POSTed
to on its bearer-token-gated HTTP API, pulls the newest `:latest` for each and recreates any
container whose image actually changed. `WATCHTOWER_CLEANUP` removes each superseded image
afterward (this box is RAM/disk-constrained). Verified with `docker compose config` on the real
host (render-only, nothing started or touched) that the file is syntactically valid and exactly
the intended 9 services carry the label.

**Connectivity:** GitHub's cloud-hosted Actions runners cannot reach this box's private LAN
address (`10.1.1.66`) at all — this would have blocked the webhook and raw-SSH approaches too,
not just Watchtower. Owner chose a self-hosted GitHub Actions runner living on this same box
(`deploy/docker-compose.runner.yml`, `myoung34/github-runner`, `network_mode: host` so it can
reach the host's own loopback) over a public port-forward. This let `watchtower`'s port move to
**loopback-only** (`127.0.0.1:${WATCHTOWER_PORT}`) — not just token-gated but genuinely
unreachable from anywhere but this host, since nothing outside it needs to reach it anymore.
`.github/workflows/ci.yml`'s new `deploy` job runs on `[self-hosted, railway-live-maps-deploy]`
(needs: `publish`, only on push to `main`) and does one `curl -X POST` with the bearer token to
`http://127.0.0.1:6056/v1/update`. Verified the workflow YAML parses correctly (via the repo's own
`js-yaml` dependency) and both new/changed compose files render cleanly with `docker compose
config` on the real host (render-only — nothing started, production untouched).

**Remaining: one-time manual setup only**, all owner-side (documented step-by-step in
`docs/DEPLOYMENT.md`'s deploy section) — generate and set `WATCHTOWER_HTTP_API_TOKEN` in both
Portainer's stack env editor and as a GitHub Actions secret, generate a runner registration token
from GitHub's UI, and bring up `docker-compose.runner.yml` on the box. None of these are things an
agent should do on the owner's behalf (registering infrastructure against their GitHub account,
handling bearer tokens).

Files: `deploy/docker-compose.portainer.yml`, `deploy/docker-compose.runner.yml` (new),
`deploy/.env.example`, `.github/workflows/ci.yml`, `docs/DEPLOYMENT.md`.

**Follow-up fix (2026-09-11, same day, found in production):** the runner crash-looped after its
first real deploy job. It had genuinely completed the job successfully (watchtower's own log
showed `Scanned=9 Updated=9 Failed=0`, confirmed against the running containers), but the runner
container itself still exited afterward and `restart: unless-stopped` tried to re-register it
using the original one-time `RUNNER_TOKEN` — already consumed, so every restart 404'd against
GitHub and looped forever. Because the runner vanished mid-job, that job's status hung "in
progress" on GitHub indefinitely even though its actual work was done; cancelled it by hand
(`gh run cancel`) since nothing would ever complete it. Root cause not fully pinned down (this
image's `EPHEMERAL` flag may check only whether the variable is _set_, not its value, so
`EPHEMERAL: "false"` may still have been read as enabled — the upstream project's own docs
recommend omitting the variable entirely for persistent mode, not setting it false). Fixed by
switching authentication from `RUNNER_TOKEN` (GitHub's manually-copied, ~1hr, single-use
registration token) to `ACCESS_TOKEN` (a durable GitHub personal access token): the entrypoint
mints a fresh registration token from the GitHub API on every container start, so _any_ restart —
for any reason — always re-registers cleanly instead of depending on a token that can expire
mid-lifetime. `EPHEMERAL` is now omitted entirely rather than set to `"false"`.

Files: `deploy/docker-compose.runner.yml`, `docs/DEPLOYMENT.md`.

## Milestone 21 — opt-in TD-area fringe pairs (`berth.inhibitedBy`) `[done — 2026-09-11]`

Owner-reported: watching `1S58` cross the PX/CL boundary, it showed simultaneously in `PX CE04`
and `CL 0005` — both correct and expected (each describer independently reports the same physical
crossing from its own side; see the earlier `1S56` PX/CL boundary-mirroring investigation the same
day), but visually confusing as two apparently-independent occupied berths. Owner explicitly
wanted this handled without touching any real data or attempting run-identity resolution (which
CLAUDE.md rules 5/7 keep deliberately deferred/honest about ambiguity, pending the garner-based
resolver phase).

Added `berth.inhibitedBy?: string` (`packages/map-schema/src/document.ts`): an author-declared,
opt-in id of another `berth` element on the same map. Purely a live-rendering rule, not run
identity — a static, human-declared fact about track topology ("these two berths are the same
physical crossing"). When the referenced berth's _current_ description equals this berth's, this
berth renders blank; `berth_current_state`/`berth_occupancy`/history/playback are entirely
untouched, only what gets drawn changes. `packages/map-schema/src/validate.ts` rejects a
self-reference or a reference to a non-existent berth element (`inhibited_by_self_reference` /
`inhibited_by_missing_element`). No compiler change needed — the field passes through
`elementsById` automatically.

Applied independently in both renderers, since they are deliberately separate implementations
(not a rule-13 violation — that rule covers shared domain model/state semantics, not shared
rendering code, per `EditorCanvas.tsx`'s own existing doc comment): the public SVG renderer
(`apps/web/src/map/MapRenderer.tsx`) and the editor's Konva Test-mode preview
(`apps/web/src/editor/EditorCanvas.tsx`, careful to substitute `{ description: null }` rather than
`undefined` so an inhibited berth renders blank during an active preview rather than falling back
to the design-time placeholder `displayName`). Editor UI: `apps/web/src/editor/PropertyPanel.tsx`
gained an "Inhibited by" dropdown on the berth property block, same pattern as the existing
Station field.

Files: `packages/map-schema/src/document.ts`, `packages/map-schema/src/validate.ts` (+test),
`apps/web/src/map/MapRenderer.tsx` (+test), `apps/web/src/editor/EditorCanvas.tsx`,
`apps/web/src/editor/PropertyPanel.tsx`, `docs/MAP_EDITOR_SPEC.md`.

**Known gap, not fixed here** (pre-existing, matches `stationId`'s identical gap):
`apps/web/src/editor/commands.ts`'s `applyRenameElement` doesn't rewrite `inhibitedBy` (or
`stationId`) when the referenced element is renamed — renaming a berth silently orphans any other
berth's `inhibitedBy` pointing at it.

## Milestone 22 — fix the editor's "seen in nationwide data" validation check being effectively always-skipped `[done — 2026-09-11]`

Owner-reported: the "ever observed in nationwide data" validate/publish check was always skipping
("takes too long"), and had previously been slow enough to time out the API gateway and 500 a
publish (which is what made it best-effort/skippable in the first place — see
`apps/api/src/editor/validateWithContext.ts`'s existing `OBSERVED_LOOKBACK_DAYS` doc comment).
Root cause: the check queried `td_berth_event` — a partitioned nationwide table with **no index
on `from_berth`/`to_berth`** (every raw CA/CB/CC step, including cancels and null-marker steps) —
via one `e.from_berth = ? or e.to_berth = ?` correlated `EXISTS` probe **per berth binding on the
map** (Lancaster: ~78 bindings). Without an index on either side of that `OR`, each probe fell
back to scanning matching rows in the relevant partition(s), repeated ~78 times. Confirmed live: a
literal `EXPLAIN ANALYZE` of the old query against Lancaster's real 78 bindings hit a 15s
statement timeout outright — meaning `OBSERVED_CHECK_TIMEOUT_MS` (8s) was being hit essentially
every time, not just under unusual load, which is why the check always showed as skipped.

Fixed by switching the query from `td_berth_event` to `berth_occupancy`, which already carries a
matching index (`berth_occupancy_area_berth_idx (td_area, berth_code, entered_at desc)`, migration 0008) — no new migration, no new index, no production risk. `berth_occupancy` holds one row per
real occupancy interval rather than every raw step, and has a single `berth_code` column rather
than a `from`/`to` pair to `OR` across, so the rewritten query is a clean two-column-equality plus
range index seek — arguably also the more honest signal for what this check claims ("has a real
train genuinely occupied this berth recently") than a raw step log that can include e.g. a cancel
on a berth that was never actually occupied. Verified live with `EXPLAIN ANALYZE` against
Lancaster's real 78 bindings: `Index Only Scan` on the migration-0008 index, `Heap Fetches: 0`,
**32ms total** (down from a 15s timeout) — comfortably inside `OBSERVED_CHECK_TIMEOUT_MS` with
wide margin, so the check now actually runs on every validate/publish instead of being skipped.

Files: `apps/api/src/editor/validateWithContext.ts` (+test).

## Milestone 23 — root-cause the TD reconnect instability (`ingest-td` never handled SIGTERM) `[done — 2026-09-11]`

Resolves the long-open "TD reconnect instability" issue: `ingest-td` reconnects every ~20-30
minutes and `feed_connection_session.disconnected_at` is always `NULL`. Owner-reported trigger:
`1U01` never appeared to have entered `PX A292` at all in our data (a real `from_berth_empty`
anomaly, not a bug in the anomaly logic itself — see the same day's chat investigation) — the
timing lined up with a session reconnect gap, prompting a proper investigation of _why_ ingest-td
reconnects so often instead of continuing to treat it as unavoidable background noise.

Root cause found in `apps/worker/src/commands/ingestTd.ts`: `runIngestTd` did
`await connection.start({...})` **before** `return runUntilShutdownSignal(...)`.
`StompConnection.start()` (`apps/worker/src/shared/connection/stomp/stompConnection.ts`) runs
`while (!this.stopped) { ... }` internally and only resolves once something calls `stop()` — i.e.
never, during ordinary healthy operation, since nothing calls `stop()` until the shutdown handler
itself runs. So that `await` never completed while the feed was healthy, `runUntilShutdownSignal`
(and the SIGTERM/SIGINT listeners it registers) was **never actually reached**, and every ordinary
container stop/restart/redeploy sent SIGTERM to a process with no handler installed for it —
Node's default disposition terminates immediately, skipping the entire graceful-shutdown path:

- `connection.stop()` never runs, so no STOMP `DISCONNECT` is ever sent — `stop()`'s own existing
  comment already documented the consequence of this exact scenario: Network Rail's broker can
  then reject the _next_ connection attempt with a stale-session error until its own timeout
  releases it, which is a second, compounding source of "reconnect instability" beyond the missed
  messages themselves.
- The socket's `close` handler (which calls `onSessionEnd` and writes `disconnected_at`) never
  gets a chance to run before the process exits — explaining why every row was `NULL`.

Every reconnect during this gap is a real, unrecoverable data loss window: Network Rail's STOMP
feed does not replay missed messages after a reconnect, so any TD step broadcast while
disconnected is gone permanently — this is very likely the mechanism behind other, previously
unexplained `from_berth_empty`/gap-shaped anomalies too, not just the `1U01` case that surfaced it.

Fixed by not awaiting `connection.start()` before calling `runUntilShutdownSignal` — fire-and-forget
(errors already surface via the existing `onError` callback, not via this promise rejecting), so
the SIGTERM/SIGINT handler is registered immediately regardless of the connection's own state.
Added `apps/worker/src/shared/runUntilShutdownSignal.test.ts`, which didn't exist before: a
"root cause" test reproducing the exact bug shape with a fake never-resolving `start()` (proving
SIGTERM is silently dropped under the old call order) alongside a test proving the fix handles it
correctly even while that promise is still pending.

Files: `apps/worker/src/commands/ingestTd.ts`,
`apps/worker/src/shared/runUntilShutdownSignal.test.ts` (new).

**Not yet done:** `feed_gap` has zero recorded rows despite these reconnects — gap _detection_
itself isn't currently wired up to notice a reconnect and record the affected window, which is
what `docs/PROJECT_SPEC.md §11.8`/`feedGapWarnings` (`apps/api/src/lib/feedGaps.ts`) are actually
for. Worth a follow-up once this fix has had time to show whether it meaningfully reduces
reconnect frequency in practice.

## Milestone 24 — editor: group-move for track paths/platforms; centered label default `[done — 2026-09-11]`

Two small owner-requested editor fixes:

1. **Multi-select group move for tracks/platforms.** The underlying infrastructure already fully
   supported this — marquee/shift-click multi-select (`apps/web/src/editor/EditorCanvas.tsx`) and
   the `moveElements` command (`apps/web/src/editor/commands.ts`) already move an arbitrary,
   mixed-type group of elements in one undoable step, and `handlePositionedDragEnd` (berths,
   signals, labels, stations, boundaries) already checked the active selection before deciding
   what to move. The one gap: `handlePathDragEnd` (`trackPath`/`platform` — the points-array
   element types) never consulted `selection` at all, always moving only the single dragged
   track/platform even when it was part of a larger active selection — the exact asymmetry that
   broke "select a mix of tracks and berths, drag one, move them all together." Fixed by mirroring
   `handlePositionedDragEnd`'s existing `idsToMove` check. Relies on `moveElements`'s existing test
   coverage (`commands.test.ts`, already proves a mixed berth+trackPath move round-trips through
   undo correctly) rather than a new test, since the fix itself is a one-line mirror of an
   already-proven pattern and the two drag-end handlers are internal closures, not exported for
   direct unit testing.
2. **Label text now defaults to centered.** `LabelElementSchema.align` defaulted to `"left"` with
   **no editor control to change it at all** — both renderers already correctly center multi-line
   text (SVG `textAnchor` per `<tspan>`; Konva `align` + a fixed layout width in
   `EditorCanvas.tsx`'s `anchoredText`), so this was a default/missing-control gap, not a rendering
   bug. Changed the schema default to `"center"` and added an "Align" dropdown to the label's
   Properties panel block (`apps/web/src/editor/PropertyPanel.tsx`) so left/right can still be
   chosen per label.

Files: `apps/web/src/editor/EditorCanvas.tsx`, `packages/map-schema/src/document.ts`,
`apps/web/src/editor/PropertyPanel.tsx`, `docs/MAP_EDITOR_SPEC.md`.

**Not done, flagged as a possible follow-up, not requested:** no live visual feedback while
dragging — the other selected elements only visually snap to their new positions once `dragEnd`
re-renders the document, not continuously during the drag gesture; and there's still no
multi-node `Transformer`/group bounding box shown for a multi-element selection (only per-element
highlight styling). Neither blocks the actual group-move from working correctly.

## Milestone 25 — fix: JSON import silently never persisted (looked reverted on refresh) `[done — 2026-09-12]`

Owner-reported, real data-loss bug: importing a JSON file (`Toolbar.tsx`'s "Import JSON", used to
recover lost editor progress from a previous export) visually updated the canvas, but refreshing
the page reverted it back to the old draft — the import appeared to silently undo itself.

Root cause: `Toolbar.tsx`'s `importJson` and `useDraftSync.ts`'s `reloadFromServer` both dispatch
the same `setDocument` action, but for semantically opposite reasons — `reloadFromServer` loads
content the server already has (nothing new to save), while `importJson` loads a local file the
server has never seen (must be saved). `setDocument`'s reducer case
(`apps/web/src/editor/EditorState.tsx`) unconditionally set `dirty: false`, correct for the first
case and silently wrong for the second: `useDraftSync`'s autosave effect is gated on `dirty`, so
it never queued a save for the imported content at all. The import wasn't reverted by anything —
it was simply never persisted in the first place, and a refresh reloads the draft from the server,
which never received it.

Fixed by making the action's dirty state explicit (`{ type: "setDocument"; document; dirty?:
boolean }`, defaulting to `false` — the common case, and what `reloadFromServer` still relies on
implicitly) and having `importJson` pass `dirty: true`. Added two regression tests to
`useDraftSync.test.tsx`: one proving `setDocument` with `dirty: true` now correctly triggers the
debounced autosave PUT, one proving `setDocument` without it (matching `reloadFromServer`'s actual
call site) still does not — protecting both directions from regressing.

Files: `apps/web/src/editor/EditorState.tsx`, `apps/web/src/editor/Toolbar.tsx`,
`apps/web/src/editor/useDraftSync.test.tsx` (+2 tests).

## Milestone 26 — `minio/minio` Docker Hub image discontinued; switched to `quay.io/minio/minio` `[done — 2026-09-11]`

While shipping Milestone 25, CI's "Start MinIO (archive) for connectivity checks" step started
failing with `pull access denied for minio/minio, repository does not exist or may require
'docker login': denied`. Confirmed this is not transient rate limiting (5 identical failures 10s
apart; a specific pre-October-2025 pinned tag failed identically) but a real, permanent change:
MinIO discontinued free `minio/minio` Docker Hub image distribution in October 2025 — the whole
repository, every tag, now 401s pull attempts, confirmed live against the production host's own
Docker daemon (not just GitHub's runners).

This also affects production, not just CI: `deploy/docker-compose.portainer.yml` and
`deploy/docker-compose.yml`'s `archive` (MinIO) service both defaulted to `minio/minio:latest`.
The box's already-running `archive` container is unaffected (its image is already pulled and
cached), but any future fresh pull — a redeploy after the image is ever removed, a host
migration, `docker system prune -a` — would now fail outright with no working image to fall back
to. Confirmed `quay.io/minio/minio:latest` — MinIO's own still-working mirror, same image — pulls
successfully; switched the default in both compose files and CI to it.

Files: `.github/workflows/ci.yml`, `deploy/docker-compose.portainer.yml`,
`deploy/docker-compose.yml`.

## Milestone 27 — fix: live-map "Data may be stale" banner could freeze indefinitely `[done — 2026-09-12]`

Owner-reported: the live map kept showing "Data may be stale" even while berths were visibly
stepping normally. Confirmed via production DB queries (`td_heartbeat`/`td_berth_event` for
Lancaster's bound TD areas, PX and CL) that the underlying feed was fresh (activity seconds old)
at the exact moment the banner was checked — the warning did not reflect current feed health.

Root cause: `GET /api/v1/maps/:slug/live` (`apps/api/src/routes/liveMap.ts`) computes `quality`
exactly once, when a socket connects, and sends it in the `snapshot` message. Nothing afterwards
ever recomputes or re-sends it — `quality.updated` is a real message type in the wire protocol
(`packages/protocol/src/liveWsMessages.ts`) and the web client (`useLiveMapSocket.ts`) already
handles it correctly, but no server code path ever produced one; the live projector
(`apps/worker/src/td/liveProjector.ts`) only ever publishes `berth.updated`/`berth.cleared`
deltas. `useMapData.ts` compounds this: its REST `/state` poll fallback (which _does_ refresh
quality every 5s) is paused for as long as the WebSocket reports `connectionStatus === "live"` —
so once a socket is up, quality is frozen at whatever it read at connect time for the entire life
of that connection, in both directions (a transient gap at connect time never clears once the
feed recovers; a gap that opens later while already connected never gets reported at all).

Fixed by adding a periodic re-check to the live WS route (piggybacking on the existing
version-check timer's cadence rather than adding a second polling config knob): it recomputes
quality via the same `liveDataStatus`/`feedGapWarnings` helpers `computeLiveState` already uses,
and sends a `quality.updated` message whenever the reading changes. Added a regression test
(`liveMap.test.ts`) proving a socket that connects healthy is later told when the feed goes
stale.

Files: `apps/api/src/routes/liveMap.ts`, `apps/api/src/routes/liveMap.test.ts` (+1 test).

## Milestone 28 — temporarily disable the berth-click run popup `[done — owner confirmed 2026-09-19]`

Owner request: turn off the public map's "click a populated berth to open its run popup"
behaviour (docs/PROJECT_SPEC.md §5) while it's being reimplemented. Deliberately not removed —
`MapRenderer.tsx` gates the click handler and cursor behind a single `clickEnabled = false`
constant right next to the existing `isOccupied` check; flipping it back to `true` restores the
exact previous behaviour with no other changes needed. The two `MapRenderer.test.tsx` tests that
exercise the popup are `.skip`'d (not deleted) with a comment pointing back here — un-skip them
in the same change that re-enables `clickEnabled`.

Files: `apps/web/src/map/MapRenderer.tsx`, `apps/web/src/map/MapRenderer.test.tsx` (2 tests
skipped, not removed).

## Milestone 29 — admin login; editor always enabled, gated by auth instead of `EDITOR_ENABLED` `[done — 2026-09-13]`

Owner request: a non-obvious login (hidden behind `/rlm-login`, not linked from anywhere) that
gates the editor and any admin controls; a logged-out visitor sees a plain public app with no
editor/admin affordances at all; `EDITOR_ENABLED` removed from the codebase entirely — the editor
is always _present_, just always behind auth.

**Direction changed before implementation.** The drafted plan below (kept for the record) proposed
a single `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH` env-var credential — cheapest given "single-owner
self-hosted app." Asked to confirm before building (auth is a real architecture decision, and
Tailscale-only/OIDC were also on the table per `docs/ARCHITECTURE.md` §12's original suggestion),
the owner explicitly rejected **both** the env-var credential and Tailscale-only, wanting instead
"a system that enables me to create multiple users in future with multiple levels. Eg
Admin/Editor etc." What's below is what was actually built — a real `app_user` table, not the
drafted single credential.

**Delivered:**

- Migration `0029_app_user.sql`: `app_user` (username unique/case-normalized, bcrypt
  `password_hash`, `role check (role in ('admin','editor'))`, `is_active`, timestamps). No seed
  row — see the bootstrap note below.
- `packages/database/src/users.ts` (+ unit + integration tests): shared CRUD/hashing used by both
  `apps/api` (login) and `apps/worker` (the bootstrap CLI) — `createUser`/`updateUserRole`/
  `updateUserPassword`/`setUserActive`/`deleteUser`/`listUsers`/`findUserByUsername`, plus a
  **last-active-admin guard** (`LastAdminGuardError`) refusing to demote/deactivate/delete the
  only remaining admin — a real lockout risk in a self-hosted app with no "contact support" path.
  `verifyPassword` compares against a dummy hash for a nonexistent username so a login attempt
  doesn't time out differently and leak which usernames exist.
- Sessions live only in Redis (`apps/api/src/auth/session.ts`) — an opaque random token as the
  `rlm_session` HttpOnly/SameSite=Lax cookie (`Secure` unless `APP_ENV=development`, via
  `@fastify/cookie`), sliding TTL (`SESSION_TTL_SECONDS`, default 12h). Nothing to forge — the
  token is just a lookup key, `app_user` in Postgres stays the durable identity/role record
  (CLAUDE.md: Redis never a source of truth).
- `apps/api/src/auth/loginRateLimit.ts`: fixed-window limiter on `POST /api/v1/auth/login`, scoped
  independently by client IP and by normalized username (`LOGIN_RATE_LIMIT_MAX_ATTEMPTS`/
  `_WINDOW_SECONDS`) — `server.ts` now sets Fastify's `trustProxy: true` so this (and the cookie
  itself) sees the real client through the reverse proxy, not the proxy's own address.
- `apps/api/src/auth/requireRole.ts`: a `requireRole(minRole, deps)` preHandler factory. Applied
  via `app.addHook` inside an encapsulated `app.register(async (scope) => {...})` block in
  `server.ts` — one hook per Fastify encapsulation scope, so `/api/v1/editor/*` requires `editor`
  and the new `/api/v1/admin/*` requires `admin`, with no per-route wiring inside
  `registerEditorRoutes`/`registerAdminUserRoutes` themselves.
- `apps/api/src/routes/auth.ts` (`/api/v1/auth/login|logout|me`) and
  `apps/api/src/routes/admin/users.ts` (`/api/v1/admin/users` CRUD) — see `docs/API_CONTRACT.md`
  §4a for the full shape.
- **Bootstrap**: since there's no env-var credential and no user table row to seed from, the very
  first admin can't come from the (now auth-gated) API at all. `apps/worker/src/commands/
manageUsers.ts` — `manage-users create|list|set-role|set-password|set-active|delete` — is a new
  one-shot CLI command (`docs/DEPLOYMENT.md` step 3a), run once by hand against the deployed
  worker container, matching this repo's existing pattern of operational CLI commands
  (`publish-map`, `prune-partitions`) rather than a magic seed row or plaintext credential in Git.
  Every account after the first goes through the admin-only "Users" page instead.
- Frontend: `useRoute.ts` gained `/rlm-login` and `/admin/users`; `apps/web/src/auth/useSession.ts`
  (`GET /api/v1/auth/me`, a 401 is the normal logged-out case, not an error),
  `LoginPage.tsx` (the non-obvious login form), `AdminUsersPage.tsx` (the admin-only user-CRUD
  page). `App.tsx` only shows the Editor/Users nav links when the session role allows them, and
  redirects an unauthenticated/under-privileged `/editor` or `/admin/users` visit to `/rlm-login`
  (a `useEffect`, not a render-time side effect — redirecting during render would violate React's
  "render must be pure" rule and risk a re-render loop).
- Removed `EDITOR_ENABLED` everywhere: `apps/api/src/config.ts`, `server.ts`,
  `deploy/docker-compose*.yml`, `deploy/.env.example`, and the frontend's stale
  404-as-"not enabled" message in `EditorApp.tsx`/`apiJson.ts` (now a 401/403-aware "session
  expired" message, since `App.tsx`'s redirect means a logged-out visitor never reaches
  `EditorApp` at all in normal use).

Tests: unit tests for `users.ts` (hash/verify round-trip, role ranking), `session.ts`/
`loginRateLimit.ts`/`requireRole.ts` (FakeRedis, matching this repo's existing no-real-Redis-in-
sandbox pattern from `redisDeltaSource.test.ts`), and the web-side `useSession`/`LoginPage`/`App`
nav-gating. Integration tests (real Postgres + Redis, not run in this sandbox — same standing
limitation as every other integration suite here — but written to run in CI):
`packages/database/src/users.integration.test.ts` (duplicate-username rejection, the last-admin
guard against real concurrent state), `apps/api/src/server.integration.test.ts` (rewritten from
the old EDITOR_ENABLED-gating tests to log in for real through `/api/v1/auth/login` and prove the
resulting cookie passes `/api/v1/editor/*` but 403s on `/api/v1/admin/*` for an editor session),
and `apps/api/src/routes/admin/users.integration.test.ts` (full CRUD + the 409/404 edge cases).

Acceptance re-checked against what was actually built: logged-out, the app shows only the public
view with zero editor/admin affordances, and `/editor`/`/admin/users` redirect to `/rlm-login`;
logging in there grants access at the account's actual role, surviving a refresh until logout or
the session TTL; grepping the repo for `EDITOR_ENABLED` finds nothing outside this file's own
historical note above.

Known limitations / follow-up not done here: no password-reset or self-service flow (an admin
resets a password via the Users page or the CLI); no audit log of who changed what (drafts already
have an `updated_by` free-text field, unrelated to this login system); rate limiting here is
login-specific, not the app-wide rate limiting Milestone 13 still owns.

<details>
<summary>Original drafted plan (superseded — kept for the record)</summary>

Today there is no auth of any kind anywhere in the repo. The only existing gate is
`EDITOR_ENABLED` (`apps/api/src/config.ts`, `server.ts`): when false, `/api/v1/editor/*` routes
are never registered (a 404, not a 403) and the web app's `EditorApp.tsx` just displays that 404
as "editor not enabled." `docs/ARCHITECTURE.md` §12 already flags this as unfinished and actually
suggests Tailscale/OIDC for the first owner-only pass — noted here since it's a cheaper option
than what follows, in case it changes the owner's mind before this is built.

Planned approach (single-owner self-hosted app, so single admin credential, not a user table):

- `ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` (bcrypt) env vars, set via the same gitignored-secrets
  pattern already used for NR credentials — never plaintext in a compose file.
- `POST /api/v1/auth/login` (rate-limited) checks the credential and, on success, creates a
  session in Redis (already in the stack for exactly this kind of ephemeral state — CLAUDE.md's
  "never source of truth" rule is fine with losing sessions on a Redis restart, that just forces
  a re-login) keyed by a random opaque id, delivered as an HttpOnly/Secure/SameSite=Lax signed
  cookie with a sliding TTL. `POST /api/v1/auth/logout` clears it. `GET /api/v1/auth/me` lets the
  frontend check session state on load.
- A `requireAdmin` preHandler replaces the `EDITOR_ENABLED` check on every `/api/v1/editor/*`
  route (which stay registered unconditionally now) and on the new map-create route (Milestone
  30).
- Frontend: extend the existing hand-rolled `useRoute.ts` (still no router library — this stays
  consistent with its explicit "deliberately not react-router-dom" design, just parses one more
  path shape) to recognize `/rlm-login`; a `useSession` hook backed by `GET /api/v1/auth/me` gates
  whether `App.tsx` ever renders an editor link or admin controls, and a logged-out visit to
  `/editor/*` redirects to `/rlm-login` instead of showing a 404-derived message.
- Remove `EDITOR_ENABLED` everywhere: `apps/api/src/config.ts`, `server.ts`,
  `deploy/docker-compose*.yml`, `deploy/.env.example`, and the frontend's 404-as-"not enabled"
  handling in `EditorApp.tsx`/`apiJson.ts`.

Acceptance: logged-out, the app shows only the public view with zero editor/admin affordances,
and `/editor/*` (page or API) redirects/401s; logging in at `/rlm-login` grants editor access
that survives a refresh until logout or TTL; grepping the repo for `EDITOR_ENABLED` finds
nothing.

**Flag for the owner**: bcrypt + Redis-session is the smallest coherent option given today's
stack, but it's a real design decision — say now if Tailscale-only, OIDC, or something else is
preferred instead, before this gets built.

</details>

## Milestone 30 — create multiple maps; landing page (map list + search) `[done — 2026-09-13]`

Owner request: the ability to add more maps, and a new default page showing every current map in
a left-hand list with a CRS/TIPLOC/STANOX search box on the right (Milestone 31).

The DB/API layer already supports multiple maps cleanly — `map`/`map_version` are already keyed
per-map with no singleton assumptions, and `GET /api/v1/maps` already lists every current map with
its live-data status. The only real gap is **creating** one: nothing outside test fixtures ever
inserts a `map` row today; every "create a map" seen in the repo is a direct SQL insert in a test.

Planned approach:

- `POST /api/v1/editor/maps` (admin-only — Milestone 29's `requireRole("admin", ...)`, the same
  encapsulated-scope pattern `/api/v1/admin/*` already uses in `server.ts`): creates the `map` row
  (slug + name) and an initial empty `map_draft` for it.
- The web app's `/` route stops being `MapView` hardcoded to `LANCASTER_MAP_SLUG`
  (`apps/web/src/App.tsx`) and becomes the map-list + search landing page; a chosen map moves to
  `/map/:slug` and (admin-only) `/editor/:slug` — again just extending `useRoute.ts`'s parser, no
  router library added.
- Left panel renders `GET /api/v1/maps`'s existing list as clickable entries. An admin-only
  "+ New map" control (visible only when logged in) opens a small name/slug form against the new
  create route and drops the admin straight into that map's editor.
- `VITE_LANCASTER_MAP_SLUG` retires once nothing hardcodes it — Lancaster becomes just one entry
  in the list, not special-cased.

Acceptance: a logged-in admin creates a new empty map from the landing page and lands in its
editor; a logged-out visitor sees the map list (no create control) and can open any published
map; existing Lancaster links/behavior keep working unchanged.

**Status: implemented.**

- `POST /api/v1/editor/maps` (`apps/api/src/routes/editor/createMap.ts`) — admin-only, registered
  in its own `requireRole("admin", ...)`-gated Fastify scope in `server.ts` (the same
  encapsulated-scope pattern as `routes/admin/users.ts`, one level below the `editor`-role-gated
  scope the rest of `/api/v1/editor/*` shares, since this one route needs a stricter gate). Body
  `{ slug, name }`; `400 VALIDATION_ERROR` for a malformed slug (`^[a-z0-9]+(-[a-z0-9]+)*$`) or
  missing name, `409 DUPLICATE_SLUG` for an existing one. Inserts the `map` row, then calls the
  existing `getOrSeedDraft` to seed its initial blank draft in the same request — "create a map"
  is one admin action, not two.
- `apps/api/src/editor/draftStore.ts`'s `getOrSeedDraft`/`blankDocument`: a slug with a `map` row
  but no published version yet (exactly the state `createMap.ts` leaves it in) now seeds its blank
  draft named after that map, not the bare slug — the one behavior change needed so a freshly
  created map's editor doesn't show "lancaster"-style placeholder naming.
- Web: `useRoute.ts` gained `/map/:slug` and `/editor/:slug` (plus an `editorPicker` case for a
  bare `/editor`, which `App.tsx` immediately redirects to `/`); `App.tsx`'s `/` route is now the
  new `LandingPage.tsx` instead of `MapView` hardcoded to `VITE_LANCASTER_MAP_SLUG` (removed
  entirely — nothing hardcodes it anymore). `LandingPage.tsx`: fetches `GET /api/v1/maps`, renders
  each as a row linking to `/map/{slug}`; an editor-or-admin session gets a per-row "Edit" link to
  `/editor/{slug}`; an admin session additionally gets a "+ New map" form (name + auto-slugified,
  editable slug) posting to the new create route and navigating straight to the new map's editor
  on success. The top-nav's slug-less "Editor" link is gone (editing now always starts from a
  specific map, via the landing page's own per-row link); the "Live map" link is renamed "Maps"
  and now points at the landing page rather than directly at Lancaster.
- The right-hand CRS/TIPLOC/STANOX search box is deliberately not built here — nothing to search
  against yet (`GET /api/v1/places/search` is Milestone 31). Also out of scope: an unpublished
  (never-yet-published) map has no way back into its own editor except the URL an admin was
  already dropped into on creation — it won't appear in the landing list until its first publish,
  since `GET /api/v1/maps` only ever listed currently-effective versions; not a regression (nothing
  before this milestone could create an unpublished map at all), but worth an "in-progress drafts"
  affordance if that turns out to matter in practice.
- Tests: `apps/api/src/routes/editor/createMap.integration.test.ts` (create, validation, duplicate
  slug, seeded-draft naming); a new `drafts.integration.test.ts` case for the pre-existing-map-row
  seeding path; `apps/web/src/useRoute.test.ts`; `apps/web/src/LandingPage.test.tsx`; `App.test.tsx`
  updated for the removed "Editor" nav link and the renamed "Maps" link.

**Production incident, same day (2026-09-13), root-caused and fixed within the hour:** this
milestone's landing page was the first thing to ever call `GET /api/v1/maps` from a live browser
(the old `/` route went straight to `/definition`/`/state` for the hardcoded Lancaster slug, never
`/maps` itself). That endpoint's `liveDataStatus` (`apps/api/src/lib/mapVersion.ts`, shared with
`/state`/`/live`'s quality flag) ran `select max(event_at) from td_berth_event where td_area =
any($1::text[])` with no time bound — Postgres's single-equality MIN/MAX index rewrite doesn't
apply to a multi-value `= ANY(array)` predicate, so this scanned every historical row for the area
across the full nationwide retention window. A few page reloads stacked up several multi-minute
scans and exhausted the API's 10-connection Postgres pool, taking the whole site down (10s
connection-acquire timeouts on every other route too, not just `/maps`) — this had been a latent
bug since Milestone 6, just never exercised by real traffic until this milestone gave it a caller.
Restored service by restarting `railway-live-map-api-1` (drops the stuck connections; the
alternative of `pg_terminate_backend`-ing the individual queries was blocked by the auto-mode
permission classifier as a production-database action, so the owner chose the container-restart
option instead). Root-caused and fixed the same session: `liveDataStatus` now bounds its main
query to the last 24 hours (`LIVE_STATUS_LOOKBACK_MS`) — enough to cover the real "hours-stale
heartbeat" production case from 2026-08-09 with room to spare — and only falls back to a cheap
`exists(...)` check (which short-circuits at the first match regardless of table size, unlike
`max()`) to distinguish "genuinely never observed" (`unknown`) from "real history, just older than
the window" (`stale`) in the rare case nothing turns up in the bounded window. New test:
`mapVersion.integration.test.ts`'s "reports stale (not unknown) when the only history is older
than the lookback window" locks in that distinction. Standing rule reaffirmed (this is the same
class of bug Milestone 15 step 6 already fixed once for `/td/areas`): every query against a table
that grows without bound needs an explicit range or a rollup, with no exceptions for "it's just a
freshness check."

## Milestone 31 — place identifiers on labels + nationwide CRS/TIPLOC/STANOX search `[done — 2026-09-13]`

Owner request: label elements get the same CRS/TIPLOC/STANOX identifiers stations already carry
(so junctions are searchable by name too, not just stations), and the landing page's search box
finds any of them and jumps to the map that covers it.

`StationElementSchema` already has optional `crs`/`tiploc`; `LabelElementSchema` has neither
today. Nationwide location data is already ingested and indexed — `location_reference`
(CORPUS-sourced: `tiploc` unique, plus `stanox`/`crs`/`name`) needs no new ingestion for this.
There is currently no search endpoint anywhere in the API.

Planned approach:

- `packages/map-schema`: add optional `tiploc`/`stanox`/`crs` to `LabelElementSchema` (and add
  the missing `stanox` to `StationElementSchema` for consistency while touching this).
- `PropertyPanel.tsx`: expose the new fields for labels (and the added one for stations).
- Compiler (`compileMapDocument`): build a place-binding index alongside the existing
  `berthBindingIndex` — every station/label with a crs/tiploc/stanox becomes an entry in a new
  `map_place_index` table (parallel to `map_binding_index`), written at publish time.
- `GET /api/v1/places/search?q=` (public): matches against `location_reference` by name/CRS/
  TIPLOC/STANOX, left-joined against `map_place_index` across every currently-effective
  `map_version` so each result carries whichever map (if any) currently covers it.
- Search results with a covering map are clickable straight to `/map/:slug`, centered on that
  element if practical; results with no covering map show as inert ("not on any published map
  yet") — consistent with the project's existing principle that map scope never gates capture, but
  it can obviously gate what's dicoverable through a map-jump search.

Acceptance: tagging a junction label with a TIPLOC/CRS/STANOX and publishing makes it findable by
that identifier or by name from the landing page; an identifier with no covering map yet degrades
gracefully instead of erroring.

**Status: implemented.**

- `packages/map-schema/src/document.ts`: `LabelElementSchema` gains optional `crs`/`tiploc`/
  `stanox` (metadata only, not rendered — same as a station's); `StationElementSchema` gains the
  missing `stanox` (already had `crs`/`tiploc`).
- `packages/map-schema/src/compiler.ts`: `CompiledMapBundle.placeBindingIndex` — every station/
  label with at least one identifier, built alongside `berthBindingIndex`/`sBitBindingIndex` in
  `compileMapDocument`.
- Migration `0030_map_place_index.sql`: `map_place_index` (map version, element id/type, tiploc/
  stanox/crs — at least one required), parallel to `map_binding_index` but with no uniqueness
  constraint (a discovery/search index, not a routing-correctness-critical one).
  `packages/map-publish/src/mapPlaceIndex.ts`'s `insertMapPlaceIndexRows` populates it; wired into
  `publishMapVersion.ts` right after `insertMapBindingIndexRows`. No backfill command — none of the
  currently-published maps had a tagged station/label yet (see the table's own doc comment in
  `docs/DATA_MODEL.md` if that changes).
- `GET /api/v1/places/search?q=` (`apps/api/src/routes/places.ts`, public, registered alongside
  `GET /api/v1/maps`): matches `location_reference` by name/CRS/TIPLOC/STANOX, left-joined against
  `map_place_index` restricted to each map's currently-effective version (an aggregate `group by`
  - `array_agg(...) filter (...)` collapses a location matching both a current and a historical
    `map_place_index` row down to the current one). `location_reference` is CORPUS's bounded,
    nationwide-but-finite location list — not the kind of ever-growing event table the Milestone 30
    incident (and Milestone 15 step 6 before it) was about, so the `ilike` scan here needed no special
    indexing.
- Web: `PropertyPanel.tsx` gained the CRS/TIPLOC/STANOX fields for `label` and the STANOX field for
  `station`. `MapRenderer.tsx` gained `centerElementId` (+ exported `elementCenterPoint` helper):
  set once at mount, it centres the initial view on that element instead of the remembered/default
  view (silently ignored for an unknown id or a points-based `trackPath`/`platform`).
  `MapView.tsx`/`App.tsx` thread a `?center=<elementId>` query param on the `/map/:slug` route
  through to it. `LandingPage.tsx` gained a right-hand search column: debounced as-you-type
  `GET /api/v1/places/search`, a clickable result (`/map/{slug}?center={elementId}`) when a map
  covers it, an inert "not on any published map yet" row when not.
- Tests: `document.test.ts`/`compiler.test.ts` (new schema fields, `placeBindingIndex` build/skip);
  `publishMap.integration.test.ts` new `map_place_index` describe block;
  `apps/api/src/routes/places.test.ts` (unit) + `places.integration.test.ts` (real join, including
  the superseded-version exclusion); `MapRenderer.test.tsx` (centering + `elementCenterPoint`);
  `PropertyPanel.test.tsx` (new label fields); `LandingPage.test.tsx` (search debounce, covering/
  inert results, click-through, clearing the query). `pnpm run build:libs`, `pnpm -r typecheck`,
  `pnpm run lint`, `pnpm run format:check` and the full unit suite all green.
- Known limitations: search matches via `ilike '%q%'` on all four columns (no ranking/relevance —
  first match order is `lr.name`); no pagination beyond the flat `limit` cap; centering only
  applies to the live map view, not historical playback.

## Milestone 32 — boundary elements link to the adjacent map `[done — 2026-09-13]`

Owner request: clicking a boundary label on the public map jumps to the corresponding boundary on
the adjacent map.

The schema already had this half-built: `BoundaryElementSchema` carried optional
`adjacentMapSlug`/`direction` fields with no consumer anywhere yet.

**Plan revised mid-milestone (owner, 2026-09-13):** the original approach below assumed matching
boundary **names** on both sides as the correspondence convention. The owner flagged that this
doesn't hold — real signalling boundaries are typically named from each side's own perspective,
so the same physical crossing can be one map's "Carlisle PSB" and the other map's "Preston PSB".
Implemented instead with an explicit author-entered `adjacentBoundaryName` field (see below) —
same shape as the already-manual `adjacentMapSlug` (a slug/name the author types in, not picked
from a live cross-map list).

~~Planned approach: treat matching boundary names on both sides as the correspondence convention
(the same real signalling-area boundary, named identically by the author on each map) rather than
adding a new linked-boundary-id field.~~ — superseded, see above.

Acceptance: two maps sharing a boundary, each with a boundary element pointing `adjacentMapSlug`
at the other and `adjacentBoundaryName` naming the corresponding boundary as authored _there_, let
a viewer click through and land near the right spot even when the two sides use different local
names; a boundary with no `adjacentMapSlug` (or no matching name on the target) behaves exactly as
today — an inert marker, never a hard error.

**Status: implemented.**

- `packages/map-schema/src/document.ts`: `BoundaryElementSchema` gains optional
  `adjacentBoundaryName` — the name this same boundary is called on the adjacent map, not assumed
  to equal this element's own `name`.
- `packages/map-schema/src/compiler.ts`: `CompiledMapBundle.continuationLinks` (previously built
  but unconsumed) now also carries `name` and a resolved `adjacentBoundaryName` (falling back to
  the element's own `name` when the author left it unset — the "two sides happen to coincide"
  case).
- Web: `MapRenderer.tsx` makes a boundary element with `adjacentMapSlug` clickable (pointer
  cursor), navigating via `useRoute.ts`'s `navigate()` to
  `/map/<adjacentMapSlug>?boundary=<adjacentBoundaryName ?? name>`. `App.tsx` reads the new
  `?boundary=` query param alongside Milestone 31's `?center=` and threads it to `MapView.tsx` as
  `centerBoundaryName`; `MapView.tsx` resolves it, once the target map's bundle has loaded, to that
  map's own boundary element of the matching `name` and passes the resolved id through as the
  existing `centerElementId` prop — no match (stale/renamed boundary) just falls back to the
  remembered/default view. `PropertyPanel.tsx` gained the "Adjacent boundary name" field for
  `boundary` elements, with a hint explaining the naming-differs-per-side reality using the
  Carlisle/Preston PSB example.
- Tests: `document.test.ts` (new field parses); `compiler.test.ts` (`continuationLinks` carries
  `name`/resolved `adjacentBoundaryName`, explicit value overrides the element's own name);
  `MapRenderer.test.tsx` (click navigates using `adjacentBoundaryName` over `name`, falls back to
  `name` when unset, inert with no `adjacentMapSlug`); `MapView.test.tsx` (resolves `?boundary=` to
  the matching local element and centres, falls back to the default view with no match, no error);
  `PropertyPanel.test.tsx` (new field commits independently of the element's own Name).
  `pnpm run build:libs`, `pnpm -r typecheck`, `pnpm run lint`, `pnpm run format:check` and the full
  unit suite all green (pre-existing unrelated gap: `packages/protocol` has no `vitest.config.ts`,
  so `pnpm -r test` fails to start that one package — untouched by this milestone).
- Known limitations: correspondence is entirely author-maintained (no cross-map validation that an
  `adjacentBoundaryName` actually exists on the target map, or that the link is reciprocated) —
  authoring errors degrade to "no centering", never a crash, per the acceptance criteria; matching
  is an exact string comparison on `name` (no normalization/case-insensitivity).

**Follow-up, same day (owner request): the dedicated `boundary` element type folded into
`label`.** The owner didn't want a separate element type for this at all — a boundary link is now
just a `label` with `adjacentMapSlug`/`adjacentBoundaryName`/`direction` set, rendered in the
normal label style (no circle marker), matching the owner's stated preference. `LabelElementSchema`
gained the three fields; `compileMapDocument`'s `continuationLinks` and `MapRenderer`/`MapView`'s
click-through and `?boundary=` resolution now recognize either a `label` or the legacy `boundary`
type; `validateDraftInContext`'s unknown-adjacent-map check does too. The `boundary` type/tool is
otherwise unchanged from above — kept parseable/renderable (schema, renderer, editor Properties
panel) but no longer offered in `ToolPalette.tsx`/`EditorCanvas.tsx`'s tool list, since real
production data already existed: the live `lancaster` (v64) and `mroc-blackpool` (v3) published
versions, and both maps' current drafts, had genuine `boundary` elements at the time of this
change — CLAUDE.md rule 11 (published versions immutable) means those are left exactly as they
were rather than rewritten; the two drafts (still editable, unpublished) were left as-is too
rather than hand-edited outside the normal editor flow — next time the owner touches that area in
the editor, recreating it as a label takes seconds now that the fields live there. Tests: new
cases in `document.test.ts`, `compiler.test.ts` (label-sourced link, explicit exclusion of an
unlinked label/boundary from `continuationLinks`), `MapRenderer.test.tsx` (label click-through
keeps the plain-text style, no `<circle>`), `MapView.test.tsx` (`?boundary=` resolves to a label
too), `PropertyPanel.test.tsx`, and `validate.integration.test.ts` (label-carried
`adjacentMapSlug` blocks on an unknown target the same way the legacy type does) — the last run
against a disposable Postgres (`packages/database`'s migrate CLI against a throwaway container),
not production. `pnpm run build:libs`, `pnpm -r typecheck`, `pnpm run lint`, and the full unit
suite green.

**Second same-day follow-up (owner request): rename a map's name/slug, and delete a map.** Admin
UI/API alongside Milestone 30's create-map flow, not previously possible without hand-editing the
database. `apps/api/src/routes/editor/manageMap.ts` (registered in `server.ts`'s existing
admin-gated `adminMapScope`, alongside `createMap.ts`): `PATCH /api/v1/editor/maps/{slug}` (body
`{name?, slug?}`, at least one required) renames, keeping `map_draft`'s own denormalized `slug`
column and `canonical_document.map.id`/`map.name` in sync in the same transaction so the editor's
Properties panel and the next publish see the new values too — `409 DUPLICATE_SLUG` on a
collision, original left untouched; `DELETE /api/v1/editor/maps/{slug}` permanently deletes the
map, every `map_version`, the `map_draft` and its revision history, and the derived
`map_binding_index`/`map_place_index`/`map_state_snapshot` rows, as one manual-cascade transaction
(none of these FKs are `ON DELETE CASCADE` — deletion is meant to be rare and deliberate) — never
touches nationwide TD/TRUST/etc. event tables (CLAUDE.md rule 17: a map's absence must not affect
capture/history for its area). `LandingPage.tsx` gained per-row Rename (inline name/slug form,
admin-only like the existing "+ New map" control) and Delete (two-click confirm — first click arms
a "Confirm delete"/"Cancel" pair, second actually calls the API) controls. Known limitation:
renaming a slug changes the map's public URL and is not propagated to anything that already linked
the old one (a bookmark, or another map's `label.adjacentMapSlug` cross-reference) — same
"falls back to no centering, never errors" tolerance Milestone 32 already relies on for a stale
link, not a new gap. Tests: `apps/api/src/routes/editor/manageMap.integration.test.ts` (rename
name-only/slug/both, duplicate-slug rejection, 404s, delete cascades draft+revisions, explicitly
asserts `td_berth_event` row count is unchanged by a delete) and two new cases in
`server.integration.test.ts` (role gating for both routes, end to end through a real login) — all
run against the same disposable Postgres (this time with a matching disposable Redis alongside it,
since `server.integration.test.ts` exercises real sessions) rather than production;
`LandingPage.test.tsx` (admin-only visibility, rename happy path + failure + cancel, delete confirm
flow + cancel). `pnpm -r typecheck`, `pnpm run lint`, `pnpm run format:check` and the full unit
suite green.

## Milestone 33 — author the Blackpool Line map (S-Class pilot) `[done — owner confirmed 2026-09-19]`

Completed by the owner: `mroc-blackpool` (M9, with 3 PX berths), 70 signal elements awaiting
Milestone 36's bindings. Original planning note kept below for history.

**The owner will build this map themselves in the editor, at their own pace, and report back when
it's done — not a Claude task.** Confirmed 2026-09-13: this stays parked until the owner picks it
up; do not attempt it proactively. Listed here purely for planning continuity, not as work for
Claude to pick up: not a code milestone at all, and no editor/platform work is required to unblock
it once Milestones 29-32 land. One real dependency worth knowing about before or during authoring:
**S-Class bit decoding is still unimplemented** (`td_s_bit_transition` exists but is unpopulated;
no verified decode spec/fixture yet — this predates this plan, see Milestone 36). Authoring the
map itself doesn't need to wait, but its signals will render blank (same as Lancaster/Preston
today, CLAUDE.md rule 8) until that decode work happens.

---

With 29-33 done, here is the rest of the existing backlog folded into a numbered plan, starting
with the resolver rebuild as requested. These are all pre-existing deferred items (see each for
its original source), just sequenced here rather than left as a flat list.

## Milestone 34 — rebuild the berth-run resolver `[done — 2026-09-13]`

Reinstates CLAUDE.md rules 5 and 7, held in abeyance since ADR 0002 (2026-09-01) removed the
original resolver. Rebuilt on top of garner's mirrored data instead of RLM's own.

**Design, per docs/adr/0006 (spikes run against the real operator infrastructure before writing
any code):**

- Spike 1 — queried the operator's live openrail-eps MariaDB directly (read-only `rlm_bridge`
  grant): garner's `td_states` (47,310 rows, `k`/`v` keyed by `<td_area><berth>` → current
  headcode) is its own live TD state cache, **not** a trust_id/schedule link, and no `livesig`
  table exists at all — it's a web UI feature name, not stored data. No shortcut available; the
  correlation has to be built. This also corrects the plan text as it stood before this entry:
  garner's real `trust_activation` schema is only `(created, trust_id, cif_schedule_id,
deduced)` — no `deduced_headcode`/`deduced_headcode_status` columns exist anywhere in garner's
  database; that detail was aspirational, not real.
- Spike 2 — RLM's own `smart_berth_step` mirror has real coverage: 33,052 rows nationwide across
  194 TD areas; `PX` (Preston, containing Lancaster) specifically has 423 rows, 100% carrying a
  `stanox`. One real wrinkle, not a data problem to paper over: a berth code can carry more than
  one STANOX (`PX` berth `0491` has 3) — treated as a set throughout, not forced to one.
- Candidate generation: `cif_schedules` matching the berth's TD headcode and running today,
  **position-scoped** to a TIPLOC set derived from the berth's SMART STANOX(es) via
  `location_reference` — closing the false-positive risk of a same-headcode schedule running
  somewhere else in the country entirely (rule 5's whole point). Only when a berth has no SMART
  coverage at all does the search fall back to the unscoped nationwide headcode match — never
  because the scoped search itself came back empty, which is real information, not a reason to
  widen.
- `matchBasis` tiers (ADR 0004 D7's already-decided ranking, `station_berth_timetable` excluded —
  that's Milestone 35's no-headcode-at-all case): `trust_activation` (exactly one position-scoped
  candidate activated today) > `stp_precedence` (else, pure STP precedence among them) >
  `headcode_only` (the unscoped fallback, explicitly the weakest tier regardless of which internal
  rule picked the winner within it — position-scoping, not the tie-break method, is what the
  ranking is about).
- Stays **query-time only** — no persisted resolution table, no daemon, no WS delta. Deliberate:
  ADR 0002 removed the original resolver specifically for the operational fragility that shape
  caused (see `[[resolver_version_bump_incident]]`); reintroducing it here would just rebuild the
  same failure surface.

**Status: implemented.**

- `packages/domain/src/schedule/resolveRunMatch.ts` (+ `resolveStpPrecedence.ts`'s newly exported
  `candidatesRunningOn`): the pure tiered decision function, unit-tested independent of the DB —
  `trust_activation` tier checked first among candidates actually running today, ties at either
  tier reported `ambiguous` with the full tied set, never a guess.
- `apps/api/src/routes/currentRun.ts`: rewritten to position-scope via `smart_berth_step` →
  `location_reference` before querying `cif_schedules`, call `resolveRunMatch`, and relabel an
  unscoped-fallback result as `headcode_only` regardless of its internal basis. Response gains
  `matchStatus`/`matchBasis`/`positionScoped`; `effective.selectedBy` is removed (superseded by
  the top-level `matchBasis`, single source of truth); `note` is now tier-specific plain language.
- `apps/web/src/map/RunPopup.tsx` updated to the new response shape. `apps/web/src/map/
MapRenderer.tsx`'s berth click was re-enabled (`clickEnabled = true`) — it had been temporarily
  disabled 2026-09-12 specifically pending this rebuild, per that session's own comment.
- CLAUDE.md rules 5 and 7 updated from "held in abeyance" to reinstated; rule 6 updated to note
  the activation link is now the actual top-priority tier, not just a same-day tie-break.
- Tests: `resolveRunMatch.test.ts` (7 cases, pure); `currentRun.integration.test.ts` gained a
  `describe("position scoping")` block (excludes an elsewhere-calling same-headcode schedule,
  ambiguous when two position-scoped candidates tie, activation beats STP among scoped
  candidates, stays unmatched rather than falling back when the scoped search is empty) alongside
  updates to the five pre-existing cases (`selectedBy` → top-level `matchBasis`, note text); `Run
Popup.test.tsx` and `MapRenderer.test.tsx` updated to the new shape, and the two `it.skip` popup
  tests un-skipped now that the click is re-enabled — all pass. Integration tests run against a
  disposable Postgres (`packages/database`'s migrate CLI against a throwaway container), not
  production. `pnpm run build:libs`, `pnpm -r typecheck`, and the full unit suite green.
- Known limitations: `station_berth_timetable` (no headcode at all) is explicitly out of scope,
  Milestone 35's job; TIPLOC/STANOX matching is exact (no distance-radius fuzziness); a berth
  with SMART coverage that happens to be wrong or stale degrades to `unmatched` rather than a
  guess, by design, but could show as "no match" for a real train more often than the old
  unscoped behavior did in that edge case — an accepted trade for closing the false-positive risk.

## Milestone 35 — station-berth schedule deduction `[done — 2026-09-13]`

ADR 0004 D7's already-designed extension to Milestone 34. Both prerequisite spikes were actually
run as part of Milestone 34's own ADR 0006 (not repeated here): garner's `td_states` is not a
usable shortcut, and SMART berth→STANOX coverage is real and usable.

**Scope corrected by the owner before implementation** (docs/adr/0006's addendum has the full
back-and-forth): the plan text above described "no TRUST activation at all" as the trigger, but
the real target scenario is different — a signaller interposes a TD headcode whenever the train
is **physically present**, routinely hours before its scheduled departure (stabled overnight, or
early for its next working). A headcode is always present; what's missing is TRUST evidence and
a clean STP-precedence winner. Two candidate designs were proposed and rejected in conversation
before landing on the final one — see the ADR addendum for why a fixed ±5 minute window and a
"drop already-passed times" filter both fail on real scenarios (early interpose, and running
late, respectively).

**Final design**: when a berth is position-scoped (a known station, Milestone 34's SMART-derived
STANOX/TIPLOC) and STP precedence alone leaves more than one tied candidate, pick whichever
candidate's scheduled calling time at that station is closest to _now_ — not to when the berth
was entered, and with no "already passed" exclusion, since there's no real-time evidence at this
tier to distinguish "finished" from "running late". Exactly one closest → matched
(`station_berth_timetable`, the enum's already-agreed rank between `stp_precedence` and
`headcode_only`); more than one exactly tied → stays ambiguous, never a guess.

**Status: implemented.**

- `packages/domain/src/schedule/stationBerthTiming.ts` (new, pure): `parseCifTimeToMinutes` (CIF
  `HHMM`/`HHMMH`), `circularDiffMinutes` (wraps at the day boundary), `closestToNow` (returns
  every exactly-tied candidate, never guesses).
- `packages/domain/src/schedule/resolveRunMatch.ts`: gained an optional `timing` parameter —
  when given, tries `station_berth_timetable` before falling back to the plain `stp_precedence`
  ambiguous result; when omitted, behaves exactly as Milestone 34 left it.
- `apps/api/src/routes/currentRun.ts`: fetches each position-scoped candidate's best
  (closest-to-now) calling time at the scoped TIPLOCs — only when position-scoped, since an
  unscoped (`headcode_only`) search has no station to time-match against. New
  `londonMinutesSinceMidnight` helper for "now" in the same units. No migration — reuses the
  `cif_schedule_locations` columns Milestone 34 already joins.
- Tests: `stationBerthTiming.test.ts` (12 cases), new `resolveRunMatch.test.ts` cases covering
  early-interpose, running-late, exact-tie and "STP already resolved, timing never consulted";
  `currentRun.integration.test.ts` gained a `describe("station_berth_timetable tier")` block
  (seeds schedule times relative to real current London wall-clock time, since the route's `now`
  isn't injectable) plus a fix to an existing Milestone 34 test whose fixed `"0900"`/`"1000"`
  seed times were no longer neutral once this tier could resolve them — run against a disposable
  Postgres, not production. `pnpm -r typecheck`, `pnpm run lint`, `pnpm run format:check` and the
  full unit suite green.
- Known limitation, carried over from Milestone 34: the author-supplied `berth.crs`/`stationId`
  schema hooks (ADR 0004 D6/D7) are still not consulted as an additional station-identity source
  — only SMART-derived STANOX. A berth with no SMART coverage gets no `station_berth_timetable`
  tier regardless of map-authored CRS metadata.

**Third same-day follow-up (owner request): role-gated popup content, and real unit/stock
allocation.** Full detail in docs/adr/0006's own addendum; summary here.

- An anonymous visitor (no session cookie — the public map itself still needs no login) gets no
  popup content at all unless the berth is a **solid match** (`matched`, and not the weakest
  `headcode_only` tier) — anything else `404 NO_PUBLIC_DETAIL`s and the popup closes itself
  quietly. On a solid match, anonymous visitors get a reduced, departure-board-style view
  (headcode, origin/destination, calling points, operator) — never TRUST IDs, CIF schedule IDs,
  the `deduced` flag, or raw movement/variation data. A logged-in session (any role) always gets
  the full response exactly as Milestones 34/35 built it. Enforced server-side — the response
  shape differs per request, not just what the UI renders.
- Every visitor, regardless of login, now sees real unit/stock allocation for the matched train —
  mirrored from garner's `train_allocation` table (migration 0031, verified against the real
  operator instance: 383,882 rows at the time of writing) via a new
  `runGarnerTrainAllocationSync` bridge sync (`apps/worker/src/garner/bridge.ts`), same cadence
  as TRUST. Unlike the epoch-INT-keyed tables Milestone 34 already mirrors, this table's
  timestamps are real garner DATE/DATETIME columns — mapped straight across, watermarked by
  garner's own auto-increment `id`.
- Tests: a new `describe("public/anonymous access")` block in `currentRun.integration.test.ts`
  (404s for ambiguous/unmatched/headcode_only when anonymous, the reduced shape on a solid match,
  unit allocation identical for anonymous and authenticated requests) using an in-memory
  `FakeRedis` stand-in rather than a real Redis server; every pre-existing test in that file now
  authenticates via a small `authHeaders()` helper, since they exercise the full response and
  would otherwise silently start hitting the new anonymous path. `RunPopup.tsx` split into
  `FullEffectiveDetail`/`PublicEffectiveDetail` components so TypeScript's discriminated-union
  narrowing actually applies. All run against a disposable Postgres, not production.
  `pnpm -r typecheck`, `pnpm run lint`, `pnpm run format:check` and the full unit suite green.

**Fourth same-day follow-up (bugs found in production the same day this shipped):**

1. **Migration 0031 never ran on production.** Watchtower auto-deploys new images but nothing
   runs pending migrations, so `train_allocation` didn't exist yet — every `current-run` request
   500'd (`relation "train_allocation" does not exist`). Fixed by running `migrate` by hand
   (production infra has no auto-migrate step; this is a known gap, not fixed here).
2. **Overnight-crossing schedules had their calling points sequenced tail-first.** `syncCif
ScheduleLocations` (`apps/worker/src/garner/bridge.ts`) ordered by `sort_time` alone — a
   within-day clock value that resets after midnight — so a schedule that runs past midnight got
   its post-midnight calling points sequenced _before_ its pre-midnight ones (reproduced against
   real headcode 9M63/UID W33240: Northampton/Courteenhall/Euston, all next-day, were sequencing
   ahead of Glasgow/Motherwell/Carlisle). Fixed by extracting a pure `sequenceScheduleLocations`
   helper that sorts by `next_day` then `sort_time` (fixture-tested, `bridge.test.ts`), and
   one-time repairing the 36,092 already-mirrored schedules affected (1,118,183 rows) on
   production with a two-phase `seq_no` re-sequencing `UPDATE` — no other column touched, fully
   re-derivable from garner if ever needed.
3. **`unitAllocation: null` crashed the whole page (blank, needs a refresh).** `currentRun.ts`
   sent `null` (not `[]`, contradicting its own documented contract) whenever there was no
   `effectiveRow` — i.e. every `ambiguous`/`unmatched` berth. `RunPopup.tsx`'s
   `UnitAllocationSection` did `unitAllocation.length` unconditionally with no error boundary
   anywhere above it, so any unresolved berth blanked the page (reproduced against PX 0127/0133,
   both `unmatched` that day). Fixed server-side (`: []`, matching the documented contract) and
   defensively client-side (`!unitAllocation || unitAllocation.length === 0`). Regression tests
   added to both `currentRun.integration.test.ts` (unmatched and ambiguous cases assert `[]`) and
   `RunPopup.test.tsx` (a `unitAllocation: null` response renders without crashing).
4. **Owner request: the map's toolbar (map name, live status, playback button, "show empty
   berths") no longer floats over the map.** It was `position: absolute` over the top-left corner
   of `.map-page`, which — since the historical-playback panel (`.playback`) renders as the same
   flow-parent's first child — visually overlaid and blocked the playback panel's own "Historical
   playback"/"Return to live" row. Now a static, full-width bar (`.map-page__toolbar`, no more
   `position: absolute`) sitting in normal flow directly below the app header, which fixes both
   the requested layout change and the playback-overlay bug as one change. Verified visually
   (screenshot) against a standalone static harness reproducing the real markup/CSS, since no
   local backend was available to run the actual app.
5. **Owner request: no `note` field for anonymous/public popups.** Its "matched by TRUST
   activation/STP precedence/verify this" language is resolver-internal and only meaningful
   alongside `matchBasis`, which anonymous visitors never receive — kept on the full (logged-in)
   response only. `docs/API_CONTRACT.md`'s reduced-shape description updated to match.
6. **A unit reallocated by control during the day showed as multiple simultaneous units, not a
   replacement** (found 2026-09-15 against a real report: 1P09/W34091 showed 6 different 390s in
   one formation position). `train_allocation` is garner's append-only log of allocation _reports_
   — a reallocated position gets a brand-new row (new `id`/`message_id`), not an update to the old
   one; migration 0031's own comment assumed the latter ("one row per unit per formation").
   `queryUnitAllocation` selected every historical row for the train, not just the current one per
   position. Fixed with `distinct on (position) ... order by position, coalesce(reported,
synced_at) desc, id desc` — picks the most recently reported row per position; confirmed against
   the real production data behind the report (6 rows, one position, correctly reduces to the
   last-reported unit). `docs/API_CONTRACT.md`'s `unitAllocation` description clarified to say "the
   current unit," not just "one entry per unit."

Tests: `bridge.test.ts` (+3 `sequenceScheduleLocations` cases), `currentRun.integration.test.ts`
(+3 assertions: unmatched/ambiguous `unitAllocation`, anonymous `note` absence; +1 case for the
reallocation fix — three reports for one position, one for another, asserts only the
latest-per-position survives). Full worker/api/web unit suites green; `currentRun.integration.
test.ts` run against a disposable Postgres (SSH-tunnelled to a throwaway container, per
`docs/DEPLOYMENT.md`'s testing recipe) — all 20 cases pass. `pnpm -r typecheck` green for
`@railway/api` and `@railway/web`.
`pnpm -r typecheck` green for `@railway/api` and `@railway/web`.

## Milestone 36 — S-Class bit decoding and signal on/off display `[in progress — 36a/36b deployed, 36c implemented 2026-09-19]`

Long-standing gap: `td_s_bit_transition` is unpopulated, no verified decode spec/fixture exists.
Needed for any map (Blackpool, Milestone 33, included) to show real signal on/off state rather
than permanently blank symbols — CLAUDE.md rules 9/10 (blank/on/off only, never inferred) still
apply once this lands. Unblocked by Milestone 33 (Blackpool map authored — 70 signal elements,
all currently unlabelled and unbound, M9 + 3 PX berth bindings).

### Verified facts (production data, 2026-09-19 — M8, M9, R1-R4)

- **Wire format.** `SF_MSG` = 1 byte (2 hex chars) at hex `address`. `SG_MSG` = 4 bytes (8 hex
  chars) starting at `address`, first byte first — confirmed: M9 `SG 04 = FEFFBFCF` → bytes
  04=`FE`, 05=`FF`, 06=`BF`, 07=`CF`, each a value SF independently reports for that address.
  `SH_MSG` = the **final 4-byte chunk of a refresh and carries real data** (M9 `SH 14` covers
  0x14-0x17; SF has been seen at 0x15 and 0x17) — not just a terminator.
- **Bit numbering**: bit 0 = LSB, bit 7 = MSB (SOP convention, Open Rail Data wiki).
- **Refresh cadence**: roughly every ~2h per area (M9: 13 refreshes/24h).
- **Volume**: ~5.1M S-Class messages/24h nationwide across 176 areas (M9 alone ~12.5k; R1 ~128k).
- **Signal-bit polarity**: the wiki defines a signal bit as "displaying its most restrictive
  aspect or not" — i.e. set = off, unset = on. M8's published signal bytes are ~always `00` across
  refreshes, consistent with that, but M8 byte 25 (0x19, S3037-S3048) sits at `66` most of the
  time — so polarity is **verified per binding** (existing `tdSBit.activeMeans`), never assumed
  globally.
- **Published definition tables disagree on byte radix**: the R3 wiki table uses hex addresses
  (`0A:0`); the M8 table uses **decimal** byte numbers (0-37 — its "25" is address 0x19).
  Community tables also contain errors (R3 lists `S3533` at both 1A:3 and 26:3). There is **no
  published M9 table** — its mapping must be derived by observation.
- **Existing bug to fix in 36a**: `td_s_current_state` is keyed on the message's `address`, so an
  SG's 4-byte word at address `04` overwrites the 1-byte SF value for byte `04` — current state is
  wrong in every area today.
- Nothing downstream consumes S-Class yet: `liveState.ts`/`reconstructState.ts`/snapshots
  hardcode signals to `blank`; the fast live projector skips S-Class; the editor has no `tdSBit`
  binding UI. The schema (`TdSBitBindingSchema`), compiler (`sBitBindingIndex`) and
  `map_binding_index` (`td_s_bit`) already support the binding.

### Owner decisions (2026-09-19)

1. **Feed gaps**: trust last-known byte state across a TD feed gap of **up to 5 minutes**; beyond
   that, every byte in the affected area(s) becomes `unknown` (blank) until re-confirmed by an SF
   covering it or the next refresh. Threshold configurable, default 300s.
2. **History**: populate `td_s_bit_transition` **nationwide** (rule 17 — never scoped by maps).
3. **Identification aid**: the S-Class explorer may **suggest** candidate bits by correlating bit
   changes with nearby C-Class berth steps, for the owner to confirm manually. Authoring-time only
   — displayed state is always the raw bit. Recorded as a rule-10 clarification in
   `docs/adr/0013-s-class-decoding-and-signal-identification.md`.
4. **Scope**: only signal on/off is bound and rendered in M36. Routes, points, track sections,
   TRTS and level crossings are stored as bits and may be _defined_ (kind recorded), but map
   rendering of them (level crossings and routes are planned) is a later milestone with its own
   ADR — PROJECT_SPEC §10's MVP exclusions stand until then.

### 36a — decode and store (nationwide, map-independent) `[done — deployed 2026-09-19]`

- Pure `decodeSClassPayload` / `foldSClassEvents` in `packages/domain/src/td/sClass.ts` (domain,
  not `feed-parsers`, so the API can reuse the same decode for playback in 36b — rule 13):
  SF/SG/SH → per-byte values; a non-hex/wrong-length address or data, an unknown type, or an SG/SH
  chunk running past 0xFF is rejected with an error code, never repaired or dropped.
- Decoding runs inside the existing `project-td` batch (same transaction and checkpoint as
  `td_s_event`), not as a new projection — so no new daemon, no new nationwide
  `ingestion_sequence` index on `td_s_event`, and no berth-projection rebuild.
- `td_s_event` now records each event's outcome: `decode_status` `decoded` (with
  `decoded_bitset = {"bytes": {"04": 254, ...}}`) or `unsupported` + `decode_error_code`, plus
  `decode_version`. Rows written before 36a stay `raw_only`.
- `td_s_current_state` rows written by the decoder use **`projection_version = 2`**
  (`TD_S_STATE_PROJECTION_VERSION`), keyed per byte, with `byte_value`, `decoded_bitset` (8
  booleans, index = bit), `source_kind` and `last_refresh_at`, behind a monotonic
  `source_ingestion_sequence` guard. The buggy version-1 rows are left untouched (nothing reads
  them; deleting them needs owner approval).
- `td_s_bit_transition` (version 2): first sight of a byte records all 8 bits with
  `previous_value = null` (so bit state at T = latest transition at or before T); afterwards only
  changed bits, tagged `update` (SF) or `refresh` (SG/SH). Unique
  `(projection_version, source_event_id, address, bit_index, event_at)` makes replay a no-op.
  Refresh mismatches (missed SFs) and decode failures are counted and logged by
  `project-td-daemon` as `{"event":"project-td.s-class",...}`.
- `--rebuild` clears and regenerates the version-2 rows along with everything else.
- Migration `0036_s_class_decoding.sql` (numbered to avoid `gps-berths`' `0035`): additive only —
  nullable columns on `td_s_event` (no rewrite), columns on the small `td_s_current_state`, NOT NULL
  columns + unique index on the (empty) `td_s_bit_transition`. Backward compatible with the
  pre-36a code, so it must be run **before** this code deploys.
- **Tests**: 21 domain unit tests incl. a real M9 fixture (58 messages, 2026-09-18 19:21-19:24
  UTC) proving refresh + 46 SFs fold to exactly the next refresh; 6 new/updated projector
  integration tests (per-byte SG, transitions + replay, refresh mismatch, malformed retained,
  rebuild regenerates identically).
- **Not done / deferred**: history before deployment is not decoded — only a full `--rebuild`
  reaches it (a targeted S-Class-only backfill of the ~160M existing rows is a follow-up, to be
  sized first). **Storage**: ~5M transitions/day nationwide ≈ ~1 GB/day (~35 GB/month) estimated;
  production had 125 GB free (75% used) on 2026-09-19 with the DB already growing ~100 GB/month —
  owner to confirm before enabling.
- **Acceptance**: replaying real M9 fixtures yields byte state equal to the next SG/SH refresh ✅;
  rebuild is idempotent ✅; every transition keeps lineage to its source event ✅; unit tests for
  each malformed case ✅; `td_s_current_state` no longer mixes word/byte values ✅.

### 36b — live, playback and freshness `[done — deployed 2026-09-19]`

As built (deviations from the draft above are marked **changed**):

- **Pure rules in `packages/domain/src/td/signalState.ts`**: `signalStateForBit` (bound bit +
  `activeMeans` → on/off; no `activeMeans` → blank), `detectReceiveSilences`, `sByteTrustedAt`
  and `resolveSignalStates`, plus `computeSignalStates` behind a small `SignalFactsPort` whose
  queries live in `packages/database/src/signalFacts.ts`. Live state, `/state?at=` and
  `snapshot-maps` all run that one sequence of steps (rule 13).
- **Freshness — changed**: no `valid_since` column and no session-table gap detection
  (`feed_connection_session.last_frame_at` is never written; a killed process never records
  `disconnected_at`). Instead `project-td` records every TD _receive_ silence over 5 minutes as a
  nationwide `feed_gap` row (`td_receive_silence`, idempotent — migration `0037`). A byte is
  untrusted once a silence that began at or after its confirming event (compared by ingestion
  sequence) has lasted more than 5 minutes; the newest received TD row counts as an ongoing
  silence. These rows also surface in every map's `quality.gaps` (this is the minimal slice of
  Milestone 37 — M37 still owns general reconnect gap rows).
- **Byte facts**: the latest decoded `td_s_event` stating the byte at or before T, within a 6 h
  lookback (areas refresh ~2-hourly) — one index seek per bound byte. Pre-36a history is
  `unknown` (blank), never guessed.
- **Live — changed**: signal deltas come from both live publishers (`ingest-td` inline +
  `projector-td-live`), not just the fast projector, because a client drops its socket on any
  sequence regression and the inline path is ahead. `signal.updated` is only sent when a signal's
  state changes (per-process memory + the existing per-key Redis watermark). Live snapshots
  overlay raw S-Class rows newer than the history checkpoint so they're never behind the deltas
  that follow; if the history projector is >20k rows behind, every signal is blank.
- **Feed-gap resync**: `projector-td-live` detects silences too and sends
  `resync.required { reason: "feed_gap" }` to maps with signal bindings; the WS route forwards it
  and closes, and the client re-snapshots.
- **Also fixed — pre-existing bug**: live deltas for one frame were published in `(td_area,
berth)` order (the fold's lock order), not sequence order, so a frame changing several bound
  berths could regress the sequence and force a client reconnect. All live deltas (berth +
  signal) are now built, sorted by sequence, then published (`publishInSequenceOrder`).
- **Compiled bundle**: `sBitBindingIndex` keys use canonical hex addresses (`canonicalSAddress`);
  new optional `sBitBindingActiveMeans`; `map_binding_index.active_means` (migration `0037`).
- **Playback**: `/events` merges berth rows, S-Class rows and silence blanks into one
  sequence-ordered, jointly-paged stream (`mergeEventPages`: a full source bounds the page; a
  page never splits a sequence).
- **Production query checks (2026-09-19, `EXPLAIN ANALYZE`)**: 24-byte facts 9.6 ms; last TD row
  0.8 ms; live overlay 0.8 ms; playback 30-min window 5.3 ms; `projector-td-live` batch 1.1 ms.
  Two plans were caught and fixed before deploy: an `ORDER BY` bound to a `::text` output alias
  (a >5 min parallel scan), and a `td_area` predicate on the raw overlay that folded in the area
  index (>20 s) — the overlay now uses `project-td`'s own query shape and filters in code.
- **Tests**: domain (`signalState.test.ts`, 17), compiler (canonical address/activeMeans),
  `liveProjector.test.ts` (sequence ordering regression, signal deltas), `mergeEventPages.test.ts`,
  web hooks (live `signal.updated`, `feed_gap` resync, playback signal apply); integration:
  `signals.integration.test.ts` (on/off/blank/trust window/re-confirmation/paging), live projector
  (signal delta, resync), history projector (silence recorded once).
- **Not done / follow-up**: editor preview still draws signals from their static `symbolStyle`
  (binding authoring is 36c); pre-36a history stays blank unless a decode backfill is run.
- **Acceptance**: a live bit change reaches the browser via the same publishers as berths ✅;
  playback at T matches bits at T ✅ (`/state?at=` and `/events` share the rules); after a >5 min
  silence signals blank until re-confirmed, after a <5 min one they keep their state ✅; no
  signal is ever rendered from anything but its bound bit ✅.

### 36c — definitions and authoring `[implemented 2026-09-19 — not yet deployed]`

As built (owner decisions 2026-09-19: the explorer lives under the admin "Berths" hub and works
for **every** S-Class area, not M9 only; bound signals show live state in the editor):

- **Definitions** (migration `0038`): `s_class_definition` (`(td_area, address, bit)` unique,
  kind/label/destination/source/notes, DB-checked) + append-only `s_class_definition_revision`
  (previous/next, who, import batch) — the "versioned" requirement.
- **Import**: pure `parseSClassDefinitionTable` (`packages/domain/src/td/sClassDefinitions.ts`)
  handles both real layouts (R3 `ADDR:BIT`, M8 `BYTE BIT`); radix must be chosen; `?`/blank rows
  skipped and counted; duplicate bits are errors, duplicate labels warnings. Dry run first;
  commit refuses on errors and only overwrites conflicts on request.
- **Admin explorer** `/admin/berths/s-class` (`SClassExplorerPage.tsx`, routes in
  `apps/api/src/routes/admin/sClass.ts`): live bit grid (5 s refresh, recent-change highlight,
  defined labels), per-bit history, define/edit/remove, import panel, and two authoring-only
  suggestion tools — bit to nearby CA steps, and step to bits (±10 s, last 24 h, hit counts and
  median offset).
- **Editor**: Properties panel "S-Class binding" (area, defined-signal picker, hex address, bit,
  `activeMeans`, "Use as label", explicit apply); bound signals show live state on the canvas in
  every view (`useLiveSignalStates`, same colours as the public renderer via
  `MAP_STYLE.signal.stateColors`); schema tightened (address 1-2 hex, bit 0-7); validation errors
  for more than one binding per signal or a tdSBit binding on a non-signal, and a
  `signal_bit_never_changed` warning (7 days).
- **Production query checks (2026-09-19)**: R1 24 h grid activity 167 ms; bit to steps 578 ms;
  step to bits 73 ms (the area's changes read once — the transition index can't seek a time
  range without an address).
- **Tests**: parser (real R3/M8 excerpts), schema validation, admin routes integration (grid,
  history, both suggestion directions, definition revisions, import radix/preview/errors/
  conflicts), contextual validation integration, PropertyPanel binding, live-state hook,
  explorer page.
- **Acceptance**: R3 imports as hex and flags its S3533 duplicate ✅ (parser test); the M8 table
  imported as decimal lands S3037 on 0x19:1 ✅; an editor-bound signal renders live on/off with
  the same state computation and colours as the public renderer ✅.

### 36d — Blackpool bindings `[owner's task]`

Owner identifies M9 signal bits via the explorer and binds the 70 Blackpool signals, then
publishes a new map version.

## Milestone 37 — `feed_gap` auto-detection on reconnect `[planned]`

Flagged as a follow-up when the `ingest-td` SIGTERM/reconnect root-cause fix landed (Milestone
23): reconnects are now handled cleanly, but nothing yet writes a `feed_gap` row when one happens,
despite `docs/PROJECT_SPEC.md` §11.8 and `feedGapWarnings` existing specifically to consume that
data. Worth doing once real-world reconnect frequency post-fix is observed.

## Milestone 38 — editor structural track model & visual overhaul ("Route A" / 14b) `[planned]`

ADR 0004's deferred structural model, **and** the visual-overhaul items the owner asked for back
when that ADR was written (2026-09-07, ADR 0004 §Context: _"eventually line names / structures
(tunnels, viaducts) / neutral sections / area boundaries"_) — kept as one milestone per owner
decision (2026-09-13), not split out, but broken out explicitly below so it doesn't read as a
buried footnote again:

- **Structural track model**: real `track`/`trackSegment`/`row-transition`/`turnout` elements
  replacing today's free-drawn two-point polylines, requiring existing maps (Lancaster included)
  to be re-authored as a new version. Bundled with it (ADR 0004 D5, deferred alongside this): the
  structural "berth = span on a track" model, replacing a berth's independent box geometry.
- **Visual overhaul — new editor-authorable annotation elements**:
  - **Tunnels and viaducts** — structure markers along a track (OTT's grey `.portal` is the
    closest prior art), editable in the editor like any other element, not just a renderer-side
    style.
  - **Neutral sections** — electrification-gap markers.
  - **Area/signalling-boundary styling** — a proper dashed-line boundary style (OTT's `.divide`),
    distinct from and complementary to the plain boundary marker Milestone 32 already makes
    clickable.
  - **Line names on the track path itself** — labels that follow a track's line rather than
    sitting at a fixed point.
- Also bundled per ADR 0004: directional arrow ticks, points/switch blade glyphs, "set route"
  highlighting, a platform zone bracket, richer berth colour semantics, and track-stroke halo
  casing.

Sequenced after Milestones 29-33 per owner decision (2026-09-13) — the admin/multi-map/search
work and the Blackpool map land first; this stays the next milestone after that.

## Milestone 39 — sticky run-lineage matching across berth steps and TD-area boundaries `[done — 2026-09-14]`

Owner request, 2026-09-14 (docs/adr/0007), following the 1P03 ambiguity investigation: once an
occupancy is confidently matched, thread that identity forward along `td_berth_event` `CA` (berth
step) chains instead of re-resolving headcode/position from scratch at every berth — a `CA` event
is direct signalling evidence of physical continuity, strictly stronger than a headcode string.
(The ADR's first draft named `CB` for this — corrected against the real reducers,
`packages/domain/src/td/berthReducer.ts`, before implementing: `CA` closes `from`/opens `to`
[the step], `CB` closes `from` only [cancel, chain-breaking], `CC` opens `to` only [fresh
interpose, cold start].) Extended to cross-TD-area boundaries via owner-curated reference data
(never auto-derived/auto-applied) plus corroboration (schedule timing, `trust_movement`
continuity), never headcode alone. Full design, confidence-tiering rules, and the three owner
decisions (inherit-and-cap confidence; boundary pairs entered by the owner through a new editor
screen; joins/splits always reset to fresh resolution) are in docs/adr/0007.

Checklist:

- [x] Migration 0032: `train_run`, `berth_occupancy_run_link`, `td_area_boundary`. No change to
      any existing table — the projector's occupancy lookups reuse the existing
      `(td_area, berth_code, entered_at desc)` index rather than adding one to the huge, hot
      `berth_occupancy`.
- [x] Pure domain logic (fixture-tested, `packages/domain/src/schedule/runLineage.ts`,
      16 cases): confidence-capping on inheritance, clean-step/feed-gap chain-break detection,
      boundary corroboration eligibility scoring.
- [x] `run-lineage-daemon` (worker, `apps/worker/src/runLineage/projector.ts`), checkpointed
      against `td_berth_event`, wired into command dispatch and
      `deploy/docker-compose.portainer.yml`.
- [x] `currentRun.ts`: lineage lookup (`apps/api/src/lib/runLineage.ts`) ahead of the existing
      ADR 0006/0035 resolver; `matchBasis` gains `step_chain`/`boundary_correlated`, confidence
      surfaced verbatim, never upgraded. A real (non-lineage) `matched` result establishes/
      corrects the link afterward; a lineage-shortcut match never rewrites it (would relabel
      inherited provenance as fresh).
- [x] Admin-only editor screen (`apps/web/src/auth/TdBoundariesPage.tsx`, `/admin/td-boundaries`) + API routes (`apps/api/src/routes/admin/tdBoundaries.ts`) for curating `td_area_boundary` —
      same `AdminUsersPage`/role-gating pattern, reference data entry, not Konva canvas authoring.
- [x] Correction path: fresher evidence (new `trust_activation`, STP change) supersedes an
      inherited link (`train_run.superseded_by`) rather than freezing it.
- [x] Docs: `DATA_MODEL.md` §8, `API_CONTRACT.md` (current-run + new admin endpoints),
      `ARCHITECTURE.md` (new daemon), this checklist.
- [x] Resolves the "Map continuation/follow-train behaviour" line previously under
      Later/unscheduled below.

Tests: `runLineage.test.ts` (16 pure-logic cases), `projector.integration.test.ts` (4 cases —
step-chain inheritance + confidence cap, no-propagation-when-unlinked, boundary correlation via
TRUST movement continuity, boundary ambiguity with two unclaimed candidates), `tdBoundaries.
integration.test.ts` (4 cases), `TdBoundariesPage.test.tsx` (3 cases). `pnpm -r typecheck` and
`pnpm run lint` green for every touched package. **Known limitation**: the two new integration
test files could not be run locally this session (no local Postgres available, and an SSH tunnel
to a disposable remote one was blocked by the sandbox) — typechecked and reviewed carefully
against real schema/query behavior, but their first actual execution is CI's `test:integration`
job. Also not attempted, matching the ADR's explicit scope: portion join/split tracking (resets to
fresh resolution instead) and any SMART-derived auto-suggestion for boundary entry (owner-curated
only, by design).

**First-deploy production incident, same day** (docs/adr/0007 addendum): a fresh checkpoint tried
to replay `td_berth_event`'s entire nationwide history, with no supporting index on
`ingestion_sequence` (full scan+sort every tick) and cold-partition reads slow enough to blow the
statement timeout on the very first batch. Fixed with migration 0033 (index, built on production
via `CREATE INDEX CONCURRENTLY` per partition + `ATTACH PARTITION`, never blocking a write) and a
new `seedRunLineageCheckpointIfFresh` step that skips a fresh checkpoint straight to the current
tail instead of the backlog — sticky matching only helps live movements anyway. Daemon stopped
during diagnosis, live traffic confirmed unaffected throughout, redeployed clean afterward.

**Proactive resolution addendum, 2026-09-14** (docs/adr/0007): a real train (5N92/W85506) went
completely unidentified all day because a run was only ever established reactively, on a popup
click — this daemon only ever _propagated_ an existing link. `sweepFreshResolution`
(`apps/worker/src/runLineage/projector.ts`) now also proactively resolves any open, unlinked
occupancy in an eligible TD area each tick, gated by `RUN_LINEAGE_FRESH_RESOLUTION_ENABLED` (off
by default) and `RUN_LINEAGE_FRESH_RESOLUTION_SCOPE` (`mapped` — every TD area with at least one
published-map binding — or `nationwide`). The click-path resolution logic
(`berthStanoxes`/`queryCandidateSchedules`/`resolveRunMatch`/... , previously inlined in
`currentRun.ts`) moved to `packages/database/src/runResolution.ts` (`resolveFreshRunMatch`) so
both the click path and this sweep share one implementation — `apps/worker` cannot import from
`apps/api`, so this couldn't stay api-only. `apps/api/src/lib/runLineage.ts` (`findOpenOccupancy`/
`findOccupancyLink`/`upsertResolvedLink`) moved there too for the same reason. Tests: 19
pre-existing `currentRun.integration.test.ts` cases pass unchanged (behavior-preserving
extraction, verified against a disposable Postgres); 3 new `freshResolution.integration.test.ts`
cases (establishes a link in a mapped area, skips an unmapped one, cooldown suppresses an
immediate retry — scoped to each test's own fixture, not the aggregate summary counters, since
`sweepFreshResolution` deliberately scans every eligible area and the shared integration-test
database has other files' map/occupancy fixtures in it too). Resource cost measured against
production before enabling: ~0.0076 resolutions/sec for one mapped area vs ~1.5/sec nationwide,
~15-30ms of mostly-indexed DB work each.

## Milestone 40 — traffic-day boundary fix for the berth-run resolver `[done — 2026-09-15]`

Bugfix (docs/adr/0008), found 2026-09-14 investigating a real report and carried over two
sessions before being fixed properly rather than rushed: PX berth 0052, headcode `5F05` (train UID
`W33229`, Preston → Edge Hill Depot, departed 23:28 the previous night), went `unmatched` the
instant the London calendar rolled over past midnight, even though the train was still genuinely
running and its schedule (dated only the previous day) still existed in the garner mirror with
every calling point synced. Root cause: every date used throughout the resolver (`currentRun.ts`'s
`today`, the SQL candidate-schedule query, `resolveRunMatch`'s pure day-of-week/date-range check,
the TRUST activation cutoff, and the traffic day written to `berth_occupancy_run_link`) was a
single shared Europe/London calendar date, with no notion that a schedule crossing midnight
belongs to _yesterday's_ traffic day, not today's.

Owner-confirmed approach: probe both today's and yesterday's date, not a full WTT 02:00-boundary
traffic-day rewrite. See docs/adr/0008 for the full design — in short, `resolveRunMatch` and its
pure helpers now take an ordered `serviceDates` window instead of one shared date, and tag each
matched/ambiguous candidate with whichever date it actually runs on; every caller
(`currentRun.ts`'s fresh-resolution _and_ lineage-shortcut paths, `sweepFreshResolution`,
`attemptStepChainUpgrades`) now threads that resolved `trafficDay` through to the TRUST activation
detail query, the `train_allocation` unit-allocation lookup, and the link it writes — never a
hardcoded `today` again.

Checklist:

- [x] `packages/domain/src/schedule/resolveStpPrecedence.ts`: additive `candidatesRunningOnAny`/
      `selectEffectiveScheduleAcrossDates` (multi-date), existing single-date functions untouched
      (still used by `apps/api/src/routes/schedule.ts`'s unrelated lookup).
- [x] `packages/domain/src/schedule/resolveRunMatch.ts`: `serviceDates: readonly string[]` instead
      of `serviceDate: string`; `matched`/`ambiguous` results carry the resolved `trafficDay`.
- [x] `packages/database/src/runResolution.ts`: `previousCalendarDate` (pure calendar-string
      arithmetic, DST-safe); `queryCandidateSchedules` widened to a `serviceDates` window;
      `resolveFreshRunMatch` probes `[today, yesterday]`, widens the TRUST activation cutoff, and
      returns `trafficDay`.
- [x] `apps/api/src/routes/currentRun.ts` and `apps/worker/src/runLineage/projector.ts`: use the
      resolver's own `trafficDay`, not hardcoded `today`, everywhere it flows downstream —
      including the Milestone 39 lineage-shortcut path, which had `occupancyLink.trafficDay`
      available all along but wasn't using it.
- [x] Docs: docs/adr/0008 (new), this checklist.

Tests: `resolveStpPrecedence.test.ts` (+4 cases, multi-date probing), `resolveRunMatch.test.ts`
(rewritten for the array signature, +4 new cases covering the exact overnight scenario and the
"both dates satisfied → prefers today" non-regression case), `runResolution.test.ts` (new,
`previousCalendarDate` incl. the real BST→GMT transition date and a leap day),
`currentRun.integration.test.ts` (+4 cases: yesterday-only schedule still matches, a pre-midnight
TRUST activation still counts, unit allocation keys off the resolved traffic day not `today`, and
today-vs-yesterday preference when a schedule satisfies both). `pnpm -r typecheck`, `pnpm run
lint`, and every non-integration Vitest suite touched by this change were run and passed; the
integration suite needs a live Postgres this sandbox doesn't have, matching the same limitation
Milestone 39 already noted — first real execution is CI's `test:integration` job.

## Milestone 41 — fix: playback buffer stopped refilling forever after its first quiet page `[done — 2026-09-15]`

Bugfix, reported by the owner mid-session (2026-09-15): trains stop stepping roughly 30 minutes
into playback ("went to 0430 and watched at 60×; by 0500 trains had stopped stepping"), and
jumping the playhead forward fixes it for about another 30 minutes each time.

Root cause in `apps/web/src/map/usePlayback.ts`: `GET /events`
(`apps/api/src/routes/maps.ts`) returns `nextCursor: null` whenever a page comes back with fewer
rows than the row cap — meaning only "caught up to the `to` bound _that page asked for_," not "no
more events will ever exist." `refill()` treated a `null` cursor as a permanent stop
(`if (refillingRef.current || cursorRef.current === null) return;`), and the tick loop's own
trigger repeated the same guard. For a single map's handful of berths, the very first `/events`
page (fetched by `seed()`, covering `BUFFER_WINDOW_MS` = 30 minutes) routinely comes back under
the row cap already — so refilling was disabled from the start of every playback session. The
playback clock itself doesn't pause when the buffer runs dry (it keeps advancing every tick
regardless of whether there's anything left to apply) — so berths silently froze in place exactly
`BUFFER_WINDOW_MS` after the seed point, while the clock kept moving. `jumpTo`/`step` call `seed()`,
which re-fetches fresh (and resets the cursor), buying another ~30 minutes before hitting the same
wall.

Fix: a `null` cursor now means "resume from the start of this window" (the server's own `after`
default, `"0"`) rather than "stop refilling forever." `refill()`'s `to` bound is recomputed from
`clockRef.current` on every call, so a later attempt with a bigger window can find events a
previous, narrower query genuinely didn't have yet.

Checklist:

- [x] `apps/web/src/map/usePlayback.ts`: removed the `cursorRef.current === null` early-return in
      `refill()` and the matching gate in the tick loop's refill trigger; `after` defaults to
      `"0"` (matching the server) instead of refusing to build the request URL at all.
- [x] Docs: this checklist.

Tests: new case in `usePlayback.test.tsx` — after an initial null-cursor `/events` page, repeated
ticks with the buffer still empty keep issuing new `/events` requests rather than stopping after
the first one (would have failed against the pre-fix code, which calls `/events` exactly once and
then never again). Full existing `usePlayback.test.tsx` suite (5 cases) and `pnpm run lint` +
`apps/web` typecheck all pass.

## Milestone 42 — fix: TRUST activation checked per schedule id only, not per resolved date `[done — 2026-09-15]`

Bugfix (docs/adr/0008 addendum), found the same day Milestone 40 shipped, investigating a real
report: PX berth 0107, headcode `1Y61`, reported `ambiguous` by the owner despite an obviously
correct candidate (`G89843`, activated that same morning, confirmed against the reference site).
Root cause: Milestone 40 widened the TRUST activation SQL cutoff to yesterday's midnight (correct,
needed for the overnight-train case) but `resolveRunMatch`'s activation check stayed a flat
`Set<scheduleId>` membership test — "was there _any_ activation row for this schedule id in the
widened window," with no awareness of which calendar day each row belonged to. `G89843` and
`G89845` share this headcode and both call at the same position-scoped berth every day; `G89845`'s
stale activation from **the evening before** (an entirely different, unrelated prior day's working)
started counting as "activated" for today's tier too, alongside `G89843`'s real same-morning one —
falsely reporting `ambiguous` instead of matching `G89843` cleanly.

Fix: `resolveRunMatch` now checks each candidate's _own resolved traffic day_ against the specific
calendar date its activation was actually dated on (`activatedDatesByScheduleId: ReadonlyMap<string,
ReadonlySet<string>>`), not schedule-id membership alone — built from the same already-widened
query (no new SQL) by grouping activation rows under their own London calendar date instead of
collapsing to "most recent regardless of date." Full design/rationale in docs/adr/0008's addendum.

Checklist:

- [x] `packages/domain/src/schedule/resolveRunMatch.ts`: `activatedDatesByScheduleId` replaces the
      flat `activatedScheduleIds` set; the trust_activation tier now matches per (scheduleId,
      resolvedDate) pair.
- [x] `packages/database/src/runResolution.ts`: `resolveFreshRunMatch` groups the widened
      activation query's rows by their own calendar date instead of collapsing to one row per
      schedule; `buildCandidateSchedules`'s `activatedToday`/`trustId` display fields re-scoped to
      a `todaysActivationByScheduleId` map (rows dated specifically `today`), fixing the same
      imprecision for the authenticated candidate-list display.
- [x] Docs: docs/adr/0008 addendum, this checklist.
- [x] `deploy/.env.example`: documented `RUN_LINEAGE_FRESH_RESOLUTION_ENABLED`/`_SCOPE` and
      `LIVE_WS_HEARTBEAT_INTERVAL_MS`, found missing (owner report) while enabling proactive
      resolution in production for the first time — real, functioning config knobs the compose
      file already defaulted, just never surfaced in the example file.

Tests: `resolveRunMatch.test.ts` (+1 case reproducing the exact PX 0107/1Y61 scenario: two
daily-running same-headcode candidates, one activated today, one activated only the day before —
must resolve `trust_activation`/matched to today's, never ambiguous), `currentRun.integration.test.ts`
(+1 integration case, same scenario end-to-end). `pnpm -r typecheck`, `pnpm run lint`, `pnpm run
format:check`, and the full non-integration Vitest suite (78 files / 524 tests) all pass.

First push's CI failed the integration suite — not on the new fix itself, but on a pre-existing
same-session test (`still counts a TRUST activation created before London midnight for a schedule
dated only yesterday`) whose own fixture used `Date.now() - 6h` to simulate "last night," which
doesn't reliably land on _yesterday's_ London calendar date depending on what wall-clock time CI
happens to run at — once the activation check became properly date-scoped (this milestone's own
fix), that timing-dependent fixture started failing intermittently instead of the bug it was
supposed to guard against. Fixed to construct the timestamp from an explicit `${yesterday}T22:00:00Z`
instead, matching the same safe pattern already used elsewhere in this file. Confirmed the same
class of bug independently against a second real report (PX 0126, headcode `5S65`) via a direct
repro against production data.

## Milestone 43 — an unscoped headcode match with only one running candidate is solid `[done — 2026-09-15]`

Design refinement (docs/adr/0008 second addendum), owner-prompted by the `5Z07`/`9S47` reports:
both were correctly resolved internally (confirmed against the reference site) but hidden from the
public map because their current berth has no SMART coverage. The owner's observation — "if
there's only one candidate then surely that's a good match?" — is correct: `headcode_only`'s real
weakness is the risk of a _different, unrelated_ train sharing the same headcode elsewhere on the
network (a real, common occurrence — confirmed the same day: headcode `1M73` had two completely
different real trains running nationwide). When the unscoped search finds exactly one running
candidate, that risk is provably zero, not merely assumed absent.

Checklist:

- [x] `packages/database/src/runResolution.ts`: `resolveFreshRunMatch`'s `isSolidMatch` also
      treats an unscoped match as solid when `candidatesRunningOnAny` found exactly one running
      candidate nationwide; two or more running candidates keeps the existing weak/hidden
      treatment, even when the resolver itself picks a clean winner. `matchBasis` and the
      underlying `match_confidence` written to `train_run` (step-chain propagation) are
      unaffected — response-shaping only.
- [x] Docs: docs/adr/0008 second addendum, this checklist.

Tests: `currentRun.integration.test.ts` — rewrote the single-unscoped-candidate public-visibility
case to expect 200 (was 404), added a case confirming two unscoped candidates still 404 even when
the resolver resolves cleanly via STP precedence. `pnpm -r typecheck`, `pnpm run lint`, `pnpm run
format:check`, and the full non-integration Vitest suite (78 files / 524 tests) all pass.

## Milestone 44 — count distinct trains, extend solid to a clean TRUST-activation win, propagate confidence into storage `[done — 2026-09-15]`

Bugfix (docs/adr/0008 third addendum), owner-requested proactive pass: investigated a further real
report (PX 0188, headcode `1C55`, correct train `G89047`) together with a look for anything else
of the same shape, rather than fixing one report at a time.

Found three related gaps in Milestone 43's own new logic and its reach:

1. `runningNationwideCount` counted raw schedule **rows**, not distinct **trains**
   (`cif_train_uid`) — a single train routinely has both a Permanent and Overlay row
   simultaneously satisfying today's date/bitmask, so a genuinely unique train could get
   miscounted as "two candidates" and wrongly stay hidden.
2. The `1C55` case itself: a clean `trust_activation` win among _multiple different_ nationwide
   trains stayed hidden, even though TRUST activation isn't headcode-derived at all — it's an NR
   signal already linked to one specific schedule — and the real risk (two different trains both
   getting activated) is already caught as `ambiguous` one tier up (CLAUDE.md rule 7).
3. Both the Milestone 43 fix and this one only reached the _ephemeral API response_
   (`isSolidMatch`) — an occupancy that already carried a stored link kept whatever confidence was
   computed under the old, narrower rule, so the improvement only applied to freshly-resolved
   occupancies going forward, not retroactively, and step-chain upgrade eligibility didn't benefit
   either.

Checklist:

- [x] `packages/database/src/runResolution.ts`: `runningNationwideCount` → distinct-train-uid
      count; `isSolidMatch` also true when `matchResult.basis === "trust_activation"` regardless
      of how many trains shared the headcode.
- [x] `ResolvedRunToLink` gains `matchConfidence`, supplied by the caller's own computed
      `isSolidMatch` instead of being re-derived inside `upsertResolvedLink` via
      `confidenceForBasis` — all three callers (`currentRun.ts`, `sweepFreshResolution`,
      `attemptStepChainUpgrades`) updated. `confidenceForBasis` itself is untouched (still correct,
      still tested) — just no longer this call site's source of truth.
- [x] Docs: docs/adr/0008 third addendum, this checklist.

Tests: `currentRun.integration.test.ts` — new cases for a same-train Permanent+Overlay pair
(solid), a clean TRUST-activation win among two different trains sharing a headcode (the actual
`1C55` scenario), and confirmation an STP-only tie-break across two _different_ trains still stays
hidden. `pnpm -r typecheck`, `pnpm run lint`, `pnpm run format:check`, and the full non-integration
Vitest suite (78 files / 524 tests) all pass.

## Milestone 45 — exclude an activated candidate demonstrably already gone, using its own TRUST movement history `[done — 2026-09-15]`

Feature (docs/adr/0008 fourth addendum), owner-proposed and confirmed against real production data
before building: PX 0237, headcode `1M11` — `W33973` (correct) and a same-headcode Caledonian
Sleeper working (`C04561`) were both genuinely activated within the two-date probe window,
correctly reporting `ambiguous`. But `C04561`'s own `trust_movement` history showed it passing
straight through this exact location over eight hours earlier and on to what's almost certainly
Euston shortly after — a real train, already finished, not a genuine collision.

Positive TRUST movement evidence outranks every tier below it (direct physical evidence, not
inference), so it filters the entire candidate pool before any tier runs — not just the
`trust_activation` check. Absence of movement data is never used to exclude a candidate (could
mean "hasn't started yet" or "a data gap in the mirror") — only a positive report at or beyond this
berth's own calling point does.

Checklist:

- [x] `packages/domain/src/schedule/resolveRunMatch.ts`: optional 5th parameter
      `alreadyPassedScheduleIds`, filters `candidates` before any tier (including STP precedence
      and `station_berth_timetable`) ever sees them.
- [x] `packages/database/src/runResolution.ts`: new `findAlreadyPassedScheduleIds` — only queried
      when position-scoped and more than one schedule has some activation in the window; resolves
      each schedule's own calling-point `seq_no` at this berth, checks whether its `trust_id`'s
      movements report a location at or beyond it in that same schedule's sequence.
- [x] Docs: docs/adr/0008 fourth addendum, this checklist.

Tests: `resolveRunMatch.test.ts` (+4 pure cases, including the real PX 0237/1M11 scenario and
confirmation the filter also protects the STP tier), `currentRun.integration.test.ts` (+2 cases,
the real scenario end-to-end and a no-movement-evidence-either-way case staying ambiguous). `pnpm
-r typecheck`, `pnpm run lint`, `pnpm run format:check`, and the full non-integration Vitest suite
(78 files / 528 tests) all pass.

## Milestone 46 — fix: live berth state showed raw `"----"` instead of treating it as "no train" `[done — 2026-09-15]`

Bugfix, reported by the owner: a berth at Lancaster displayed literal `----` live, but the same
berth never showed anything during playback — "OTT has this issue too but Traksy does not."

Root cause: two separate pure functions turn a CA/CB/CC event into berth-state changes.
`applyCA`/`applyCB`/`applyCC` (`packages/domain/src/td/berthReducer.ts`) — used by the history
projector for `berth_occupancy` — correctly treat a `descr` of `"----"` (the real TD convention for
a signaller manually blanking a berth, docs/DATA_MODEL.md §"C-Class projection behavior") as "no
train": never opens an occupancy for it. `berthChangesForEvent`
(`packages/domain/src/td/berthChanges.ts`) — used by the live path (`berth_current_state`, WS live
deltas) **and** the playback `/events` endpoint — never implemented that exclusion despite its own
doc comment claiming to mirror `berthReducer.ts`'s semantics exactly (CLAUDE.md rule 13), and no
test covered `"----"` for it. So live rendered the raw placeholder as if it were a real headcode,
while `/state?at=` (built from `berth_occupancy`, which never recorded it) correctly never did —
live and playback disagreed about whether the berth was "occupied by `----`".

Fix: `berthChangesForEvent`'s CA/CC `to`-berth changes now report `description: null` (a
`berth.cleared`-shaped change) when the raw `descr` is the shared `NULL_DESCRIPTION` constant,
exported from `berthReducer.ts` so the two functions can't diverge again. CB is unaffected (it
never carried a `to` change). No DB migration: pre-existing `"----"` rows already written to
`berth_current_state` self-heal on that berth's next real event.

Checklist:

- [x] `packages/domain/src/td/berthReducer.ts`: exported `NULL_DESCRIPTION`.
- [x] `packages/domain/src/td/berthChanges.ts`: CA/CC `to` changes map `NULL_DESCRIPTION` to
      `description: null`; doc comment now describes the actual (matching) behavior.
- [x] Docs: this checklist.

Tests: `berthChanges.test.ts` (+2 cases: CA and CC with `descr: "----"`, mirroring the existing
`berthReducer.test.ts` cases). Full `@railway/domain`, `@railway/worker`, and `@railway/api`
non-integration Vitest suites (107 + 94 + 43 tests) all pass, `pnpm -w typecheck`, and
`pnpm -w format:check` all pass.

## Milestone 47 — fix: editor's manual berth-clear silently no-op'd when there was no open `berth_occupancy` row `[done — 2026-09-15]`

Bugfix, found immediately after Milestone 46 while the owner tried the editor's "Clear" button on
exactly the stuck `"----"` berth that milestone was about: the button reported success but the
berth kept showing the same description afterwards.

Root cause in `apps/api/src/routes/editor/berthActions.ts`'s `POST
/api/v1/editor/berths/{tdArea}/{berth}/clear`: it only updated `berth_current_state` inside `if
(open)`, where `open` came from `findOpenOccupancy` (a `berth_occupancy` row with `left_at is
null`). But `berth_current_state` and `berth_occupancy` are independently written (ADR 0003), and
a berth whose live state came from a `NULL_DESCRIPTION`/`"----"` step never had an occupancy
opened for it at all (Milestone 46's whole subject) — so `open` was always null for exactly this
case, the `berth_current_state` update was skipped entirely, and the click quietly wrote only an
`operator_berth_action` audit row with `cleared: false`, leaving the berth showing the same stale
value. This defeated the endpoint's own stated purpose ("a manual override for a berth stuck
showing a stale description") for the specific case it's most needed.

Fix: also read `berth_current_state.description` directly (`findCurrentDescription`); clear
`berth_current_state` whenever _either_ an open occupancy exists _or_ the current-state row shows
something, not only the former. Closing the occupancy (when one exists) stays a separate step.

Checklist:

- [x] `apps/api/src/routes/editor/berthActions.ts`: added `findCurrentDescription`; the
      `berth_current_state` update now runs whenever `open !== null || current !== null`;
      `previousDescription` falls back to `current` when there's no occupancy row.
- [x] Docs: this checklist.

Tests: `berthActions.integration.test.ts` (+1 case: a `berth_current_state` row with no matching
open `berth_occupancy` row still gets cleared, with `closed_occupancy_id: null` in the audit log);
existing two cases (real open occupancy; already-clear berth) still pass unchanged. `pnpm -w
typecheck` and `pnpm -w format:check` pass; the integration suite needs a live Postgres this
sandbox doesn't have (same limitation noted on earlier milestones) — first real execution is CI's
`test:integration` job.

## Milestone 48 — fix: boundary-link centering broke on in-place map navigation; add a per-map home point `[done — 2026-09-16]`

Two owner requests together: (1) clicking a boundary label correctly navigated to the adjacent map
but landed nowhere near the intended crossing — near the whole map's bounding-box centre instead;
(2) a way to set, per map, the point the public renderer lands on when you click into it from the
home page.

**Root cause of (1):** `useRoute.ts`'s `navigate()` is a client-side `pushState` — it never
unmounts/remounts `MapView`/`MapRenderer` when the route's `slug` changes, since both render from
the same JSX position in `App.tsx` with no `key`. `MapRenderer`'s centering (`initialCenterPoint`,
and the initial `viewBox`/`restoredFromStorage` values) is deliberately mount-only state (a
`useRef`/lazy `useState` initializer, documented as such) — correct for "don't fight a visitor's
own panning on a later prop change", but it meant clicking a boundary link from an already-open map
page updated `centerElementId` on the _same_ `MapRenderer` instance, which never re-evaluated it.
The view fell through to whatever the mount-time effect did instead — in practice, the new map's
plain bounding-box centre. Existing tests never caught this because every one of them called RTL's
`render()` fresh per case, which is itself a mount — none exercised a same-instance `slug` change
via `rerender()`, the actual shape of an in-app navigation.

**Fix:** `apps/web/src/map/MapView.tsx` — `<MapRenderer key={bundle.mapId} .../>` at both render
sites (live and playback), forcing a genuine remount whenever the displayed map's identity changes,
restoring correct one-time-at-mount semantics for the boundary/search centering and the per-map
saved-view restore.

**Home point (2):** `packages/map-schema/src/document.ts` — `MapMetaSchema` gains optional
`homePoint: {x, y}`. `packages/map-schema/src/compiler.ts` — `CompiledMapBundle.homePoint`
(optional; `exactOptionalPropertyTypes` means it's spread in only when set, never assigned a
literal `undefined`). `apps/web/src/map/MapRenderer.tsx` — `defaultView` centres on
`bundle.homePoint` when set, else the previous bounding-box centre; this is exactly the "first-ever
visit, or Reset view" default, so it covers "clicking this map from the home page" without touching
a returning visitor's remembered pan/zoom, and an explicit `centerElementId`/`centerBoundaryName`
(search or boundary-link click-through) still takes priority. Editor: `EditorState.tsx` gained
`setMapHomePoint` (mirrors the existing `setMapName` — plain state update, no undo entry, `point:
null` clears it); `PropertyPanel.tsx`'s no-selection "Map" fieldset gained Home point X/Y number
fields plus a Clear button, next to the existing map-name field.

Checklist:

- [x] `apps/web/src/map/MapView.tsx`: key both `MapRenderer` render sites by `bundle.mapId`.
- [x] `packages/map-schema/src/document.ts`: `MapMetaSchema.homePoint` (optional point).
- [x] `packages/map-schema/src/compiler.ts`: `CompiledMapBundle.homePoint`, conditionally spread.
- [x] `apps/web/src/map/MapRenderer.tsx`: `defaultView` prefers `bundle.homePoint`.
- [x] `apps/web/src/editor/EditorState.tsx`: `setMapHomePoint` action + reducer case.
- [x] `apps/web/src/editor/PropertyPanel.tsx`: Home point X/Y fields + Clear button.
- [x] Docs: `docs/MAP_EDITOR_SPEC.md` §"Map metadata"; this checklist.

Tests: `document.test.ts` (`homePoint` parses, omitted when unset); `compiler.test.ts` (carried
through when set, `undefined` otherwise); `MapRenderer.test.tsx` (`homePoint` overrides the
bounding-box centre; an explicit `centerElementId` still wins over it); `MapView.test.tsx` — a new
regression case that renders once with `slug="lancaster"`, then `rerender()`s the _same_ instance
with `slug="carlisle"` and a `?boundary=` name (simulating the real in-app click-through, not a
fresh mount), asserting the view lands on carlisle's own boundary point rather than lancaster's
stale one or carlisle's bounding-box centre — this test reproduced the bug before the `key` fix and
passes after it; `PropertyPanel.test.tsx` (home point fields commit X/Y independently, Clear
resets). `pnpm run build:libs`, `pnpm -r typecheck`, `pnpm run lint`, `pnpm run format:check` (only
pre-existing unrelated files still flagged) and the full unit suite (`packages/map-schema`: 62
passed; `apps/web`: 147 passed) all green.

Known limitations: `homePoint` is a raw author-typed X/Y pair (matching how every other
element-level coordinate is authored in this editor) — no click-on-canvas-to-set convenience yet;
the boundary-link correspondence itself is still entirely author-maintained (Milestone 32's known
limitation, unchanged here).

## Milestone 49 — TRUST Change of Origin/Identity/Location and part-cancellation reflected as current state, not just a message log `[RLM side done — 2026-09-17; openrail side implemented, unverified — see Known limitations]`

Owner report, 2026-09-17: garner already mirrors TRUST's Change of Origin/Identity/Location
messages (migration 0025), but nothing downstream ever reads them back into anything a viewer
actually sees — not openrail's own summary/departure/arrival boards, not its `/rail/livetrain`
detail page's schedule table (only its top-of-page message log), not RLM's own `current-run`
popup. A retimed-mid-route or re-identified train was showing exactly as if nothing had happened.
Full design/decision record: `docs/adr/0009`.

Two things confirmed with the owner before implementing: (1) plan and implement all three affected
surfaces together rather than one at a time, even though they span this repo and the separate
`openrail-master` (legacy C, no test suite, no local compiler in this environment) codebase; (2)
TRUST has no "change of destination" message — a part-cancellation's own location (not yet
reinstated) is read as the run's new effective destination everywhere.

**RLM (`current-run` resolver/API/web popup) — this repo, fully typecheck/lint/test-verified:**
`packages/database/src/runResolution.ts` gained `fetchTrustChanges` — resolves the TRUST identity
chain (`trust_changeid`, bounded to 8 hops) and, across every id in that chain, the latest Change
of Origin, latest not-yet-reinstated part-cancellation (read as the new destination), and every
Change of Location. `apps/api/src/routes/currentRun.ts` applies these: `effective.originTiploc`/
`destinationTiploc`/`locations[]` become _current_ values (in place, no strikethrough — owner
request, deliberately different from openrail's own detail page); `latestMovement` now searches
every id in the identity chain, not just the activation's original one (a real secondary bug fix —
a movement reported under a post-Change-of-Identity id was previously invisible to this endpoint).
New full/authenticated-only response fields: `effective.originChange`/`destinationChange`/
`identityChange` (each `null` when nothing of that kind has happened). `apps/web/src/map/
RunPopup.tsx` shows the "was X, changed at HH:MM" detail alongside the current values in the full
view; the reduced (anonymous) view is unchanged beyond now showing current values.

**openrail (`C:\Projects\openrail-master`) — implemented but not build/deploy-verified (see Known
limitations):**

- `livetrain.c` (`/rail/livetrain` detail page): the schedule table now strikes through calling
  points before a Change of Origin's new starting point, and the header strikes through a
  superseded TRUST id alongside the new one from a Change of Identity — both already-fetched by
  the existing message-log queries, now also applied to the schedule table/header rather than only
  logged. A Change of Location strikes through the original calling point and inserts the revised
  one as a new row below it (owner's explicit detail-page spec — the one surface that _does_ use
  strikethrough, unlike RLM's live map or openrail's own summary/board pages below).
- `liverail.c` (`SUMMARY`/`DEPART`/`PANEL` modes — the summary/departure boards `report_train_
summary` renders): the `destination` column (or, for a row where this station is where the train
  terminates, the "From `<origin>`" text) is overridden (no strikethrough) from a Change of Origin
  or an in-effect part-cancellation, mirroring the owner's spec for these board pages. The visible
  4-character headcode column is deliberately **not** replaced with a raw TRUST id on a Change of
  Identity — this codebase has no verified logic anywhere for deriving a display headcode from a
  TRUST id string, and guessing at one risked showing something actively wrong on a live board;
  instead, the movement-status lookup this function already does (used for the board's own
  on-time/late/cancelled indicator) now searches every id in the run's identity chain, the same
  real bug `currentRun.ts`'s `latestMovement` had — a status/movement report filed under a
  post-Change-of-Identity id was previously invisible to this board too.

Checklist:

- [x] `packages/database/src/runResolution.ts`: `fetchTrustChanges` (+ `TrustChangeSummary`/
      `TrustLocationChange` exports).
- [x] `apps/api/src/routes/currentRun.ts`: apply effective origin/destination/locations/identity;
      chain-aware `latestMovement` lookup; `originChange`/`destinationChange`/`identityChange`
      fields (full response only).
- [x] `apps/web/src/map/RunPopup.tsx`: display current values + "was X" change detail.
- [x] `docs/API_CONTRACT.md`, `docs/adr/0009`: documented.
- [x] `openrail-master/livetrain.c`: detail-page strikethrough (origin cutoff, location
      strike-and-insert, identity strike-and-replace).
- [x] `openrail-master/liverail.c`: `report_train_summary` origin/destination override +
      identity-chain-aware movement/status lookup (SUMMARY/DEPART/PANEL boards).

Tests: `packages/database` — existing `runResolution.test.ts` unaffected (pure-function cases only;
`fetchTrustChanges` is DB-integration, covered below); `apps/api/src/routes/
currentRun.integration.test.ts` — new `"TRUST change events reflected as the run's effective state
(docs/adr/0009)"` block: Change of Origin overrides `originTiploc`/`originChange`; a part-
cancellation overrides `destinationTiploc`/`destinationChange` and reverts once reinstated; Change
of Identity surfaces `identityChange` and a movement reported under the _new_ id is still found;
Change of Location replaces a calling point in place. `apps/web/src/map/RunPopup.test.tsx` — new
case asserting the full view shows the revised origin/destination/TRUST-id alongside what each used
to be. `pnpm run build:libs`, `pnpm --filter @railway/database run build`, `pnpm --filter
@railway/api run typecheck`, `pnpm --filter @railway/web run typecheck`, `pnpm exec eslint` (the
touched files), `pnpm exec prettier --check` (the touched files) all clean; full non-integration
`pnpm exec vitest run` green (537/537; two unrelated pre-existing tests — `places.test.ts`,
`vstp.test.ts` — flake under full-suite parallel load in this sandbox and pass individually,
confirmed unrelated to this change before and after).

**The `currentRun.integration.test.ts` additions could not actually be run in this environment** —
integration tests need a real, migrated Postgres (`DATABASE_URL`) and this sandbox has neither
Docker nor a local Postgres available. They're written to the same seeding patterns every other
case in that file already uses and pass typecheck, but need a real run (CI, or against a disposable
Postgres per `docs/adr/0002`'s bridge-testing recipe) before this milestone is fully trusted.

Known limitations:

- **The openrail (C) changes are unverified beyond visual review against the existing code.** This
  environment has no C compiler (`gcc` unavailable) and no access to build/run `openrail-master`'s
  CGI binaries, so `livetrain.c`/`liverail.c` were edited by close analogy to the surrounding
  (also-unverified-by-tooling, hand-rolled) code in the same files, but never compiled, linked, or
  exercised against a real `openrail-eps` database. Build (`make livetrain.cgi liverail.cgi`) and
  manual verification against real change-of-origin/id/location/cancellation data is required
  before deploying to the production CGI host.
- **openrail's `FULL`/`FREIGHT` combined arrival-and-departure board** (`report_train`, distinct
  from `report_train_summary`) was **not** updated in this pass — same class of change, deliberately
  held back to keep the unverifiable C surface smaller for the first review, rather than spreading
  risk across a fourth function. Follow-up once `report_train_summary`'s treatment has been
  confirmed correct against real data.
- `liverail.c`'s origin/destination override (unlike its movement/status lookup) checks only the
  activation's original `trust_id`, not the full identity chain — a Change of Origin or
  part-cancellation filed under a _post-Change-of-Identity_ id would be missed on these board
  pages. Narrower than the RLM/`livetrain.c` treatment, kept this way deliberately to limit how much
  unverifiable C changed in one pass; follow-up once this milestone's build is confirmed.
- Change of Location is matched to a calling point by STANOX→TIPLOC lookup, which (like every other
  such lookup already in this codebase) can be ambiguous when one STANOX legitimately maps to more
  than one TIPLOC (platform-level TIPLOCs sharing a station STANOX) — an existing, accepted
  imprecision, not one this change introduces.
- The identity-chain walk is bounded to 8 hops as a cycle-safety measure, not a believed real limit
  — no chain anywhere near that long has been observed.

### Addendum (2026-09-17): a Change of Identity can change the run's own headcode — resolver fix, not just display

Owner correction against the first pass above, backed by a real example from the owner's own
`openrail` instance and a real resolver failure the owner had already hit: docs/adr/0010. Two
things this milestone's first pass got wrong or missed entirely —

1. `livetrain.c`'s message log "Change ID" row should never be struck through (reverted to plain
   text) — the struck-through-old/new treatment belongs on the page's own `<h2>` title instead,
   showing the _headcode_ change (decoded from the TRUST id), not the raw TRUST id itself.
2. TRUST's 10-character id encodes the run's own 4-character headcode within it (`426C02C417` ->
   `420C02C417` is headcode `6C02` -> `0C02`) — and the RLM resolver's headcode/position search
   (ADR 0006) had no way to find a run once its headcode changed this way, since
   `cif_schedules.signalling_id` never retroactively updates. Confirmed by the owner as a _real,
   already-observed_ false match, not a hypothetical: "it matched to a totally different 0C02
   elsewhere."

Fixed: `packages/domain/src/trust/trustId.ts` (`headcodeFromTrustId`, +tests);
`packages/database/src/runResolution.ts` (`findSchedulesByIdentityHeadcodeChange`, merged into
`resolveFreshRunMatch`'s candidate pool); `EffectiveIdentityChange`/`fetchTrustChanges` gain
`previousHeadcode`/`newHeadcode`; `RunPopup.tsx` shows it. openrail: `livetrain.c`'s message log
reverted (no strikethrough), its `<h2>` title gains the struck-through-old/new headcode instead;
`liverail.c`'s board pages now also override the displayed headcode column (previously deliberately
left alone, pending exactly this verification).

Tests: `packages/domain` — `trustId.test.ts` (the real example + length-guard cases).
`apps/api/src/routes/currentRun.integration.test.ts` — new `"a Change of Identity can change the
run's own headcode... (docs/adr/0010)"` block: the real 6C02→0C02 scenario now matches correctly
via `trust_activation`; a genuine coincidental collision (both activated) now reports `ambiguous`
rather than silently matching the wrong train; `identityChange.previousHeadcode`/`newHeadcode`
surfaced correctly once matched. `apps/web/src/map/RunPopup.test.tsx` — updated case asserts the
decoded headcode change is shown. `pnpm --filter @railway/domain run build`, `pnpm --filter
@railway/database run build`, `pnpm --filter @railway/api run typecheck`, `pnpm --filter
@railway/web run typecheck`, `pnpm exec eslint`/`pnpm exec prettier --check` (touched files) all
clean; `RunPopup.test.tsx`/`trustId.test.ts` pass. As with the rest of this milestone, the new
integration test cases could not actually be run (no Postgres in this environment), and the
openrail (C) corrections could not be compiled here either — see the parent milestone's own "Known
limitations" for both caveats, which still apply.

**Update, same day:** both caveats above no longer apply to this addendum specifically — CI ran the
new integration tests for real (catching and fixing two real test-isolation/assertion bugs, not a
resolver bug — see the commit history) and compiled the openrail changes cleanly (zero new compiler
warnings against the edited code). Still no runtime verification against a real `openrail-eps`
database for the C side; see the parent milestone's own "Known limitations."

### Second addendum (2026-09-17): a Change of Location revising the origin/destination point is an origin/destination change too

Owner report against a real train (`W32435`): its last calling point (`NY DBS`) was changed via a
Change of Location to `Carlisle Kingmoor Sidings (DRS)` — and being the schedule's own final
calling point, that's a destination change, not merely a revised mid-journey stop. Confirmed by the
owner as symmetric for the origin point too. Full record: docs/adr/0011.

Fixed: `fetchTrustChanges` (`packages/database/src/runResolution.ts`) gains
`originTiploc`/`destinationTiploc` parameters, matches `trust_changelocation` rows against them,
and picks the later of that and the existing `trust_changeorigin`/part-cancellation mechanisms.
openrail: `livetrain.c`'s `<h2>` title gains the same origin/destination merge (previously untouched
by any of this milestone), and its "Signalling ID" row (distinct from the title) now also gets the
struck-through-headcode treatment; `liverail.c`'s board-page origin/destination override gains the
same boundary-matching check.

Tests: `apps/api/src/routes/currentRun.integration.test.ts` — two new cases (destination via the
real NY DBS→Carlisle Kingmoor Sidings scenario; origin, symmetrically). `pnpm --filter
@railway/database run build`, `pnpm --filter @railway/api run typecheck`, `pnpm exec
eslint`/`pnpm exec prettier --check` (touched files), full non-integration `pnpm exec vitest run`
(539/539) all clean.

Known limitation (documented in docs/adr/0011, not fixed in this pass): unlike the TypeScript side,
the two C-side additions check the changelocation-boundary match _unconditionally after_ the
existing `trust_changeorigin`/cancellation check, not timestamp-compared against it — a same-
boundary event of the older kind arriving chronologically _after_ a changelocation event would
still lose to it on openrail's pages. Deliberately accepted to keep the uncompiled C surface small;
revisit only if a real case shows it mattering.

## Milestone 50 — combined berths for split-berth permissive-working groups (2026-09-17)

Owner request: some berths are a physical split trio/quad used for permissive working (e.g.
`EG0002 → EGC001 → EGB001 → EGA001`, almost immediately, with a second train then stacking behind
at B while A is occupied). There's often no room on the diagram to draw 3-4 separate berth boxes
for a group that's usually only one train deep — the ask is a single berth box that displays every
currently-occupied member joined together (e.g. "A001 B001"), settable in a few clicks in the
editor, kept a rare, explicit exception rather than the default berth shape. Max 4 members.

Design: a "combined berth" is 2-4 `tdBerth` bindings sharing one `elementId`, each carrying a new
optional `combinedOrder` (1-4) — the join order, not arrival order. Every member of a >1 group must
set a distinct `combinedOrder` (validate.ts's explicit-opt-in requirement, same precedent as
`allowDuplicate`/`inhibitedBy`); a lone binding must not set it at all. All the actual combining
logic (`joinCombinedBerthState`, `packages/domain/src/mapDelta/combinedBerth.ts`) lives in one
place: join every currently-occupied member's description in `combinedOrder`, space-separated;
report the most-recently-entered occupied member's `enteredAt` (a judgment call — several
reasonable choices exist since simultaneous occupants make "the" entered time ambiguous).

Kept the wire protocol and every renderer/client untouched: the join happens server-side, before a
`berth.updated`/`berth.cleared` delta is ever emitted, so playback (which replays the identical
wire shape), the SVG renderer, and the editor's Test-mode preview all just render
`berths[elementId].description` exactly as before — no protocol version bump.

Files changed:

- `packages/map-schema/src/document.ts` — `TdBerthBindingSchema.combinedOrder` (1-4, optional).
- `packages/map-schema/src/validate.ts` — combined-berth grouping rules (max 4, every member sets
  a distinct order, a lone binding must not).
- `packages/map-schema/src/compiler.ts` — `CompiledMapBundle.berthBindingOrder` (`tdArea|berth` →
  `combinedOrder`), optional at the type level since a map version published before this field
  existed has no such key in its immutable `compiled_runtime_bundle` (rule 11) — every reader
  treats a missing bundle-level `berthBindingOrder` the same as an empty one.
- `packages/domain/src/mapDelta/combinedBerth.ts` (new) — `joinCombinedBerthState`, the one shared
  join implementation.
- `apps/api/src/lib/liveState.ts`, `packages/database/src/mapStateReconstruction.ts` — both had the
  same latent bug: looping `Object.entries(berthBindingIndex)` and assigning `berths[elementId]`
  per key silently let the last key processed clobber every earlier member sharing that element.
  Both now group by `elementId` first and join. (`mapStateReconstruction.ts` duplicates the tiny
  join function locally rather than importing `@railway/domain`, keeping `@railway/database` a
  leaf package per its own existing header comment.)
- `apps/api/src/lib/reconstructState.ts`, `apps/worker/src/mapProjector/snapshotMaps.ts` — thread
  `berthBindingOrder` through to the reconstruction call.
- `packages/database/migrations/0034_map_binding_index_combined_order.sql` — `combined_order`
  smallint column (1-4 check) + `(map_version_id, element_id)` index for the live-delta lookup
  below.
- `packages/map-publish/src/mapBindingIndex.ts` — writes `combined_order` from the compiled bundle.
- `apps/worker/src/mapProjector/combinedBerthOverrides.ts` (new) — for a just-changed berth bound
  to a combined-berth element, looks up every sibling member's current `berth_current_state` and
  returns the joined `{description, enteredAt}` to override in the outgoing delta.
- `apps/worker/src/mapProjector/deltaBuilder.ts` — `buildDeltaMessages` takes an optional
  `combinedOverrides` map; falls back to the raw change untouched when absent (every ordinary,
  non-combined binding).
- `apps/worker/src/mapProjector/projector.ts` (`runProjectMapDeltas`, the slower/authoritative
  delta publisher) and `apps/worker/src/td/liveProjector.ts` (`publishBerthDeltas`, the ADR 0003
  hot path) both call `computeCombinedOverrides` before building messages — both publish the same
  underlying events, so both needed the fix or the hot path's correct combined text would get
  overwritten moments later by the slower path's stale single-member one.
- `apps/api/src/live/pollingDeltaSource.ts` — the dev/simple polling adapter had the identical
  per-key overwrite bug; `groupByElement` fixes it for both the diff/emit loop and the initial
  per-subscriber seed.
- `apps/web/src/map/MapRenderer.tsx` — the click-a-berth-for-run-popup reverse lookup
  (`elementIdToBinding`) had the same "last key wins" pattern; now deterministically picks the
  lowest `combinedOrder` (member 1) so clicking a combined berth always asks about the same
  physical berth rather than whichever key happened to iterate last.
- `apps/web/src/editor/commands.ts` — new `setCombinedBindings` command (replaces the whole binding
  group sharing an `elementId` in one commit, so undo restores the prior group in one step).
- `apps/web/src/editor/PropertyPanel.tsx` — `BindingFields` now takes every binding sharing the
  selected element (not just one); a "+ Combine with another berth" button adds up to 3 more
  member rows (TD area/berth, each independently committed on blur), with per-row Remove.
- `apps/web/src/editor/TestModePanel.tsx` — Simulated-mode preview (`keyToPreview`) had the same
  per-binding overwrite bug; now groups by element and calls `joinCombinedBerthState`. Live-mode
  preview needed no change (it polls the already-fixed `/state` endpoint).
- Tests: `packages/domain/src/mapDelta/combinedBerth.test.ts` (new),
  `packages/map-schema/src/validate.test.ts`/`compiler.test.ts` (new cases),
  `apps/worker/src/mapProjector/deltaBuilder.test.ts`/`combinedBerthOverrides.test.ts` (new file),
  `apps/api/src/routes/maps.test.ts` (new combined-berth `/state` case),
  `apps/web/src/editor/commands.test.ts`/`PropertyPanel.test.tsx` (new cases).

Acceptance criteria: an author can add 2-4 TD bindings to one berth element from the Properties
panel alone; when 2+ of those physical berths are occupied at once, the live map (and playback, and
the editor's Test-mode preview) show all of their descriptions joined in one box, in the
author-declared order; an ordinary, non-combined berth is completely unaffected (same behavior,
same one query per delta as before).

Tests run: `pnpm run typecheck` (all 10 packages/apps clean), `pnpm run test` (562/562, including
the new cases above), `pnpm exec prettier --check` (touched files clean — 7 pre-existing warnings
elsewhere untouched by this change).

Migrations: `0034_map_binding_index_combined_order.sql` (additive: nullable column + check
constraint + index — no backfill needed, no lock risk on the small `map_binding_index` table).

Known limitations / follow-up: no visual indicator in the editor canvas itself that a berth is
combined (only the Properties panel shows it) — low priority since this is meant to stay a rare
exception. `enteredAt`'s "most-recently-entered" tie-break is a judgment call, not confirmed against
a real multi-train scenario yet. The click-a-berth run popup only ever asks about the lowest-order
member; showing per-member run info for a combined berth is deferred.

### Addendum (2026-09-17): dashed editor outline, every member shown in the run popup, sticky close button

Follow-up owner feedback closed the two deferred items above and fixed an unrelated popup nuisance:

1. **Editor-only dashed outline.** A combined berth's `Rect` in `EditorCanvas.tsx` gets a dashed
   stroke (`dash={[4, 3]}`, only when 2+ `tdBerth` bindings share the element) so the author can
   spot a split-berth group at a glance without opening the Properties panel. Public
   `MapRenderer.tsx` is deliberately untouched — scoped to "in the editor" per the request.
2. **Every occupied member in the run popup**, not just the lowest-order one. Owner was offered a
   picker (show one member, let the visitor switch) or all members shown successively with a
   divider; went with the latter — no extra click, nothing hidden. `RunPopup.tsx` restructured:
   the fetch/poll loop for every member now lives in `RunPopup` itself (one effect, keyed on a
   stable `membersKey` string so remounts aren't required to react to a different berth), and a
   new pure `RunPopupMemberSection` renders one member's detail with a heading (`tdArea berth`)
   only shown when there's more than one. A CSS adjacent-sibling rule
   (`.map-inspector__member + .map-inspector__member`) draws the divider only between two
   _actually-rendered_ member sections — a vacant member renders nothing at all (not a hidden
   placeholder), so the divider count self-corrects as members come and go while the popup is
   open. The whole popup still closes once every member has gone vacant, matching the original
   single-berth "close quietly" behaviour; a single vacant member among several just drops its own
   section. `MapRenderer.tsx`'s `elementIdToMembers` now collects every member per element
   (previously `elementIdToBinding` kept only the lowest-order one).
3. **Sticky popup close button.** `.map-inspector--run`'s title bar is `position: sticky; top: 0`
   inside the popup's own scrolling box (previously the whole box, title included, scrolled
   together, so a long combined-berth popup could scroll the close button out of view).

Files: `apps/web/src/editor/EditorCanvas.tsx`, `apps/web/src/map/RunPopup.tsx`,
`apps/web/src/map/MapRenderer.tsx`, `apps/web/src/styles.css`. `RunPopupProps.tdArea`/`berth`
still work unchanged for every existing single-berth caller — `members` is additive.

Tests: `RunPopup.test.tsx` (+3: successive multi-member display, a vacant member quietly omitted
without closing, closes once every member is vacant), `MapRenderer.test.tsx` (+1: combined-berth
click opens a popup with both members). `pnpm run typecheck` clean, `pnpm run test` 566/566,
`pnpm exec prettier --check` clean on every touched file.

## Milestone 51 — admin "Query Berths" tool (2026-09-17)

Owner request: a self-service replacement for repeatedly asking for a one-off manual SQL query
against `td_berth_event` — an admin-only page under a new "Berths" nav item where the owner can
pick one or more TD areas, a headcode, and a date/time range, and get every matching berth step
back in time order (from/to berth, step type), instead of going through chat each time.

Design: a new admin-gated `GET /api/v1/admin/berths/query` route reads `td_berth_event` directly
(not the `berth_occupancy` projection the existing `/api/v1/descriptions/:description/history`
route reads) so results show every individual CA/CB/CC/CT step, not just resulting occupancy
intervals. `tdAreas` (comma-separated, required, at least one) and `headcode` (matched against
`description`, required) are both mandatory — the area filter keeps the query on
`td_berth_event_area_idx (td_area, event_at desc)` (migration 0006) rather than scanning
nationwide, and ordering by `event_at` (not a global sequence column) means the query-plan pitfall
already on file for this table doesn't apply here. `from`/`to` reuse the existing bounded-range
helper (`parseTimeRange`, max 7 days, defaults to the last 7 days), and results are cursor-paginated
like the other history routes.

The web app gets a new "Berths" nav item (admin only, same gate as "Users"/"TD boundaries") that
opens a hub page (`/admin/berths`, `AdminBerthsPage.tsx`) rather than jumping straight to the tool —
deliberately, so tooling added under "Berths" later doesn't need a new top-level nav entry each
time. Its one current link goes to "Query Berths" (`/admin/berths/query`, `BerthQueryPage.tsx`): a
multi-select of TD areas (populated from the existing `GET /api/v1/td/areas`), a headcode field,
and `datetime-local` from/to fields, submitting to the new route and rendering results in a table
(reusing the existing `.admin-users-page`/`.users-table`/`.panel-card`/`.field` classes so the page
matches the rest of the admin section) with a "Load more" button for pagination.

Files changed:

- `apps/api/src/routes/admin/berthQuery.ts` (new), `apps/api/src/routes/admin/
berthQuery.integration.test.ts` (new) — the query route and its integration test (fixture rows
  via the existing `testSupport/tdEvents.ts` helper).
- `apps/api/src/server.ts` — registers the route in its own `requireRole("admin", ...)`-gated scope,
  same pattern as the TD-boundaries/admin-map scopes.
- `apps/web/src/useRoute.ts`, `apps/web/src/useRoute.test.ts` — `/admin/berths` and
  `/admin/berths/query` routes.
- `apps/web/src/App.tsx`, `apps/web/src/App.test.tsx` — admin gate for both new routes, "Berths" nav
  link (active for either route), page wiring.
- `apps/web/src/auth/AdminBerthsPage.tsx` (new, + test) — the "Berths" hub page.
- `apps/web/src/auth/BerthQueryPage.tsx` (new, + test) — the query tool itself.
- `apps/web/src/styles.css` — `.admin-berths-page__tools` (hub link list), `.berth-query-page`
  (wider max-width than the shared 720px admin column, for the six-column results table).
- `docs/API_CONTRACT.md` §4a — documents the new endpoint.

Acceptance criteria: only an admin session sees the "Berths" nav link or can reach either new route
(a non-admin or logged-out visit redirects, matching every other `/admin/*` route); searching
requires at least one TD area and a non-empty headcode; results are raw berth-to-berth steps in
ascending time order, scoped to exactly the requested area(s)/headcode/range; nationwide capture
and every other admin page are unaffected (additive routes/nav only).

Tests run: `pnpm run typecheck` (all packages/apps clean), `pnpm exec vitest run` (571/571, full
unit suite, including the new `useRoute`/`App`/`AdminBerthsPage`/`BerthQueryPage` cases),
`pnpm exec prettier --check` clean on every touched file. The new integration test
(`berthQuery.integration.test.ts`) was written against this session's real fixture helper but not
executed here — no local `DATABASE_URL`/Postgres was available in this environment; run
`pnpm run test:integration` against a real database before merging.

Migrations/configuration: none — no schema change, reuses existing `td_berth_event` columns and
indexes.

Known limitations / follow-up: no CSV/export option; no saved/recent searches; the TD-area picker
is a plain multi-select rather than a searchable/checkbox list (fine at the current ~dozens of
observed areas, may want revisiting if that grows much further).

## Milestone 53 — multi-line station names and a neutral section symbol (2026-09-20)

Two owner requests in one editor pass.

**Multi-line station names.** `station.name` now stacks on `\n` the way `label.text` always has —
asked for "for spacing reasons" on a crowded schematic. The public SVG renderer already split the
name into `<tspan>`s, and Konva wraps natively, so the gap was purely in authoring: the Properties
panel's **Name** field was a single-line input with no way to enter a newline at all. It is now a
textarea, with a hint that the `[CRS]` suffix lands on the last line. The berth panel's station
picker flattens newlines to spaces, since a `<option>` renders them as one run of text.

**Neutral sections.** A new `neutralSection` element type and matching tool, drawn as Sign AJ02
Issue 1 ("Neutral Section Indication Board", RSSB, June 2015 — the PDF the owner supplied): a
white rounded square with the black two-bar symbol, reproduced to the drawing's own 600-unit
dimensions. `MAP_STYLE.neutralSection` holds those dimensions as fractions of 600 and
`neutralSectionGeometry` turns them into the board rect, four symbol rects and a label anchor, so
both renderers draw one identical sign from a single source (rule 13). The board defaults to 20
map units — two squares of the default grid, per the owner's follow-up — and `size` is editable
per sign. Display only: no binding, no live state, nothing inferred (rules 9/10). This is
explicitly the generic shape for the lineside-feature family the owner has flagged next (tunnels,
viaducts, signal boxes).

Files changed:

- `packages/map-schema/src/style.ts` — `MAP_STYLE.neutralSection` (AJ02 dimensions, colours,
  default size 20); `MAP_CSS_TOKENS.neutralSectionBoard`/`neutralSectionSymbol`.
- `packages/map-schema/src/geometry.ts` (+ test) — `neutralSectionGeometry`, shared by both
  renderers.
- `packages/map-schema/src/document.ts` (+ test) — `NeutralSectionElementSchema` in the element
  union; a doc comment recording that `station.name` is newline-aware.
- `packages/map-schema/src/index.ts` — new exports.
- `apps/web/src/map/MapRenderer.tsx` (+ test) — `renderNeutralSection`.
- `apps/web/src/editor/EditorCanvas.tsx` (+ test) — Konva sign rendering, tool default element,
  Labels-layer hint, board-sized `elementBounds` for rubber-band select.
- `apps/web/src/editor/EditorState.tsx`, `ToolPalette.tsx` — the `neutralSection` tool.
- `apps/web/src/editor/PropertyPanel.tsx` (+ test) — station Name textarea, flattened station
  picker, the neutral-section form; `NumberField` gained an optional `min` that snaps a rejected
  entry back to the stored value instead of leaving the field showing a number the document never
  took.
- `apps/web/src/styles.css` — the two new colour tokens.
- `docs/MAP_EDITOR_SPEC.md` — the `neutralSection` section and the station multi-line rules.

Acceptance criteria: a station name containing newlines renders as stacked centred lines in both
the public map and the editor, with `[CRS]` on the last line, and is editable in the Properties
panel; the neutral section tool places a sign whose geometry matches the AJ02 drawing exactly at
any `size`; both renderers draw it identically from the shared helper; the element carries no
binding or live state and no ingestion/projection path is touched.

Tests run: `pnpm run typecheck` (clean), `pnpm exec vitest run` (full unit suite), plus a
geometry test that asserts the computed board/bars against Sign AJ02's own published dimensions.

Migrations/configuration: none — additive element type in the canonical document only. Already
published immutable map versions are unaffected (rule 11); drafts saved before this parse
unchanged.

Known limitations / follow-up: the sign's label is single-line (use a separate `label` element for
more); there is no dedicated lineside-feature layer yet, so signs land on Labels; tunnels,
viaducts and signal boxes are not implemented — they should reuse this element's generic shape.

## Later / unscheduled

Smaller pre-existing deferred items not yet worth their own milestone:

- Editor MVP gaps: align/distribute tools, 45°-constrained/magnetic track drawing,
  grouping/templates, a keyboard-shortcut help overlay, a locked reference-image layer, true
  multi-point polylines, retroactive angle-snap on existing tracks, a dedicated platform-shape
  template, auto-linking `platformNumber.platformId` on placement.
- `applyRenameElement` doesn't rewrite `inhibitedBy`/`stationId` on rename — known gap since
  Milestone 21, silently orphans references.
- No live drag feedback / no multi-node Transformer box for multi-select group-move — cosmetic
  only.
- Dedicated schedule/run/berth-history web pages (currently just the inline popup + raw API
  identifiers).
- `signal.updated` WS message — listed in the API contract as future, unimplemented.
- Freshness threshold (`FRESHNESS_THRESHOLD_MS`) as configuration instead of a hardcoded constant.
- Weekly (from monthly) time partitions; partitioning the garner `trust_movement` mirror on
  `created`.
- Physical/WAL backups and external archive replication (may fold into Milestone 13).
- Horizontal worker scaling, if measured load ever requires it.
- Bulk binding import and binding-discovery assistance.
- Taking the S3/MinIO archive PUT off the `ingest-td` hot path (ADR 0003 consequences,
  Milestone 17) — needs an ADR decision on reordering archive-before-ack; only worth it if
  sub-200ms live-ingest latency is ever actually needed.
- **Known current duplication, not yet resolved (found 2026-09-13):** CORPUS/SMART reference
  data is synced by _two_ independent, still-active mechanisms — the `schedule-reference-refresh`
  daemon (Milestone 7's `download-corpus`/`download-smart`, still running as its own Portainer
  service) and `ingest-garner`'s own `runGarnerReferenceSync` (Milestone 15). Both write to the
  same `location_reference`/`smart_berth_step` tables. Harmless today (idempotent upserts), but
  worth a deliberate decision (keep one as a fallback for the other, or retire one) rather than
  leaving it as an accident.
