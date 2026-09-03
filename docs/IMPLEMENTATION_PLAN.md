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
its own known-limitation note below), #3b (live movement-report correlation — a candidate run's
own TRUST `movement` events, by reported `loc_stanox`, placing it at this berth's SMART STANOX
within ±8 min of the occupancy; added 2026-08-27, see the known-limitation note below), #4
(continuity) and #5 (SMART berth→STANOX correlation via `smart_berth_step`); an exact tie at the
top score is `ambiguous`, never an arbitrary pick (CLAUDE.md rule 5). New checkpointed worker projector (`apps/worker/src/resolver/projector.ts`,
`project-resolver` command, run from its own Portainer `projector-resolver` service loop — split
from `project-td`'s `projector-td` loop on 2026-08-10 so resolver/TRUST backlog work can never
stall live berth positions, then split a second time on 2026-08-11 from `project-vstp`/
`project-trust`'s `projector-schedule` loop after resolver's own internal batch loop was observed
starving them of turns) processes newly-opened occupancies plus a bounded retry pass over
still-open, not-yet-`matched` occupancies
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

`berth_run_resolution.candidates` only ever stores a bare `{trainRunId, score, confidence,
reasons}` per candidate (packages/domain/src/resolver/resolveBerthRun.ts's `ScoredCandidate`) — no
human-readable identity, since storing it redundantly on every resolution row would only ever go
stale. 2026-08-11: real production feedback that the popup's ambiguous-candidate list showing bare
UUIDs was "useless" led to enriching candidates at _read_ time instead — `apps/api/src/routes/
currentRun.ts` now batch-queries `train_run` LEFT JOIN `schedule` for every candidate's
`trainRunId` and adds `signallingId`/`trustTrainId`/`trainUid` (headcode / TRUST reporting id /
schedule UID, per the user's explicit preference over service code) fetched fresh on each request;
`apps/web/src/map/RunPopup.tsx` renders `UID · headcode · TRUST id` (falling back to the raw
`trainRunId` only if all three are unresolved, e.g. a since-deleted `train_run`).

Two real `project-td --rebuild` regressions surfaced while building this, both fixed in
`apps/worker/src/td/projector.ts`'s `clearProjectionRows`: `berth_run_resolution`'s new FK into
`berth_occupancy` made a rebuild fail the instant any occupancy had ever been resolved (now
cleared first — it's pure derived state, safe to delete); `operator_berth_action`'s FK (from a
prior session's manual-clear feature, predating this milestone) had the exact same problem, fixed
differently since it's a permanent audit trail, not derived state — its dangling occupancy
reference is nulled out, the audit row itself is preserved.

2026-08-14: a real Postgres `deadlock detected` (40P01) hit `project-td` in production —
`project-td`'s per-batch transaction updates several `berth_occupancy` rows in TD message arrival
order (a single CA event alone can close two occupancies, from- and to-berth), while
`project-resolver`'s batches update rows in ascending `id` (main phase) or `decided_at` (retry
phase) order; two concurrent multi-row transactions acquiring row locks in different orders can
deadlock at the Postgres level even though neither projector has any _logical_ dependency on the
other's data. Fixed with a new shared transaction-scoped mutex, `apps/worker/src/shared/
advisoryLock.ts`'s `BERTH_OCCUPANCY_WRITE_LOCK_KEY` (`pg_advisory_xact_lock`, auto-released on
commit/rollback) — both `runProjectTd`'s batch transaction and `runProjectResolver`'s main-phase
and retry-phase transactions now take it immediately after `BEGIN`, before touching any
`berth_occupancy` row. Deliberately scoped to one batch transaction rather than held for a whole
run, so it can't reintroduce the latency coupling `projector-td`/`projector-resolver` were split
into separate services to avoid (docs/ARCHITECTURE.md's "initial containers" section) — it only
ever serializes the two loops for the duration of one short transaction each, and does nothing at
all when there's no contention. Postgres's own deadlock handling meant no data was left
inconsistent by the incident itself: the checkpoint advance sits inside the same transaction as
the row effects, so a rolled-back deadlock victim just reprocesses the same batch cleanly on the
shell loop's next tick.

2026-08-27: that "brief" assumption turned out to be wrong for `project-resolver` specifically,
discovered live in production during a post-redeploy backlog: acquiring the lock immediately after
`BEGIN` meant it was held through `fetchBatchCandidateData` too — a read-only query (continuity
seeding, schedule/SMART lookups) that can run for many seconds of disk I/O under real backlog
load, but never writes to `berth_occupancy` and so never needed the lock at all. `project-td`'s
checkpoint commits went from sub-second apart to 16+ seconds apart, which is what "the map is
running behind" actually traced back to. Fixed by moving the lock acquisition into `resolveBatch`,
after `fetchBatchCandidateData` returns and immediately before the per-occupancy writes — the
correctness guarantee (no write to `berth_occupancy` outside the lock) is unchanged, only the
window during which project-td can be blocked shrank to just the actual write phase.

Same day, a further production observation: `runProjectResolver` had no self-exclusion advisory
lock at all (unlike `project-td`), relying entirely on the assumption that the `projector-resolver`
service's own `while true; do node dist/index.js project-resolver; sleep 1; done` loop guarantees
only one invocation runs at a time. That guarantee only holds _within_ one container's lifetime —
a Portainer redeploy doesn't guarantee the old container's process has fully exited before the new
one's loop starts. Live `pg_stat_activity` snapshots caught exactly this: three concurrent
connections all running `runProjectResolver`'s own batch-select query at once, with no zombie
transaction or code-level double-invocation to explain it (a full repo-wide investigation — every
compose file, the dispatch table, the command wrapper, the function's own internal loop, health
checks, worker_threads/child_process/cluster usage — turned up nothing; see this section's own
history for the fuller "everything checked out clean" writeup). Fixed by giving `project-resolver`
the exact same self-exclusion lock `project-td` already has (`pg_try_advisory_lock` for the whole
run, backing off with `skippedLockContention: true` rather than racing if another instance already
holds it) — structurally impossible for two instances to run concurrently now, regardless of what
triggers the overlap.

Known limitations (deliberate scope decisions, not gaps to silently paper over):

- Evidence #7 (operator/direction consistency) is not implemented — no ground-truth signal to
  score it against without #6.
- Evidence #4 (continuity from a preceding berth's resolved run) was added 2026-08-10 after real
  production data showed the gap: a headcode shared by two genuinely different same-day services
  ties on schedule-linked + temporally-plausible evidence whenever SMART/STANOX coverage (#5) is
  absent for a particular berth, and with no memory of the immediately preceding, already-`matched`
  occupancy of the same description, that produced a real train flipping to `ambiguous` for one
  step (sometimes many consecutive steps) before recovering. `packages/domain/src/resolver/
resolveBerthRun.ts` scores it via a new `recentContinuity` evidence field (weight 30, between
  temporal plausibility and SMART/STANOX per docs/DATA_MODEL.md §8's ordering);
  `apps/worker/src/resolver/projector.ts` seeds it from the most recent `matched`
  `berth_run_resolution` row for the same description within a 10-minute window and keeps it
  current as each batch resolves, so a chain of many ambiguous steps in a row self-heals from a
  single earlier match rather than needing SMART coverage at every one. `RESOLVER_VERSION` bumped
  1→2. Refined again 2026-08-11 after a live production case showed continuity itself
  over-correcting: a TD headcode gets set on a stabled unit well before TRUST fires the matching
  activation (sometimes 1-2+ hours ahead, for the unit's _next_ working), so a stale continuity
  chain from a genuinely different earlier train sharing the same headcode kept confidently
  winning long after that train's relevance had ended, instead of the honest `ambiguous`. Fixed
  two ways: continuity is now scoped per `(description, td_area)` rather than description alone
  (it was leaking nationwide — a match in one TD area could feed a same-description occupancy
  anywhere else in the country), and it's suppressed entirely whenever another candidate has a
  strictly more recent `activated_at` (a freshly-activated real train outranks a self-reinforcing
  chain). Relatedly, `apps/web/src/map/RunPopup.tsx` was fetch-once — a berth clicked right as a
  train arrived (the resolver's own decoupled loop, see `projector-resolver` in
  `deploy/docker-compose.portainer.yml`, can take a few seconds) would show "no match" forever
  even after the backend resolved it moments later; it now polls every 2s while open.
- Live movement-report correlation (evidence #3b) was added 2026-08-27 for the tie continuity
  can't reach: two genuinely different same-day workings of one headcode, both schedule-linked,
  both inside the 24h temporal window, both SMART-correlated (both routes call at the berth's
  STANOX), and neither with a preceding `matched` occupancy to chain continuity from — a dead
  tie that came out `ambiguous` even though only one of the two trains is physically reporting
  past the berth (the real observed `2C84` case). `packages/domain/src/resolver/resolveBerthRun.ts`
  scores it via a new `movementCorrelation` field, weight 45 — the highest single weight (enough
  to break an otherwise-perfect tie on its own), deliberately less than the sum of the others so
  one stray `smart_berth_step` row can't silently override a candidate that wins on every other
  signal. `apps/worker/src/resolver/projector.ts` sets it when the candidate run's own TRUST
  `movement` events (`train_run_event`, by reported `loc_stanox`) include the berth's SMART
  `to_berth` STANOX within ±8 minutes of the occupancy's `entered_at` — fetched once per batch
  alongside the existing candidate reads (a 6th fixed query, no per-occupancy round trip).
  `RESOLVER_VERSION` bumped 2→3. On deploy the new resolver checkpoint starts at 0, but the live
  window below means the loop only re-decides the last `RESOLVER_LIVE_WINDOW_HOURS` and catches
  up to "now" in seconds — `--rebuild` is _not_ needed and should be avoided (it reprocesses the
  entire retained history); use `--backfill --since <date>` if older history needs to be lifted
  to v3. Still gated on the exact-signalling-identity candidate set like every other signal
  (CLAUDE.md rule 5), and does not address the separate "no candidate at all" case (a TD headcode
  seen before its TRUST activation fires) — the open-occupancy retry pass already covers that.
- Resolver live-freshness window + `--backfill` added 2026-08-27, same change as #3b. The
  `project-resolver` forward scan and retry pass are bounded to `entered_at >= now() -
RESOLVER_LIVE_WINDOW_HOURS` (`apps/worker/src/config.ts`, default 72). Without it, a
  `RESOLVER_VERSION` bump (fresh checkpoint at sequence 0, forward scan `id`-ordered) makes the
  resolver grind oldest-first through ~14 days of retained _nationwide_ `berth_occupancy` before
  the live map reflects the current hour — today is processed last. This is a resolver-only
  freshness policy, not an ingestion/projection filter: raw capture and the TD/berth-occupancy
  projections stay fully nationwide and unfiltered (CLAUDE.md rule 17), the resolver output for
  older occupancies is retained (whatever version last decided it), and everything needed to
  resolve the full history is still on disk. `--rebuild` ignores the window (the deliberate
  full-history escape hatch). `project-resolver --backfill --since <YYYY-MM-DD>` resolves
  occupancies from that date forward that aren't already at `RESOLVER_VERSION` — a left join
  against `berth_run_resolution` rather than a checkpoint, so it's resumable and self-terminating;
  it runs under a **separate** advisory lock (`berth-run-resolver:backfill`) so an operator can
  catch history up alongside the 1s live loop instead of the two starving each other, with
  per-batch `berth_occupancy` writes still serialized by `BERTH_OCCUPANCY_WRITE_LOCK_KEY`. Re-run
  it until the summary's `moreBacklogRemains` is false.
- Deploying the first `RESOLVER_VERSION`-bumped build (v3, 2026-08-31) turned into a multi-hour
  incident because the window above bounds _how much_ work a bump costs but not the _order_ — the
  `id`-ordered forward scan still did the whole window oldest-first, so the current hour stayed
  unresolved while ~5M rows drained, and every manual checkpoint seed to "now" was immediately
  overwritten by a still-in-flight invocation's `advanceCheckpoint`. Two follow-up fixes so a
  future bump is a non-event: (a) `advanceCheckpoint` (`@railway/database`) is now **monotonic**
  (`greatest(last_ingestion_sequence, $2)`) — a stale or out-of-order write can no longer rewind a
  checkpoint an operator (or a concurrent process) moved ahead; `resetCheckpoint` stays the only
  sanctioned way back. (b) `runProjectResolver` calls `seedFreshResolverCheckpoint` when it finds
  a **never-advanced** checkpoint (`last_ingestion_sequence = 0` and `last_completed_at is null` —
  exactly a just-bumped version) and a finite `liveWindowMs`: it jumps the checkpoint straight to
  the newest occupancy already outside the window, so the loop starts at "now minus the window"
  with no oldest-first grind. No-op for `--rebuild`, for an unbounded window (tests), and on a
  fresh/small database. The separately-broken part of the incident — `project-vstp` wedged since
  2026-08-16 on the schedule-delete FK — was unrelated (see Milestone 7); it was masking nothing,
  CIF SCHEDULE covered ~98% of links throughout.
- Evidence #6 ("a selected map or queried corridor's TIPLOC/STANOX coverage") is satisfied via
  SMART/STANOX correlation to the specific berth being resolved, not by consulting the live map
  document a berth happens to be published on — the resolver stays fully nationwide/map-
  independent per CLAUDE.md's "map scope must never be used as an ingestion filter."
- Temporal plausibility (evidence #3) is a day-level check against `train_run.activated_at`, not
  per-calling-point precision — `schedule_location`'s own times are raw CIF-style text, not
  parsed timestamps, and `train_run.origin_departure_at` (which would give an exact anchor) is
  never actually populated by the Milestone 8 TRUST projector (`apps/worker/src/trust/
projector.ts` hardcodes it `null` — a pre-existing gap, not something this milestone fixes).
  The live movement-report correlation bullet above (#3b) supplies the point-wise "actual times"
  signal for the case that actually matters — telling two same-headcode runs apart — whenever a
  candidate is genuinely reporting TRUST movements past the berth. `temporallyPlausible` also
  carries a 20-minute lower-bound grace (`TD_LEADS_TRUST_GRACE_MS`, added 2026-08-31): TD steps a
  headcode through berths before TRUST fires the activation for that working, so a hard
  `entered_at >= activated_at` was rejecting the _correct_ just-appeared run while three unrelated
  same-headcode workings that had activated earlier the same day kept the score (observed live:
  berth PX 0251 / 5C70, correct run `115C70M931` activated 7.5 min after the step). Tuned without
  a `RESOLVER_VERSION` bump by owner decision — a plausibility-window widening, not a
  weight/structure change; the 24h `MAX_JOURNEY_MS` upper bound is unchanged.
- `berth.updated`/`berth.cleared` WebSocket deltas don't carry a live-refreshed `runSummary`
  (only the snapshot on connect/reconnect and the REST `/state` poll do) — the already-declared
  `run.resolution.updated` stub message type would be the clean way to add that, but nothing
  emits it yet (needs the map-delta projector to also watch `berth_run_resolution`).
- The popup shows "full schedule" inline (expandable within the same popup) rather than a
  separate routed page, and links out to run/berth history as identifiers rather than clickable
  pages — those pages don't exist yet on the web frontend, only as API endpoints.

2026-08-13 popup/map polish, from real usage:

- Calling points are now resolved from raw TIPLOC to a human-readable name via CORPUS
  (`location_reference`), for origin/destination and every row of the full-schedule table —
  looked up fresh at request time in `apps/api/src/routes/currentRun.ts` (same "enrich at read
  time, never store" reasoning as the candidate-identity enrichment above), falling back to the
  bare TIPLOC wherever CORPUS has no entry. A location with only a pass time (no booked
  arrival/departure) is now shown as a single greyed-out pass time instead of blank dashes, and a
  genuine calling point's arrival/departure/arrow are three separate table cells rather than one
  concatenated string — the previous single-string rendering let the arrow's on-screen position
  drift row to row depending on whether either side was blank; separate `<td>`s let the browser's
  own column layout keep it pinned. First cut of the passing-point display only ever read
  `passPublic`, which turned out to render as a blank dash for nearly every real passing point —
  confirmed same day against a real service's RTT page (realtimetrains.co.uk, permitted per
  CLAUDE.md rule 14, not one of the three named sites) that CIF essentially never carries a
  _public_ pass time for a non-stop junction, only a working one; `apps/web/src/map/RunPopup.tsx`
  now falls back to `passWorking` (already fetched by the API via the shared `locationToJson`,
  just not previously read by the popup) whenever `passPublic` is null, which is the normal case.
- `apps/web/src/map/MapRenderer.tsx`: empty berths no longer respond to clicks at all (no
  `onClick`, default cursor) — clicking was never meaningful there (`docs/PROJECT_SPEC.md` §5
  always specified "click a **populated** berth"), and the old empty/unbound stub panel is
  removed as a result (it can no longer be reached). Fixed a real bug in the existing
  run-tracking logic (the comment describing it — "lets the map follow this specific run across
  berth steps" — was already the intent, just not achieving it): the popup closed the instant _no_
  berth on the map reported the tracked run, which happens on every ordinary step for a brief,
  normal window — the old berth's occupancy clears before the resolver has confirmed the run in
  its new berth. `RUN_LOST_GRACE_MS` (8s) now gives that window before treating the run as
  genuinely gone, and the popup's render condition no longer re-checks the _current_ berth's own
  `description` (which was closing the popup independently of the tracking fix, since that
  specific berth's description clears the moment the train steps out of it). It also had no
  explicit close affordance at all — a small "×" button (`onClose` prop, `.map-inspector__close`)
  now closes it and cancels any pending grace-period timeout.
- The first cut of call-vs-pass classification (`isCall = arrivalPublic !== null ||
departurePublic !== null`) only ever looked at _public_ times, which happened to work for
  passenger schedules but silently misclassified every stop on a freight/parcels working as a
  pass — confirmed 2026-08-13 against a real freight service (4S44 / gb-nr:W32423) on
  realtimetrains.co.uk (permitted per CLAUDE.md rule 14): freight timetables essentially never
  carry public times at all, only working ones, so a genuine booked stop (e.g. "stops for staffing
  reasons") was rendering identically to an ordinary passing junction. `isCall` now falls back to
  `arrivalWorking`/`departureWorking` the same way the pass-time fix falls back to `passWorking`.
  Also added a Path/Line column (`schedule_location.path`/`.line`, already fetched by the API, not
  previously surfaced) and a `<thead>` now that the table has enough columns to need one; the table
  itself is wrapped in its own horizontally-scrolling container so a long schedule widens only the
  table, not the whole page.

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

## Later milestones

- Additional authored/public maps using already-retained nationwide history.
- S-Class blank/on/off bindings for areas where usable data exists.
- Map continuation/follow-train behavior.
- Bulk binding import and binding-discovery assistance.
- Physical/WAL backups and external archive replication.
- Horizontal worker scaling if measured load requires it.
