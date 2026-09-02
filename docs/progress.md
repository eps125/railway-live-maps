# Progress

## Milestone 1 — repository and Docker foundation: complete (2026-08-04)

See prior entry in Git history for full M1 detail. Summary: pnpm workspace, strict
TypeScript, Fastify API with health endpoints, worker command dispatcher, React/Vite web
shell, hand-rolled Postgres migration runner, S3/MinIO archive client, tested Docker
Compose stack, CI.

## Milestone 2 — nationwide raw event store and archive: complete (2026-08-04)

### What exists

- `packages/domain`: shared enums/types (`ParseStatus`, `FeedName`, `ArchiveSourceKind`,
  `TdMessageClass`/`TdCClassMessageType`, `SourceLineage`). No reducers — that's M4.
- `packages/database/migrations/0002`–`0007`: `feed_connection_session`,
  `raw_archive_object`, `feed_frame` (`unique(feed_name, body_hash)` — the idempotency
  guard), `raw_feed_event` (partitioned by `normalized_event_at_utc`, monotonic
  `ingestion_sequence`), `feed_gap`, `td_berth_event`/`td_heartbeat`/`td_s_event` (DDL only,
  population is M4), `projection_definition`/`projection_checkpoint` (scaffolding, no
  caller yet).
- `packages/database/src/partitions.ts`: `ensureMonthlyPartitions` — idempotent monthly
  partition creation, wired into `worker migrate` and the standalone `worker
ensure-partitions` command.
- `packages/archive` additions: `sha256Hex`, `computeArchiveObjectKey` (deterministic
  content-addressed keys), `putImmutableObject`.
- `apps/worker/src/archive/reconcile.ts` + `worker reconcile-archive --mode=quick|deep`:
  two-directional DB↔S3 audit (missing/corrupt DB-indexed objects are severe and exit
  non-zero; orphaned S3 objects are reported, not fatal).
- Integration test split: `*.integration.test.ts` needs real Postgres (+MinIO for
  archive-touching ones), excluded from the default `pnpm test`; `pnpm run
test:integration` runs them explicitly.

### Verification (this sandbox has no Docker, but a local PostgreSQL 18 was available)

A throwaway local database `railway_live_maps_test` was created on the pre-existing local
Postgres instance (`postgresql://postgres:postgres@localhost:5432`) purely for this
session's verification — safe to drop, not referenced by anything else.

- All 7 migrations applied cleanly and are idempotent on re-run (confirmed via
  `packages/database/dist/cli.js`).
