# Bounded Implementation Plan

Do not ask Claude to build the entire product in one task. Complete and verify one milestone before moving on.

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

## Milestone 5 — canonical map schema and basic Lancaster renderer

- Versioned map schema/validator.
- One hand-authored minimal Lancaster test document.
- Published map tables/compiler.
- SVG renderer with pan/zoom and berth click target.
- REST map definition/state endpoint.
- Lancaster signals render blank.
- Lancaster TD area identifier comes from verified map configuration, not ingestion filtering.

No visual editor yet; prove the canonical model first.

## Milestone 6 — live WebSocket

- Snapshot plus sequenced delta protocol.
- Redis pub/sub optional adapter.
- Map-specific filtering after nationwide projection.
- Browser gap detection/resync.
- Live/stale banner.
- Reconnect behavior.

Done when nationwide fixture replay updates Lancaster only for its published bindings, without discarding other-area events.

## Milestone 7 — complete schedule/reference and VSTP import

- Archive complete source files before import.
- Daily full schedule importer using streaming parsing.
- Transactional staging/import swap or versioned activation.
- Nationwide VSTP parser/storage.
- Complete TIPLOC/location/SMART/reference import.
- Schedule query endpoint.
- Import status and metrics.

Test STP precedence, natural keys, complete-file checksums and restart/reimport behavior.

## Milestone 8 — nationwide TRUST runs and activation linkage

- TRUST parser for supported message types.
- Store every nationwide TRUST event.
- Train-run lifecycle tables.
- Exact activation-to-schedule link.
- Identity/change/cancellation handling.
- Latest report projection and nationwide run query.

Done when fixtures for unrelated regions and Lancaster are both retained and correctly linked without rewriting history.

## Milestone 9 — berth-to-run resolver and popup

- Candidate generation/scoring.
- `matched`, `ambiguous` and `unmatched` states.
- Evidence and resolver version storage.
- Lancaster run popup and full schedule view.
- Latest TRUST variation with report age/location.
- Resolver works against nationwide run data while accepting map/corridor context as evidence.

Never claim exact continuous punctuality.

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

## Milestone 12 — editor test and publishing workflow

- Simulated/live/historical test modes.
- Nationwide binding diagnostics and observed-berth autocomplete.
- Draft revisions and optimistic locking.
- Validation gates.
- Immutable publish with effective date.
- Compiled runtime bundle and binding index.
- Version diff/review.

Done when Lancaster can be created, edited and published with no frontend source edit.

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

## Later milestones

- Additional authored/public maps using already-retained nationwide history.
- S-Class blank/on/off bindings for areas where usable data exists.
- Map continuation/follow-train behavior.
- Bulk binding import and binding-discovery assistance.
- Physical/WAL backups and external archive replication.
- Horizontal worker scaling if measured load requires it.
