# Bounded Implementation Plan

Do not ask Claude to build the entire product in one task. Complete and verify one milestone before moving on.

## Execution order

Milestone numbers below are stable labels (referenced by code comments throughout the repo,
e.g. `berth_occupancy.resolution_status`'s "Milestone 9" note, `/api/v1/maps/{slug}/state`'s
"Milestone 10" 501 message) — not a mandated sequence. Actual implementation order:

**0 → 1 → 2 → 3 → 4 → 5 → 6 → 11 → 12 → 7 → 8 → 9 → 10 → 13 → Later milestones**

M11 (visual editor MVP) and M12 (editor publishing workflow) were moved ahead of M7–M10:
both only depend on M4 (nationwide observed TD area/berth discovery) and M5 (canonical map
schema/compiler) — already done — not on schedule/TRUST/resolver/playback data, so moving
them up lets maps be authored and published through the editor instead of hand-edited JSON
plus the `publish-map` CLI. M12's "historical" test mode is the one piece that wants M10
(playback) — stub or defer just that part until M10 actually lands.

M14 (renderer visual polish/theming) is intentionally not placed in the chain above: it's
purely visual, blocks nothing, and is waiting on the owner to pick a style direction (see its
section below) before it should start — slot it in wherever makes sense once that happens.

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
`schedule_location` directly (VSTP is incremental: Create/Overwrite upsert by natural key,
Delete removes the matching row — no staging/swap needed). `apps/worker/src/schedule/
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
gated behind `SCHEDULE_DOWNLOAD_ENABLED` (default false) and untested against the live NR
endpoints in this environment — only the file-path `import-*` commands are exercised by the
integration suite. `ingest-vstp`/`project-vstp` are similarly gated behind
`VSTP_LIVE_ENABLED`. Known limitation: `location_reference` upserts never remove a TIPLOC
absent from a newer CORPUS extract (an intentional "upsert in place, no delete-and-swap"
design choice for this smaller dataset, not an oversight).

## Milestone 8 — nationwide TRUST runs and activation linkage

- TRUST parser for supported message types.
- Store every nationwide TRUST event.
- Train-run lifecycle tables.
- Exact activation-to-schedule link.
- Identity/change/cancellation handling.
- Latest report projection and nationwide run query.

Done when fixtures for unrelated regions and Lancaster are both retained and correctly linked without rewriting history.

**Status: implemented.** Migration `0015_train_run_tables.sql` (renumbered from the plan's
original "0014" — 0011/0012–0014 were inserted ahead of it by the reprioritized M11/M12/M7
execution order): `train_run` (uuid PK, `unique(trust_train_id, service_date)`),
`train_run_event` (partitioned by `raw_event_normalized_at_utc`, composite FK to
`raw_feed_event`, added to `ensurePartitions.ts`'s `PARTITIONED_TABLES`), `run_schedule_link`
(one row per run, `match_outcome` reusing the exact `matched`/`ambiguous`/`unmatched`
vocabulary Milestone 9's resolver will also use). TRUST is the third STOMP feed, so it reuses
the shared broker connection/recorder generalized in Milestone 7 — no further refactor needed.
`packages/feed-parsers/src/trust/parseTrustFrame.ts` classifies on `header.msg_type` (all 8
supported types + unsupported/malformed, same never-zero-children triad as TD/VSTP); its wire
shape is constructed from public documentation, not a captured real message (same caveat as
the rest of this project — see the fixtures under `packages/feed-parsers/fixtures/trust/`).
`packages/domain/src/trust/runReducer.ts` is a pure effects-based reducer (mirrors
`td/berthReducer.ts`): Activation creates a run (idempotent on redelivery); Movement/Change of
Origin/Change of Location only advance `last_event_at`, and are a defensive no-op when no
matching run exists rather than fabricating one; Cancellation/Reinstatement toggle
`cancelled`/`activated` (no separate `reinstated` state — the Reinstatement is its own
`train_run_event` row, so nothing is lost); Change of Identity supersedes the old run
(`superseded_by_train_run_id`) and creates a new run under the revised identity, never
rewriting history in place; Unidentified Train creates a minimal run with no schedule link.
`packages/domain/src/trust/serviceDate.ts` computes the UK traffic day — **the exact boundary
hour (03:00 Europe/London) is a documented assumption, not verified against the real wiki
page**, same caveat style as the S-Class-decode gap. Schedule-link resolution
(`apps/worker/src/trust/projector.ts`) is deliberately not a reducer effect (it needs a DB
round trip against `schedule`): activation resolution runs immediately via
`resolveStpPrecedence`, and a **deferred-relink pass** re-attempts every non-`matched`
`run_schedule_link` row at the end of every `project-trust` run — `run_schedule_link` retains
`activation_train_uid` specifically so this re-resolution doesn't need to re-parse the original
activation event, and always updates the existing row in place, never re-inserts. New route
`GET /api/v1/runs/{runId}` / `GET /api/v1/runs/{runId}/schedule`
(`apps/api/src/routes/runs.ts`), documented in `docs/API_CONTRACT.md`; `resolverEvidence` is
always `null` until Milestone 9. `ingest-trust`/`project-trust` are gated behind
`TRUST_LIVE_ENABLED`, untested against a live broker in this environment — proven via fixture
replay and the integration suite instead. Known limitation: a Movement/Cancellation/
Reinstatement/Change of Origin/Change of Location message that arrives before its Activation
(a plausible out-of-order broker delivery scenario) is permanently skipped from
`train_run_event` — the raw message itself is still fully retained in `raw_feed_event`
regardless (nationwide retention is never affected), but there is no later-arriving-activation
backfill/retry mechanism in this MVP pass.

## Milestone 9 — berth-to-run resolver and popup

- Candidate generation/scoring.
- `matched`, `ambiguous` and `unmatched` states.
- Evidence and resolver version storage.
- Lancaster run popup and full schedule view.
- Latest TRUST variation with report age/location.
- Resolver works against nationwide run data while accepting map/corridor context as evidence.

Never claim exact continuous punctuality.

**Status: implemented.** Migration `0018_berth_run_resolution.sql` (per `docs/DATA_MODEL.md` §7:
`occupancy_id`/`selected_train_run_id`/`confidence`/`resolver_version`/`decided_at`/`candidates`
jsonb, one row per occupancy updated in place on re-resolution — mirrors `run_schedule_link`'s
own "retained fields, mutable outcome" pattern from Milestone 8) and `0019_...uuid.sql` (a
pre-existing bug fix found along the way: `berth_occupancy.resolved_run_id` was declared `bigint`
back in Milestone 4, before `train_run`'s uuid primary key existed, and had never actually been
written to). Pure scoring logic in `packages/domain/src/resolver/resolveBerthRun.ts` (mirrors
`schedule/resolveStpPrecedence.ts`'s DB-I/O-free style): candidate generation (exact
`signalling_id` + service-date match, never a superseded identity) is evidence #1, then a
weighted score from #2 (schedule-linked via `run_schedule_link`), #3 (temporal plausibility — see
its own known-limitation note below) and #5 (SMART berth→STANOX correlation via
`smart_berth_step`); an exact tie at the top score is `ambiguous`, never an arbitrary pick
(CLAUDE.md rule 5). New checkpointed worker projector (`apps/worker/src/resolver/projector.ts`,
`project-resolver` command, run from the Portainer `projector-backlog` service's loop alongside
`project-vstp`/`project-trust` — split from `project-td`'s own `projector-td` loop on 2026-08-10
so resolver/TRUST backlog work can never stall live berth positions) processes newly-
opened occupancies plus a bounded retry pass over still-open, not-yet-`matched` occupancies
(mirrors TRUST's deferred-relink pass). API: `apps/api/src/lib/liveState.ts`'s `BerthState.
runSummary` now carries a real `{status, text}` (was hardcoded `null`) — `text` is a short
Vail-like string built only from the matched run's latest real TRUST movement report, matching
`docs/PROJECT_SPEC.md`'s "TRUST is not a prediction feed" rule; new `GET /api/v1/td/areas/
{tdArea}/berths/{berth}/current-run` is the live map's click-a-berth popup in one round trip;
`GET /api/v1/runs/{runId}`'s `resolverEvidence` (hardcoded `null` since Milestone 8) is now
populated. Web: `apps/web/src/map/RunPopup.tsx` replaces `MapRenderer.tsx`'s old description-only
stub, rendering the full `docs/PROJECT_SPEC.md` §5 field list — an `ambiguous` result shows every
candidate, never a silently-chosen run, and `unmatched` shows the exact spec'd "No matching
activated schedule found" message.

Two real `project-td --rebuild` regressions surfaced while building this, both fixed in
`apps/worker/src/td/projector.ts`'s `clearProjectionRows`: `berth_run_resolution`'s new FK into
`berth_occupancy` made a rebuild fail the instant any occupancy had ever been resolved (now
cleared first — it's pure derived state, safe to delete); `operator_berth_action`'s FK (from a
prior session's manual-clear feature, predating this milestone) had the exact same problem, fixed
differently since it's a permanent audit trail, not derived state — its dangling occupancy
reference is nulled out, the audit row itself is preserved.

Known limitations (deliberate scope decisions, not gaps to silently paper over):

- Evidence #4 (continuity from a preceding berth's resolved run) and #7 (operator/direction
  consistency) are not implemented — no ground-truth signal to score them against without #6.
- Evidence #6 ("a selected map or queried corridor's TIPLOC/STANOX coverage") is satisfied via
  SMART/STANOX correlation to the specific berth being resolved, not by consulting the live map
  document a berth happens to be published on — the resolver stays fully nationwide/map-
  independent per CLAUDE.md's "map scope must never be used as an ingestion filter."
- Temporal plausibility (evidence #3) is a day-level check against `train_run.activated_at`, not
  per-calling-point precision — `schedule_location`'s own times are raw CIF-style text, not
  parsed timestamps, and `train_run.origin_departure_at` (which would give an exact anchor) is
  never actually populated by the Milestone 8 TRUST projector (`apps/worker/src/trust/