- `worker ensure-partitions` created 5 months of partitions for all 3 partitioned tables,
  confirmed idempotent on re-run, and the documented default-partition-overlap hazard was
  reproduced exactly as designed (inserted a row into the default partition, then confirmed
  `ensureMonthlyPartitions` throws Postgres's own "would be violated by some row" error).
- `pnpm run test:integration` — 5 integration test files, all passing against the real
  Postgres instance.

## Milestone 3 — nationwide TD recorder: complete (2026-08-04)

### What exists

- `packages/feed-parsers`: pure, fixture-driven `parseTdFrame` — classifies CA/CB/CC/CT
  (C-Class) and `S*_MSG` (S-Class) children, retains unrecognized wrapper keys as
  `unsupported`, isolates a malformed child from valid siblings, and a totally corrupt body
  still yields exactly one synthetic `malformed` child (never zero rows). Transparent gzip
  detection. `normalizeTimestamp` falls back to `receivedAt` with a recorded reason when a
  source timestamp is missing/unparseable/implausible (the exact plausibility threshold is
  a documented placeholder, not confirmed against real NR data — no live fixtures exist
  yet, see Milestone 0). Fixtures under `fixtures/td/*.json` use synthetic area codes (`ZZ`,
  `ZY`), deliberately not `PX` (Preston's confirmed real TD area).
- `apps/worker/src/td/recorder.ts`: `recordFrame()` implements the exact
  archive-before-ack sequence (checksum → deterministic key → S3 PUT → archive index
  upsert → transaction → `feed_frame` upsert as the idempotency guard → parse → insert
  every child including malformed/unsupported → commit). Redelivery of identical bytes is
  a proven safe no-op.
- `apps/worker/src/td/connection/`: `TdConnection` interface; `FixtureReplayTdConnection`
  (no credentials — drives fixtures through the real `recordFrame` pipeline); hand-rolled
  STOMP 1.2 frame codec (`frame.ts`, LF-only) + `StompTdConnection` (real NR connection,
  **not exercised against a live broker in this environment** — only constructible when
  `TD_LIVE_ENABLED=true`, which is off everywhere by default).
- `worker replay-fixtures [scenario]` (scenarios: `multi-area-smoke`, `redelivery-smoke`)
  and the long-running `worker ingest-td` role (refuses to start without
  `TD_LIVE_ENABLED=true` and NR credentials).
- NR credentials: `apps/worker/src/secrets.ts` (`readSecret` — `NR_USERNAME_FILE`/
  `NR_PASSWORD_FILE` Docker-secret path preferred, plain env var as a dev fallback). Real
  values are never in Git, chat, or plain Compose env vars — see `deploy/secrets/README.md`.

### Verification

- 60 unit tests total across all packages (parser fixtures, timestamp normalization,
  semantic hashing, STOMP frame codec round-trip incl. partial-chunk/multi-frame/
  lying-content-length cases, backoff math, secrets resolution, dispatch).
- Integration tests (real Postgres, S3 faked in-memory since no MinIO in this sandbox —
  real S3/MinIO connectivity is proven separately by `packages/archive`'s own tests and
  CI's live MinIO steps): exact-byte redelivery is a proven no-op (row counts unchanged, no
  duplicate insert errors), multi-area retention with no filtering, unsupported/malformed
  retention, crash-before-ack recovery, strictly increasing `ingestion_sequence`, full
  fixture-scenario replay end-to-end confirming zero `NR_*` env vars were involved.
- `node apps/worker/dist/index.js replay-fixtures multi-area-smoke` was run directly
  against the real local Postgres; it correctly reached the S3 PUT step and failed with a
  clean `ECONNREFUSED` (no MinIO available here) — proving the whole pipeline up to the one
  piece of infrastructure this sandbox doesn't have. CI has real MinIO and runs this as a
  smoke-test step.

### Deliberate deviations from the original sketch (all noted in-code)

- Hand-rolled the STOMP client instead of depending on the unmaintained `stompit` package —
  matches this project's existing hand-rolled-over-dependency style.
- `normalized_event_at_utc` is `NOT NULL` (required by the partitioned primary key) with a
  `receivedAt` fallback + recorded correction reason, rather than allowing `NULL` to route
  to the default partition.
- `parse_status = 'duplicate-redelivery'` is reserved in the schema but not implemented —
  it targets cross-frame _semantic_ duplication, a different problem from broker redelivery
  (which `feed_frame`'s unique constraint already solves) and needs real throughput-aware
  design, not a guess.

## GitHub / Docker / CI-CD / Portainer: complete and deployed (2026-08-04)

- Repo pushed to `https://github.com/eps125/railway-live-maps` (`main`). CI green on both
  jobs: `build-and-test` (lint, format check, typecheck, unit tests, build, MinIO/Postgres/
  Redis service containers, migrate, ensure-archive-bucket, connectivity check,
  `test:integration`, fixture replay smoke, Docker image builds) and `publish` (pushes
  `ghcr.io/eps125/railway-live-maps-{api,worker,web}`, `GITHUB_TOKEN`-authenticated). GHCR
  packages set to public.
- **Deployed to Portainer** using `deploy/docker-compose.portainer.yml` (pull-only variant,
  no `build:` context, no Docker-secret file mounts — `NR_USERNAME`/`NR_PASSWORD` are plain
  env vars there instead, left empty; see the caveat in `docs/DEPLOYMENT.md` §4 about that
  being weaker than a mounted secret, acceptable only while `TD_LIVE_ENABLED=false`).
  `WEB_PORT=6050`/`API_PORT=6051` (host had something already on 8080). `deploy/.env`
  (gitignored, not in Git) holds the actual generated secrets used — regenerate/rotate
  before treating this as anything beyond a dev/staging deploy.
- Not yet run against the live deployment: `migrate`/`ensure-archive-bucket` one-off
  commands, `/health/ready` check. Confirm these before assuming the stack is fully working
  end-to-end, not just "container started."

### Known limitations (unchanged from M1, plus)

- No Docker in this sandbox — Dockerfiles/Compose reviewed but not build-verified locally;
  CI does build them.
- No MinIO/S3 in this sandbox — archive-touching integration tests use an in-memory fake
  S3 client; real S3 connectivity is proven only in CI and via `packages/archive`'s own
  mocked-client unit tests.
- `apps/worker/src/td/connection/stomp/stompConnection.ts` has never connected to a real
  broker (by design — gated off, and there's nothing to connect to here). Verify it for
  real before ever setting `TD_LIVE_ENABLED=true`.

## Milestones 4 and 5 — nationwide TD projections and canonical map schema/renderer: complete (2026-08-05)

- **Milestone 4**: CA/CB/CC pure reducers (`packages/domain/src/td/berthReducer.ts`), a
  checkpointed projector (`apps/worker/src/td/projector.ts`, `project-td [--rebuild]` command)
  populating `berth_current_state`/`berth_occupancy`/`td_projection_anomaly`/
  `td_s_current_state` nationwide, and REST discovery/history endpoints
  (`apps/api/src/routes/td.ts`). Integration tests cover every named acceptance scenario
  (normal step, cancel, interpose overwrite, empty source, destination overwrite, duplicate
  delivery, equal-timestamp ordering, month partition boundary, restart/replay). Known
  limitation: `td_s_bit_transition` exists but is unpopulated — no verified S-Class decode
  spec/fixture yet.
- **Milestone 5**: canonical map JSON schema/validator/compiler (`packages/map-schema`), a
  `publish-map` CLI, map definition/state REST endpoints (`apps/api/src/routes/maps.ts`), and
  a pan/zoom SVG renderer (`apps/web/src/map/`), proven against one hand-authored Lancaster
  fixture. Known limitations: the fixture's `PX`/`CL` TD area bindings are owner-asserted, not
  yet verified against live captured messages; `/state` only serves current live state
  (point-in-time playback is M10); `map_binding_index`/drafts/snapshots are M6/M11/M12.
- Deployed and live-tested against the owner's Portainer instance
  (`deploy/docker-compose.portainer.yml`, ports 6050-6055). Two real bugs found and fixed
  during that testing, not caught by unit/integration tests: the three app Dockerfiles didn't
  copy/build the new `@railway/domain`/`@railway/map-schema` workspace deps (fixed); the map
  page's `definition` fetch had no retry, so a page loaded before `publish-map` ran got stuck
  showing a stale 404 forever even after the map was published (fixed, with a regression
  test) — this also surfaced that `apps/web`'s test setup never ran RTL's cleanup between
  tests (`vitest.config.ts` doesn't set `test.globals`), now fixed in `setupTests.ts`.

## Milestone 6 — live WebSocket: complete (2026-08-05)

- New `packages/protocol` workspace package (`liveWsMessages.ts`): WS message types/zod
  schemas shared by api/worker/web, matching `docs/API_CONTRACT.md` §2 exactly (`snapshot`,
  `berth.updated`, `berth.cleared`, `quality.updated`, `heartbeat`, `resync.required`, plus a
  stub `run.resolution.updated` not emitted until M9).
- Migration `0010_map_binding_index.sql`: two partial unique indexes (one per binding type —
  the real invariant, not an all-columns unique) plus lookup indexes for the live-delta hot
  path. Populated automatically by `publish-map` going forward; a new idempotent
  `backfill-map-bindings` command handles versions published before this migration existed
  (both share `apps/worker/src/mapBindingIndex.ts`).
- `GET /api/v1/maps/{slug}/live` (`apps/api/src/routes/liveMap.ts`, `@fastify/websocket`):
  sends a snapshot (shared snapshot-building logic with `/state` via the new
  `apps/api/src/lib/liveState.ts`/`mapVersion.ts`, extracted out of `routes/maps.ts` without
  changing its behavior — its existing test suite passed unmodified), then forwards deltas
  from a `LiveDeltaSource`. Sends `resync.required` and closes if the published map version
  changes mid-connection.
- Two delta-source implementations: default `pollingDeltaSource.ts` (polls
  `berth_current_state` joined through `map_binding_index`, no extra infrastructure) and
  optional `redisDeltaSource.ts` (`LIVE_WS_REDIS_PUBSUB_ENABLED=true`), fed by a new worker
  command `project-map-deltas` (`apps/worker/src/mapProjector/`) — a second, independently
  checkpointed projector reading `td_berth_event` and publishing to `railway:live:{slug}`.
- Web: `useLiveMapSocket.ts` hook (snapshot+delta application, exponential-backoff reconnect,
  discards/reconnects on a sequence regression) and `LiveStatusBanner.tsx`; `useMapData.ts`
  now sources state from the live socket whenever connected, falling back to the Milestone 5
  REST `/state` poll otherwise.
- Acceptance proven directly: `apps/api/src/live/pollingDeltaSource.integration.test.ts`
  replays a multi-area scenario and confirms a published map's delta stream emits only its own
  bound area/berth while an unrelated area's `berth_current_state` row stays present and
  untouched — the literal "done when" bullet. 33 integration tests, 119 unit tests, full
  workspace typecheck/lint/format all pass.
- Known limitation: no Redis server in this sandbox (mirrors the existing no-MinIO situation),
  so the Redis path's true network round trip isn't exercised here — proven instead via a
  capturing fake publisher and a fake subscriber sharing the same message shape. Confirm the
  real round trip against a live Redis before setting `LIVE_WS_REDIS_PUBSUB_ENABLED=true` in
  any real deployment.

## Milestones 11 and 12 — visual editor MVP + editor test/publishing workflow: complete (2026-08-06)

See `docs/IMPLEMENTATION_PLAN.md`'s M11/M12 "Status: implemented" notes for the full
file-by-file summary. Highlights: `packages/map-publish` (shared publish transaction, used by
both the `publish-map` CLI and the new editor publish route); migration `0011_map_draft.sql`
(`map_draft`/`map_draft_revision`); a Konva-based editor canvas at `apps/web/src/editor/`
(command-model undo/redo, all six element tools, property/layers/validation panels, Design/
Test/Review modes); `apps/api/src/routes/editor/` (draft CRUD with optimistic locking,
three-tier validation, diff, binding diagnostics, live test-mode state, publish — all gated
behind `EDITOR_ENABLED`, non-existent as routes when disabled). 53 integration tests + 136 unit
tests pass; full workspace typecheck/lint/format clean.

**Manually verified end-to-end in a real browser** (Vite dev server + API, `EDITOR_ENABLED=true`,
against a throwaway local Postgres): published the real `lancaster-minimal.json` fixture via
the CLI, opened `/editor`, confirmed the draft seeded correctly (4 layers, 5 berths), ran
Validate (5 correct "never observed" warnings, 0 blocking errors), ran Review's diff (0 changes
against the just-seeded draft), and clicked Publish — confirmed via `GET
/api/v1/maps/lancaster/definition` that a new immutable `map_version` was created, and that the
public `/` route immediately rendered it. No console errors. Known limitation: this session's
browser pane couldn't composite screenshots or take pixel-coordinate clicks, so the Konva
canvas's own pointer gestures (click-to-place, drag-to-move, corner-resize) were exercised only
by the test suite (including a `vitest-canvas-mock` Konva-in-jsdom smoke test), not visually —
re-verify those specific gestures in a real browser session before treating the canvas UX as
polished.

## Milestone 7 — complete schedule/reference and VSTP import: complete (2026-08-06)

See `docs/IMPLEMENTATION_PLAN.md`'s M7 "Status: implemented" note for the full file-by-file
summary. Highlights: the TD broker connection/recorder were generalized into
`apps/worker/src/shared/` so VSTP (and later TRUST) reuse the exact archive-before-ack
sequence instead of a second copy. Migrations `0012_source_file_import.sql`,
`0013_schedule_tables.sql`, `0014_reference_tables.sql` (the latter edited in place, before
being committed, to add a natural-key unique index for SMART's idempotent reimport).
`packages/feed-parsers` gained VSTP (XML, `fast-xml-parser`), SCHEDULE (streaming JSONL),
CORPUS/SMART (single-document JSON) parsers — all fixture sets are constructed from public
documentation, not captured real extracts, flagged consistently in code/docs. VSTP
Create/Overwrite/Delete transactions project directly into `schedule`/`schedule_location`
(incremental, no staging needed). The SCHEDULE full-extract importer uses the
staging-table + single-swap-transaction pattern the docs specify — chunked staging inserts,
then one transaction that atomically replaces every `source='SCHEDULE'` row; a missing
header/trailer record is treated as a truncated file and fails the import rather than
partially applying it. CORPUS/SMART importers are simpler upsert-in-place. STP precedence
(`C` > `O` > `N` > `P`, explicit `ambiguous` outcome on same-precedence ties) is exposed via
the new `GET /api/v1/schedule/{trainUid}?date=` route, documented in `docs/API_CONTRACT.md`.
Download commands (`download-schedule`/`download-corpus`/`download-smart`,
`SCHEDULE_DOWNLOAD_ENABLED`) and `ingest-vstp`/`project-vstp` (`VSTP_LIVE_ENABLED`) exist and
are credential-gated but untested against live Network Rail endpoints in this environment —
proven via fixture replay and the file-path `import-*` commands instead. 78 integration tests

- 158 unit tests pass; full workspace typecheck/lint/format clean. During this milestone, two
  pre-existing latent bugs surfaced by a full clean verification pass were also fixed: an
  `exactOptionalPropertyTypes` violation in the editor's `EditorCanvas` prop type, and a
  TD/VSTP STOMP-connection-wrapper type-variance error (both wrappers now cast at the `start()`
  call site, justified by the shared connection's fixed-`feedName` runtime guarantee).

## Milestone 8 — nationwide TRUST runs and activation linkage: complete (2026-08-06)

See `docs/IMPLEMENTATION_PLAN.md`'s M8 "Status: implemented" note for the full file-by-file
summary. Highlights: migration `0015_train_run_tables.sql` (`train_run` uuid-keyed,
`train_run_event` partitioned, `run_schedule_link`); TRUST is the third STOMP feed and reuses
the Milestone 7 shared broker connection/recorder unchanged. `packages/domain/src/trust/
runReducer.ts` is a pure effects-based reducer covering all 8 TRUST message types, mirroring
`td/berthReducer.ts`'s style — Activation creates, Movement/Change of Origin/Change of
Location only touch `last_event_at` (defensive no-op if no run matches yet, never fabricates
one), Cancellation/Reinstatement toggle `cancelled`/`activated`, Change of Identity supersedes
the old run and creates a new one under the revised identity without rewriting history, and
Unidentified Train creates a minimal unlinked run. `serviceDate.ts` computes the UK traffic
day using a documented-assumption 03:00 Europe/London boundary. Schedule-link resolution runs
immediately at activation via the Milestone 7 `resolveStpPrecedence` resolver, plus a
deferred-relink pass every `project-trust` run that re-attempts every non-`matched`
`run_schedule_link` row in place (added `activation_train_uid` to that table specifically so
the re-attempt doesn't need the original activation event). New `GET /api/v1/runs/{runId}` /
`GET /api/v1/runs/{runId}/schedule` routes, documented in `docs/API_CONTRACT.md`
(`resolverEvidence` stays `null` until Milestone 9). 91 integration tests + 189 unit tests
pass; full workspace typecheck/lint/format clean. Known limitation: a message that arrives
before its Activation (a plausible out-of-order broker delivery scenario) is permanently
skipped from `train_run_event` — nationwide retention is unaffected (the raw message stays in
`raw_feed_event` regardless), but there's no later-arriving-activation backfill/retry
mechanism in this MVP pass.

## Milestone 9 — berth-to-run resolver and popup: complete (2026-08-09)

See `docs/IMPLEMENTATION_PLAN.md`'s M9 "Status: implemented" note for the full file-by-file
summary and known-limitations list. Highlights: migrations `0018_berth_run_resolution.sql` and
`0019_berth_occupancy_resolved_run_uuid.sql` (a pre-existing Milestone 4 bug found and fixed
along the way — `resolved_run_id` was `bigint`, `train_run.id` is `uuid`, never actually
compatible until now); pure scoring in `packages/domain/src/resolver/resolveBerthRun.ts`
(matched/ambiguous/unmatched, an exact top-score tie is always `ambiguous` — CLAUDE.md rule 5);
checkpointed `project-resolver` projector with a bounded open-occupancy retry pass; `runSummary`
now real on `/state`/snapshot; new `GET /api/v1/td/areas/{tdArea}/berths/{berth}/current-run`;
`resolverEvidence` now populated on `GET /api/v1/runs/{runId}`; `RunPopup.tsx` replaces the old
description-only stub. 245 unit tests + 120 integration tests (32 files) pass across the whole
workspace; full typecheck/lint/format clean.

Also fixed along the way, both real `project-td --rebuild` regressions the new
`berth_run_resolution` FK exposed by finally exercising a code path nothing had stressed before:
`clearProjectionRows` now clears `berth_run_resolution` first (pure derived state, safe to
delete outright), and separately nulls out (not deletes — it's a permanent audit trail, not
derived state) `operator_berth_action.closed_occupancy_id` for any occupancy being rebuilt — that
second one was a latent bug from the manual-clear feature (a prior session, pre-M9), not
something M9 itself introduced. Nothing changed for `apps/worker/src/schedule/
scheduleImporter.ts`'s daily full-file swap, but it has the same class of latent bug
(`train_run.schedule_id`/`run_schedule_link.schedule_id` both `references schedule (id)` with no
`on delete` clause, migration 0015) — flagged, not fixed in this pass, see the spawned follow-up
task.

## Milestone 15 step 7 — berth-run resolver removed from the live path (2026-09-01)

Per ADR 0002 and the owner's 2026-09-01 scope expansion, the Milestone 9 berth-run resolver was
removed wholesale from the live path. Deleted `packages/domain/src/resolver/`,
`apps/worker/src/resolver/`, the `project-resolver` / `project-resolver-daemon` commands and the
`projector-resolver` Portainer service. The live protocol lost `run.resolution.updated` and the
`runSummary` berth field; the map-delta projector lost `publishResolutionDeltas` /
`buildRunResolutionDeltaMessages`; the web renderer lost run-following, matched/ambiguous berth
shading and the run-lost grace window (a clicked berth's popup is now keyed on the element id).
`apps/api/src/lib/liveState.ts` no longer computes run summaries, and `apps/api/src/routes/td.ts`
history endpoints are back to plain `berth_occupancy` reads. `berth_run_resolution`, `train_run`,
`train_run_event` and `run_schedule_link` still exist and still back `GET /api/v1/runs/{runId}`
and the `current-run` popup endpoint until migration 0025 drops them in the garner phase.
Full typecheck / lint / unit tests (292) green. Run↔schedule correlation is deferred to a later
milestone that will source it from the garner `trust_*` mirror.

## Milestone 15 step 2(new) — garner CIF + TRUST mirror (2026-09-01)

RLM stopped subscribing to Network Rail for VSTP / TRUST / SCHEDULE. Those feeds are now mirrored
from the operator's openrail-eps ("garner") MariaDB by the `ingest-garner` daemon.

- **Migrations 0024 / 0025**: dropped `schedule` / `schedule_location` / staging and `train_run` /
  `train_run_event` / `run_schedule_link` / `berth_run_resolution`; created garner-shaped
  `cif_schedules` / `cif_schedule_locations` (mirror of garner `cif_schedules` with epoch→date
  conversion + generated `days_runs_bitmask`) and `trust_activation` / `trust_activation_extra` /
  `trust_movement` / `trust_cancellation` / `trust_changeorigin` / `trust_changeid` /
  `trust_changelocation`. Schema taken from the C-source DDL in `openrail-master/database.c`.
- **`apps/worker/src/garner/bridge.ts`**: added `runGarnerScheduleSync` (upsert-by-id,
  watermarked by `GREATEST(created, deleted)`) and `runGarnerTrustSync` (per-table `created`
  watermark, `on conflict do nothing`). `ingestGarner.ts` now ticks every 20s (trust every tick,
  schedules every 3rd, CORPUS/SMART every 15th).
- **`packages/domain/src/trust/garnerMovement.ts`** (new, tested): decodes garner's
  `trust_movement.flags` bit-field → event kind + early/on-time/late/off-route + terminated.
- **API**: `GET /api/v1/schedule/:trainUid` and `GET /api/v1/vstp/schedules` repointed at the
  garner mirror; `currentRun.ts` (the click-a-berth popup) rewritten to show candidate schedules
  by headcode + STP-effective pick + latest `trust_movement`, labelled as garner's data;
  `GET /api/v1/runs/{runId}` (+`/schedule`) and `routes/runs.ts` removed.
- **Removed**: `apps/worker/src/{trust,vstp,schedule}/`, the `project-vstp` / `project-trust` /
  `import-schedule` / `download-schedule` / `ingest-vstp` / `ingest-trust` / `reparse-vstp-archive`
  commands and roles, and the `ingest-vstp` / `ingest-trust` / `projector-schedule` /
  `projector-resolver` Portainer services. The pure feed parsers and superseded domain reducers
  (`runReducer.ts`, `mapToScheduleRow.ts`, `serviceDate.ts`) are left as now-unused code.
- typecheck / lint / prettier / 299 unit tests green. Integration tests (`currentRun`, `schedule`,
  `td/projector`) rewritten for the new schema but **not run here** (need a live Postgres) — the
  user runs them in the stack.

**Deferred**: mirroring garner's own TD-berth → `trust_id` deduction (`td_states` / `livesig`
link), which would let the popup show a single-winner identification for the ambiguous case.
Part of the resolver-rebuild phase.

## Milestone 15 — live-path robustness fixes from the garner rollout (2026-09-01)

Three bugs surfaced running the garner mirror against the real openrail-eps instance for the
first time; fixed in one commit.

- **`createPool` (`packages/database/src/pool.ts`) now attaches a `pool.on('error')` listener.**
  Without one, an idle pooled client whose connection is dropped server-side (a Postgres
  restart) makes Node throw an uncaught exception and kill the process — which is how
  `project-td-daemon` died with a `57P03` when Postgres was restarted for tuning. With the
  listener the pool discards the client and the next query reconnects. Added `onConnectSql`
  (used by `ingest-garner` for `set synchronous_commit = off`) and a `poolConfig` passthrough.
- **`runDaemonLoop` now backs off after a failing tick** (`errorBackoffMs`, default 5s) so a
  persistently-down dependency retries every few seconds with one log line each, not at the full
  250ms tick rate.
- **`StompConnection` silent-stall watchdog.** Once CONNECTED, if nothing at all arrives from
  the broker (not even a heartbeat LF) for `staleTimeoutMs` (default `max(heartbeatMs*3, 90s)`),
  the socket is force-closed so the reconnect loop takes over. Catches the case where the feed
  goes dead but the TCP socket stays open — `ingest-td` sat on a dead connection twice during
  the incident with the container still "Up".
- **`ingest-garner` self-throttles.** Per-batch caps cut to `SCHEDULE_BATCH=2000` /
  `TRUST_BATCH=5000`; the pg pool runs `synchronous_commit = off` (all mirror data is
  rebuildable); and every tick it **skips _all_ garner sync when `projector-td` is stalled
  (>8s since last batch) OR more than 5000 TD events behind the newest ingested one**. The
  first cut only checked "time since last batch", which stayed ~3s during the post-incident
  catch-up while the projector was ~95k events / 18 min behind — hence the event-backlog check.
  The unthrottled initial backfill (~11M `cif_schedule_locations` rows) had saturated disk write
  bandwidth and starved the live projector.
- **`runProjectTd` gained `maxBatches`; `project-td-daemon` caps it at 20 batches (~10k events)
  per tick.** `runProjectTd`'s `for(;;)` loop drains the whole backlog in one call — so a large
  catch-up blocked the daemon for minutes, during which `runProjectMapDeltas` (which runs right
  after it in the same tick) never fired, the WS delta stream went silent, and the live map
  "stuck" until a manual F5 (the REST `/state` snapshot stayed fresh). With the cap the two
  interleave and deltas keep flowing during a catch-up. The one-shot `project-td` /
  `--rebuild` commands still drain fully (unset = old behaviour).

Operational: Postgres was also tuned live via `ALTER SYSTEM` (`shared_buffers` 128MB → 2GB,
`wal_compression=on`, bigger `max_wal_size`) — since folded into
`deploy/docker-compose.portainer.yml`'s `postgres` `command:` flags (`PG_*` env-overridable).

Also this session: `createPool` now attaches a `pool.on('error')` listener and enables TCP
keepalive on every pool, with an opt-in `statementTimeoutMs` applied to `project-td-daemon`
(15 s) and `ingest-garner` (30 s) — a query hung on a connection Postgres killed during its own
restart otherwise waited forever and wedged the daemon loop (observed twice after Postgres
restarts). `runDaemonLoop` also backs off `errorBackoffMs` (5 s default) after a failing tick,
and `StompConnection` gained a silent-stall watchdog (force-reconnect if no inbound data for
`max(heartbeatMs*3, 90 s)`).

## Milestone 16 — dedicated fast live-berth-state projector (2026-09-01)

See `docs/adr/0003-dedicated-live-berth-state-projector.md`. End-to-end latency (TD frame →
visible on the map) was 6–20 s in steady state — the single `project-td-daemon` does ~5–10
sequential single-row SQL round-trips per event and published deltas only after the whole
projection batch, so a queue of ~1500 events ≈ 15 s of lag.

- **`apps/worker/src/td/liveProjector.ts`** (`runProjectTdLive`, `foldLiveBerthState`) + the
  `project-td-live-daemon` command + `projector-td-live` compose service (100 ms tick). Reads TD
  CA/CB/CC from `raw_feed_event` in ~100-row batches, folds to the final `description` per berth,
  writes `berth_current_state` in **one bulk upsert per tick**, and publishes the Redis deltas
  (bindings cached, 30 s TTL). Own checkpoint `td-live-berth-state`; seeds from open
  `berth_occupancy` on a fresh checkpoint then tails from the history checkpoint position.
- `project-td-daemon` no longer runs `runProjectMapDeltas` — the live projector publishes now. It
  keeps writing `berth_current_state` (monotonic-guarded) as the catch-up / `--rebuild` path.
- Both `berth_current_state` writers now carry the guard
  `excluded.source_ingestion_sequence >= berth_current_state.source_ingestion_sequence` and sort
  by `(td_area, berth_code)`.
- `berth_current_state.occupancy_id` → `NULL` in steady state. `GET …/current-run` checks
  `description IS NOT NULL`; `POST …/editor/berths/{a}/{b}/clear` reads `berth_occupancy`
  directly; `liveState.ts` stopped selecting the column.
- `clearProjectionRows` (`project-td --rebuild`) resets the `td-live-berth-state` checkpoint.
- Unit test for `foldLiveBerthState`; integration test for `runProjectTdLive` (writes,
  binding-scoped deltas, monotonic guard). typecheck / lint / prettier / 315 unit tests green.

**Deploy:** add the `projector-td-live` service (in the updated compose) and redeploy. It creates
its own `td-live-berth-state` projection on first run and seeds from `berth_occupancy`.
Milestone 17 (Tier 3: fold into `ingest-td`) is documented as optional, only if this still
misses sub-second.

### Milestone 16 hotfix — the seed wedged the live checkpoint (2026-09-02)

On the live stack `projector-td-live` crash-looped every tick with `canceling statement due to
statement timeout` inside `seedFromHistory`: `berth_occupancy` is partitioned by `entered_at`
with no `left_at` index, so `where projection_version = $1 and left_at is null` was a
sequential scan of every monthly partition and blew the daemon's 10s `statement_timeout`.
Because the seed ran _before_ the checkpoint advance, each failure left the checkpoint in its
"fresh" state, so the next tick re-attempted the same doomed seed — the live projector never
processed an event and never published a WebSocket delta, so the public map only updated on a
manual refresh (the REST `/state` snapshot).

- **`0026_berth_occupancy_open_idx.sql`** — partial index
  `berth_occupancy (projection_version, td_area, berth_code) where left_at is null`. The open
  intervals are a tiny fraction of the table, so the seed is now an index scan regardless of
  how much closed history has accumulated. Propagates to future partitions automatically.
- **`liveProjector.ts`** — on a fresh checkpoint, advance to the history projector's position
  **first and unconditionally**, then run the baseline fill **best-effort** (its own
  `try/catch`, logs and continues). A slow or failing fill can no longer pin the checkpoint.
  `project-td-daemon` also maintains `berth_current_state`, so a skipped fill only means
  currently-stationary berths lag until their next CA/CB/CC. New `options.seedBaseline` seam so
  a test can inject a throwing stub.
- Integration test: a failing baseline fill still advances the checkpoint and processes the
  event; the second run is a clean no-op. typecheck / lint / 315 unit tests green (migration +
  live-projector integration tests run in CI).

### Unrelated CI fix — `currentRun` "activated today" cutoff crossed the BST midnight boundary (2026-09-02)

Surfaced on the same CI run but independent of the above. `apps/api/src/routes/currentRun.ts`
filtered TRUST activations with `created >= ($2::date)::timestamptz`, casting the
`Europe/London` calendar date to an instant in the DB session's zone (UTC). Under BST, between
23:00 and 00:00 UTC `londonToday()` already returns tomorrow's date, so the cutoff sat up to an
hour in the future and excluded an activation that had only just been inserted — the STP
tie-break saw zero activations and `effective` came back `null`. The integration test "breaks an
STP tie using a TRUST activation seen today" failed whenever CI ran in that hour. Fixed to
`($2::date)::timestamp at time zone 'Europe/London'` (the actual instant London midnight
occurs). Only occurrence of the pattern in `apps/api/src/routes`.

## Milestone 17 — synchronous live-state in `ingest-td` (ADR 0003 Tier 3) `[done — 2026-09-02]`

Milestone 16 measured on the deployed stack via a WebSocket sniffer: NR `eventAt` → browser
**mean 3.9 s, median 3.9 s, 0.98–7.5 s, n=16** — jittery, characteristic of a rolling backlog.
`projector-td-live` re-scans all nationwide C-Class `raw_feed_event` on its 100 ms tick with
~4 checkpoint round-trips per cycle, so each event waited 1–7 s for the checkpoint to reach it.

- **`apps/worker/src/shared/recordBrokerFrame.ts`** — the `raw_feed_event` insert now has a
  `RETURNING id, child_index, ingestion_sequence, normalized_event_at_utc` (no new round-trip);
  `RecordBrokerFrameResult` gains `insertedEvents: InsertedRawEvent[]` (joined back onto the
  parsed children by `child_index`). Additive — existing callers unaffected.
- **`apps/worker/src/td/liveProjector.ts`** — `bulkUpsertCurrentState` exported;
  `publishBerthDeltas` extracted (shared by the daemon and the inline path); new
  `applyLiveFromEvents(pool, redis, bindings, rows)` = fold CA/CB/CC → one guarded upsert →
  publish. `runProjectTdLive` now calls the shared helpers.
- **`apps/worker/src/commands/ingestTd.ts`** — creates a Redis client (gated on
  `LIVE_WS_REDIS_PUBSUB_ENABLED`, `.on('error')` handled) + a `BindingsCache`. In `onFrame`,
  **after** `recordFrame` + `markFrameAcked` + `handle.ack()`, it maps `result.insertedEvents`
  (C-class, CA/CB/CC) to `RawCClassRow`s and calls `applyLiveFromEvents` inside a `try/catch`
  (non-fatal — `projector-td-live` catches up from its checkpoint on failure/restart).
- **Invariants:** archive-before-ack (rule 2) untouched — inline work is strictly post-ack.
  `berth_current_state` now has three monotonic-guarded, `(td_area, berth_code)`-ordered
  writers; `ingest-td` sits at the feed head so it wins and the projectors' later writes for the
  same event are no-ops. `project-td-live` stays running (catch-up / `--rebuild` / restart gap).
- **Not done:** S3/MinIO PUT is still ahead of the inline publish (~10–30 ms local). Removing it
  needs an ADR call on reordering archive-before-ack — deferred unless still short of target.
- Tests: 3 new `applyLiveFromEvents` integration cases (upsert+delta for a bound berth;
  monotonic no-op; ignores non-CA/CB/CC). Full repo typecheck + lint + 315 unit tests green;
  worker + live-projector integration tests run in CI.

**Deploy:** pin `APP_TAG` to this commit's SHA, redeploy. No migration. Confirm `ingest-td`
logs no `inline live projection failed`, and re-measure NR→browser lag (target sub-second
server-side).

**Measured after deploy (2026-09-02, WebSocket sniffer on the live map, n=18):** NR `eventAt` →
browser **median 1.1 s, min 0.9 s** (down from Tier 2's 3.9 s median). The ~1 s floor is NR's
whole-second `eventAt` truncation + wire lag — level with OpenTrainTimes. Target met.

### Follow-up — duplicate deltas: attempted, reverted (2026-09-02)

The sniffer showed every berth step published **twice**: once by the `ingest-td` inline path
(~1 s), then again by `projector-td-live` (~80 ms–7 s later). Identical payload, so invisible on
the map, but wasted Redis/WS traffic.

First attempt `forwardWritesOnly` (`c0e7643`): publish only if the write strictly advances the
stored `source_ingestion_sequence`. **Reverted (`7ad3f44`)** — it dropped real deltas.
`berth_current_state` has a _third_ writer, `project-td-daemon`, which updates the row but never
publishes; when it won the race it advanced the sequence, so both publishers then saw "already
past" and skipped — the berth froze on the live map until a manual refresh (observed live:
`4S45`, `5N82`). Also fixed here: 3 stray NUL bytes `c0e7643`/`2cfeaa3` had left as map-key
separators in `liveProjector.ts` (internally consistent, so harmless, but `git` saw the file as
binary) — now plain spaces.

### Delta dedupe — done (2026-09-03)

`apps/worker/src/td/deltaPublisher.ts`: `publishDeltaIfNewer(mapSlug, berthKey, sequence,
message)` runs one Redis Lua script (`PUBLISH_IF_NEWER_LUA`) that atomically checks a per-berth
"last published sequence" hash (`railway:live:<slug>:pubseq`, 1-day EXPIRE refreshed each
publish), and publishes + advances it only if `sequence` is newer — replacing the plain
`PUBLISH` in `publishBerthDeltas`, so **no extra round-trip**. Whichever of the two publishers
(`ingest-td` inline, `projector-td-live`) reaches an event first sends it; the other's call
returns 0. `project-td` never calls it, so it can't suppress a real delta (the flaw that sank
`forwardWritesOnly`). Redis here is memory-only, so a Redis restart re-seeds the watermark on
the next delta per berth — at worst one duplicate per berth, once.

- `liveProjector.ts`: `RedisPublisher` interface replaced by `DeltaPublisher` (re-exported from
  `deltaPublisher.ts`); `publishBerthDeltas` calls `publishDeltaIfNewer` and returns the real
  publish count (a suppressed dup counts 0).
- `projectTdLiveDaemon.ts` / `ingestTd.ts`: keep the raw ioredis client for shutdown
  `.disconnect()` + an `.on("error")` handler; wrap it with `createRedisDeltaPublisher(...)` for
  the projectors.
- Integration test: both live writers process the same event through one shared Redis stand-in →
  the bound berth publishes **exactly once**.
- Full repo typecheck + lint + 315 unit tests green; worker integration tests run in CI.

## Next smallest task

Per the standing reprioritized order (`docs/IMPLEMENTATION_PLAN.md`'s "Execution order"):
**M6 → M11 → M12 → M7 → M8 → M9 → M10 → M13**. Everything through M9 is done (above); next up:
**Milestone 10** (snapshots and playback).

Still open regardless of order: the actual Preston/Carlisle TD `area_id`s used in
`packages/map-schema/fixtures/lancaster-minimal.json` (`PX`/`CL`) are owner-asserted, not
verified against real captured TD messages — confirm before treating any Lancaster binding as
real (CLAUDE.md "Confirm before hardcoding", Milestone 0).

Start each milestone in plan mode per `docs/CLAUDE_WORKFLOW.md` — read `CLAUDE.md` +
`docs/IMPLEMENTATION_PLAN.md` + the milestone-relevant doc, plan first, then implement.
