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
  `ZY`), deliberately not `PN`.
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

## GitHub / Docker / CI-CD

- `.github/workflows/ci.yml`: `build-and-test` job (lint, format check, typecheck, unit
  tests, build, MinIO + Postgres + Redis service containers, migrate, ensure-archive-bucket,
  connectivity check, `test:integration`, fixture replay smoke, Docker image builds); a
  `publish` job (push to `main` only) builds and pushes `ghcr.io/<owner>/<repo>-{api,worker,web}`
  using the built-in `GITHUB_TOKEN`.
- **Not yet done**: the repo has not been pushed to GitHub — that needs the owner to create
  the actual repository (no `gh` CLI in this sandbox) and give the go-ahead to push, per
  the safety rules on publishing. `docs/DEPLOYMENT.md` has the full runbook once that
  happens.

### Known limitations (unchanged from M1, plus)

- No Docker in this sandbox — Dockerfiles/Compose reviewed but not build-verified locally;
  CI does build them.
- No MinIO/S3 in this sandbox — archive-touching integration tests use an in-memory fake
  S3 client; real S3 connectivity is proven only in CI and via `packages/archive`'s own
  mocked-client unit tests.
- `apps/worker/src/td/connection/stomp/stompConnection.ts` has never connected to a real
  broker (by design — gated off, and there's nothing to connect to here). Verify it for
  real before ever setting `TD_LIVE_ENABLED=true`.

## Next smallest task

Milestone 4 (`docs/IMPLEMENTATION_PLAN.md`): nationwide TD projections and history —
CA/CB/CC/CT reducers actually populating `berth_current_state`/`berth_occupancy` for every
observed area, mismatch/anomaly recording, S-Class current-state storage, area/berth
discovery and history REST endpoints, projector checkpoint/rebuild command (the
`projection_checkpoint` framework from M2 finally gets a caller). Start in plan mode per
`docs/CLAUDE_WORKFLOW.md`.
