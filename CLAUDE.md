# Railway Live Maps — Claude Instructions

## Purpose

Build a self-hosted, non-safety-critical nationwide railway data recorder and live signalling-map platform using Network Rail open data. Ingestion is nationwide from the outset: retain all subscribed TD, TRUST and VSTP events and import the complete available timetable/reference datasets. Lancaster is only the first authored/public map, within the Preston signalling/train-describer area. The system must support live berth display, nationwide movement history, schedule/TRUST resolution, historical playback, berth-history queries, and a private visual map editor.

## Read before working

Read only the documents relevant to the current task:

- Product behavior: `docs/PROJECT_SPEC.md`
- Architecture/deployment: `docs/ARCHITECTURE.md`
- Database/events: `docs/DATA_MODEL.md`
- Editor/map format: `docs/MAP_EDITOR_SPEC.md`
- API: `docs/API_CONTRACT.md`
- Current milestone: `docs/IMPLEMENTATION_PLAN.md`

Do not repeatedly load every document when one or two are sufficient.

## Non-negotiable requirements

1. Raw events from every subscribed feed and every TD area are append-only and retained before they are projected; map scope must never be used as an ingestion filter.
2. A Network Rail broker message is acknowledged only after its complete original frame has been archived and every child event has been durably indexed, including unsupported or malformed children with a recorded parse outcome.
3. Current state, history and playback are derived projections and must be rebuildable.
4. Store raw and normalized timestamps. Store canonical timestamps in UTC and render user-facing times in `Europe/London`.
5. Never assume a four-character berth description uniquely identifies a train run.
6. TRUST activation is the authoritative link between a run and a schedule when available.
7. Resolver results must be `matched`, `ambiguous` or `unmatched`; never hide ambiguity.
8. Lancaster/Preston has no usable S-Class data. Lancaster signal symbols remain blank, while S-Class events from other areas are still captured and retained.
9. Future signals use only `blank`, `on` and `off`. Red means on; green means off. Never calculate or claim yellow, double-yellow or green physical aspects.
10. Never infer signal state from train movements, routes, occupation, timetable data or adjacent signals.
11. Published map versions are immutable and have effective date ranges.
12. The editor produces canonical map JSON, never React/SVG source as authoritative output.
13. The public renderer and editor preview consume the same domain model and state semantics.
14. Do not scrape Vail Data, Traksy or OpenTrainTimes. They are product inspiration only. Unless authorised on a case by case basis by live chat or otherwise.
15. Do not expose Network Rail credentials to the browser, repository or logs.
16. The application must be clearly labelled non-safety-critical and not official.
17. Nationwide capture and map publication are separate concerns: the absence of a map must not prevent storage, projection or history queries for an area.
18. Unknown or not-yet-supported source message types must be retained with lineage rather than silently discarded.

## Confirm before hardcoding

The Preston TD area is `PX` (confirmed by the owner) — not `PN`; do not use `PN` anywhere in this project. Still verify the incoming `area_id` on captured messages matches `PX` before creating Lancaster bindings, since public reference material may disagree. This identifier affects Lancaster map bindings only; it must never limit nationwide ingestion. Signal labels may legitimately use a different prefix.

## Chosen technical direction

- TypeScript monorepo using pnpm workspaces.
- React + Vite public frontend and editor.
- SVG public map renderer.
- Konva/react-konva editor canvas.
- Fastify API with REST and WebSocket endpoints.
- PostgreSQL as the authoritative database for normalized nationwide events, projections, schedules, histories, drafts and maps.
- S3-compatible object storage for compressed immutable raw broker frames and source files; MinIO is acceptable for the development Portainer stack.
- Redis only for ephemeral pub/sub, cache and coordination; never as source of truth.
- SQL migrations and a type-safe query layer; do not make the event model depend on ORM magic.
- Vitest for unit/integration tests and Playwright for browser tests.
- Docker Compose deployment managed as a Portainer stack.
- Images should be immutable and version-tagged in deployment environments.

Material changes to these choices require an ADR and owner approval.

## Engineering rules

- Work on one milestone at a time.
- Before editing, state the files to be changed and the acceptance criteria being addressed.
- Prefer the smallest coherent implementation, but do not implement area filtering: nationwide capture is a current requirement. Add partitioning and storage observability early enough to make that safe.
- Keep feed parsers pure and fixture-driven.
- Make projections idempotent and checkpointed.
- Every normalized row must retain lineage to its source event.
- Use database constraints for invariants, not comments alone.
- Do not silently repair source data. Preserve raw values and record normalization/correction reasons.
- Use structured logs and never log secrets or full credentials.
- Add tests for every bug fix.
- Run formatter, type-checker, tests and database migration checks before declaring completion.
- Do not perform destructive migrations or delete retained events without explicit approval.
- Update the milestone checklist and relevant documentation in the same change.

## Output expectations for each task

At completion, report:

1. Files changed.
2. Behavior implemented.
3. Tests run and result.
4. Migrations/configuration required.
5. Known limitations or follow-up work.

Do not claim tests passed unless they were actually run.