projector.ts` hardcodes it `null` — a pre-existing gap, not something this milestone fixes).
- `berth.updated`/`berth.cleared` WebSocket deltas don't carry a live-refreshed `runSummary`
  (only the snapshot on connect/reconnect and the REST `/state` poll do) — the already-declared
  `run.resolution.updated` stub message type would be the clean way to add that, but nothing
  emits it yet (needs the map-delta projector to also watch `berth_run_resolution`).
- The popup shows "full schedule" inline (expandable within the same popup) rather than a
  separate routed page, and links out to run/berth history as identifiers rather than clickable
  pages — those pages don't exist yet on the web frontend, only as API endpoints.

## Milestone 10 — snapshots and playback

- Periodic map snapshots.
- Point-in-time state reconstruction.
- Compact map playback event endpoint.
- Seek, pause, steps, speeds and return-to-live UI.
- Map-version selection by effective time.
- Data-gap warnings.

Acceptance: repeated requests for the same time/version produce the same state and source sequence.

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

## Milestone 13 — operational hardening

- Public status page.
- Feed/archive/database/projection metrics and alerts.
- Rate limiting and security headers.
- Private editor/diagnostic access.
- PostgreSQL and object-archive backups.
- Documented restore and raw-event reprocessing test.
- Log rotation and storage monitoring.
- Multi-day soak test using captured nationwide feed volume.
- Non-safety-critical notices and licence attribution.

## Milestone 14 — public renderer visual polish and theming

Owner reviewed reference examples (2026-08-05) of two quite different professional signalling-panel
aesthetics — a modern flat/dark control-room look (colour-coded berths, crisp "set route" vs
unset track highlighting) and a retro monochrome CRT mimic-panel look (pure black background,
green-on-black track/text) — and asked to pencil this in as a future milestone rather than pick a
direction yet. Do not start this milestone until the owner has chosen a direction; open questions
to resolve first:

- Visual style direction: modern flat/dark panel, retro monochrome CRT, or a deliberate blend.
- Track rendering: junction/points glyphs, directional arrow ticks, "set" vs "unset" route
  highlighting (relevant mainly for the modern-panel direction).
- Berth box colour semantics beyond today's binary occupied/vacant (candidates raised: colour by
  TD area — relevant now that Lancaster spans both `PX` and `CL` — or something else entirely).
- Station/area label typography and layout conventions.

Deliverables once a direction is chosen:

- A style-tokens/theme file (colours, stroke widths, fonts, symbol glyphs as a single editable
  source) so visual tweaks don't require touching `MapRenderer.tsx`'s component logic — the first
  step toward "easily edit assets for continual improvement," independent of whether M11's editor
  UI exposes it yet.
- Reworked track/junction/signal/berth rendering to match the chosen direction.
- Once M11 (visual editor) exists: expose the relevant theme/asset choices through the editor UI
  rather than requiring a code change for every tweak.

Purely visual/UX — not a blocker for any other milestone, safe to defer indefinitely. Reference
inspiration only, per CLAUDE.md non-negotiable #14 (no scraping Vail Data/Traksy/OpenTrainTimes).

## Later milestones

- Additional authored/public maps using already-retained nationwide history.
- S-Class blank/on/off bindings for areas where usable data exists.
- Map continuation/follow-train behavior.
- Bulk binding import and binding-discovery assistance.
- Physical/WAL backups and external archive replication.
- Horizontal worker scaling if measured load requires it.
