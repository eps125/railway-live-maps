# Architecture and Deployment

## 1. Architectural style

Use an event-sourced modular application, not a large fleet of microservices. The deployment must capture nationwide data from the outset while allowing only one map, Lancaster, to be published initially.

```text
Network Rail STOMP topics / downloaded source files
                       |
                       v
              recorder and raw archiver
                 |                |
                 v                v
       PostgreSQL event index   compressed object archive
                 |
          projectors/resolvers
            |             |
            v             v
 nationwide projections  map snapshots/history
            |             |
            +------ API --+
                   |
            REST + WebSocket
                   |
         React public UI/editor
```

The critical separation is:

- **Ingestion scope:** all subscribed TD areas, all TRUST/VSTP events and complete schedule/reference files.
- **Map scope:** only the elements bound into a published map.

No map allow-list may be used to discard source data.

## 2. Repository layout

```text
apps/
  api/                 Fastify REST/WebSocket server
  worker/              ingestion, archive, imports, projectors and jobs
  web/                 React/Vite public map and private editor
packages/
  domain/              domain types and pure reducers
  feed-parsers/        TD, TRUST, VSTP and schedule parsers
  map-schema/          canonical map types and validation
  database/            query layer and migrations
  archive/             S3-compatible immutable archive adapter
  protocol/            shared API/WebSocket contracts
  ui/                  reusable UI components where justified
docs/
deploy/
```

Use pnpm workspaces. A task runner is optional; do not add one until build time warrants it.

## 3. Initial containers

### `web`

- Serves the built React application.
- Proxies `/api` and `/ws` to `api` or relies on an existing reverse proxy.
- Contains no Network Rail or archive credentials.

### `api`

- Read-only public endpoints.
- Protected editor and diagnostics endpoints.
- WebSocket live updates.
- Reads PostgreSQL projections and published map bundles.
- Uses Redis pub/sub for low-latency fan-out when enabled.

### `worker`

One image may run different commands/roles:

- `ingest-td`
- `ingest-trust`
- `ingest-vstp`
- `import-schedule`
- `import-reference`
- `project-td`
- `project-trust`
- `resolve-runs`
- `snapshot-maps`
- `archive-audit`

For the first implementation, one worker process may host several modules. Split roles into separate containers only when measured throughput, restart isolation or operational control requires it.

`project-td` runs its own dedicated loop (`projector-td`), separate from `project-vstp`/`project-trust`/`project-resolver` (`projector-backlog`). Measured 2026-08-10: sharing one sequential loop let schedule/TRUST/resolver backlog work (which can legitimately take many seconds per invocation) block `project-td` for as long as it ran, stalling live berth positions for up to ~25s. `project-td` is latency-critical (it feeds the live map directly); the other three are correctness-important but not latency-critical, so they run in their own loop and may lag behind real-time independently without affecting live rendering.

### `postgres`

Authoritative database for:

- all normalized nationwide feed events
- frame/event lineage and archive indexes
- nationwide berth and S-Class projections
- all train runs and schedule/reference data
- occupancy history and resolver decisions
- drafts, published map versions and snapshots

Use named persistent storage. All application containers run in UTC.

### `archive`

S3-compatible object storage, with MinIO acceptable for the Portainer development stack. Store immutable compressed objects for:

- complete broker frame bodies before parsing
- downloaded schedule/reference source files
- optional exported event partitions and backups

Object keys must be deterministic and content checksummed. A successful archive write is not a substitute for the PostgreSQL event index; both are required before acknowledgement.

### `redis`

Optional ephemeral pub/sub, cache and coordination. Redis must never be the source of truth. Redis loss must not destroy history.

### Monitoring

Expose metrics from the beginning. Prometheus/Grafana may be added later or existing monitoring may scrape the application endpoints.

## 4. Network Rail connectivity and capture scope

### TD

Subscribe to the nationwide TD topic. Decompress each broker frame and retain **every child event from every TD area**:

- C-Class berth events and heartbeats
- S-Class messages where supplied
- message types not yet understood by the application
- malformed child payloads with parse-failure metadata where they can be isolated safely

Lancaster/Preston has no usable S-Class data, so Lancaster signals remain blank. This does not change nationwide S-Class capture.

The actual Preston TD `area_id` must be confirmed from captured messages before creating Lancaster berth bindings. It is map metadata, not an ingestion setting.

### TRUST

Subscribe to the nationwide TRUST movement topic and retain all activation, cancellation, movement, reinstatement, change-of-origin, change-of-identity and change-of-location events. Do not filter to trains that pass Lancaster.

### VSTP

Subscribe to the nationwide VSTP topic and retain all events.

### SCHEDULE

Download and archive the complete available schedule extract, then import it transactionally. Do not import a Lancaster-only subset and do not assume passenger-only data is sufficient.

Full imports are preferred initially. Incremental update support may be added after full-import correctness is established.

### Reference data

Archive and import complete permitted CORPUS, SMART and other required reference datasets. Preserve source version, checksum and import lineage.

## 5. Durable broker handling

Requirements:

- Use one connection capable of multiple subscriptions rather than one connection per feed.
- Use unique client IDs and durable subscriptions where supported.
- Use STOMP heartbeats and client acknowledgement.
- Broker bodies may be gzip-compressed.
- Reconnect with exponential backoff, jitter and a cap.
- Record every connection session, disconnect reason and detected gap.
- Do not retry permanent authentication errors indefinitely.
- Never acknowledge a frame merely because it was parsed in memory.

Processing sequence:

1. Receive a broker frame and capture transport metadata.
2. Compute a body checksum and deterministic archive key.
3. Write the complete original body to immutable object storage.
4. Decompress and parse the complete child-message list.
5. Insert the frame index, every child event, parse outcomes and archive reference in PostgreSQL.
6. Commit the PostgreSQL transaction.
7. Acknowledge the broker frame.
8. Notify projectors after commit.

The archive and PostgreSQL transaction cannot be atomically committed together. Therefore:

- archive writes must be idempotent by deterministic key/checksum
- database inserts must be idempotent under broker redelivery
- orphaned archive objects must be discoverable by an audit job
- database rows referencing a missing archive object must trigger an alert and block acknowledgement

Unknown source message types are retained as raw child events with `parse_status=unsupported`, not discarded.

## 6. Processing model

### Nationwide recorder

The recorder does not know which maps exist. It records every subscribed event and assigns a monotonic ingestion sequence.

### TD projectors

- Project C-Class current berth state and occupancy intervals for every observed TD area.
- Maintain area-level heartbeat/freshness state.
- Store S-Class messages and maintain generic current address/bit state where the payload can be decoded safely.
- Do not infer signal aspects or signal meaning.

### TRUST/VSTP/schedule projectors

- Build all train runs and lifecycle events nationwide.
- Link activations to schedules when exact source keys allow.
- Retain unmatched links for later resolution after schedule imports.

### Map projector

The map projector joins published bindings to nationwide projections. It emits only map-relevant deltas to a particular map WebSocket, but it never controls ingestion or retention.

### Resolver

- Associates berth occupancies with train runs using evidence.
- Stores candidate scores, algorithm version and evidence.
- Can be rerun without modifying raw events.
- Uses map/corridor evidence only as one resolver signal, not as a storage filter.

### Snapshotter

- Creates complete map-state snapshots at a configurable interval, initially 60 seconds for active published maps.
- Snapshots refer to map version, projection version and source event sequence.
- Nationwide raw/history data remains available even for areas without snapshots or maps.

## 7. Storage and scale

Nationwide capture is a present requirement, so storage design cannot be deferred until after Lancaster.

- Partition high-volume event tables by event/ingestion month from the first migration.
- Use BRIN indexes for append-ordered time/sequence scans and selective B-tree indexes for area, berth, train ID and description queries.
- Keep bulky original broker bodies in compressed object storage rather than duplicating every frame body in PostgreSQL.
- Keep normalized child events and queryable movement facts in PostgreSQL.
- Record daily event counts and byte growth by feed and TD area.
- Alert on free disk, database growth, archive growth and failed archive writes.
- Do not enable deletion until archive verification, backup and restore/reprocessing tests have passed.

A single development server is acceptable initially, but PostgreSQL and archive volumes must be independently visible and backed up. One server/disk is not a backup.

## 8. Deployment in Portainer

Recommended flow:

1. Keep Compose files in Git.
2. Build immutable application images in CI and push them to a registry.
3. Configure a Portainer stack from the repository or uploaded Compose file.
4. Set deployment-specific values and secrets in Portainer.
5. Pull explicit application tags; do not use `latest` for production application images.
6. Run migrations as an explicit release step before replacing application containers.
7. Verify PostgreSQL and archive backups before enabling indefinite live capture.

For a private development server, local builds and a development MinIO container are acceptable. Only the reverse proxy/web entry point should be public. PostgreSQL, Redis and object storage remain on internal Docker networks.

## 9. Configuration

Validate configuration at startup and fail fast on missing values.

Key settings:

- `APP_ENV`
- `PUBLIC_BASE_URL`
- `DATABASE_URL`
- `REDIS_URL`
- `RAW_ARCHIVE_ENDPOINT`
- `RAW_ARCHIVE_BUCKET`
- archive access key/secret through mounted secrets where possible
- `NR_USERNAME_FILE` / `NR_PASSWORD_FILE` or development equivalents
- `NR_TD_TOPIC`
- `NR_TRUST_TOPIC`
- `NR_VSTP_TOPIC`
- `CAPTURE_ALL_TD=true` as a required invariant
- `LANCASTER_MAP_SLUG`
- `DISPLAY_TIMEZONE=Europe/London`
- freshness thresholds
- snapshot interval
- retention settings
- editor enable/auth settings

There must be no `ACTIVE_TD_AREAS` or equivalent ingestion allow-list.

## 10. Health, status and metrics

Expose:

- `/health/live`
- `/health/ready`
- `/metrics`
- `/api/v1/status`

Track at least:

- broker connection and session duration by feed
- last frame and last child event by feed
- C-Class, S-Class and unsupported event counts by TD area
- last heartbeat by area
- archive write latency/failures and missing-object audits
- receive, archive, database and projection lag
- events and bytes per minute/day
- gzip/JSON/parser failures
- duplicate/redelivery counts
- projector checkpoint and lag
- unresolved/ambiguous run counts
- schedule/reference import age and result
- map snapshot age
- WebSocket clients and dropped connections
- PostgreSQL size/partition growth and pool saturation
- archive size and filesystem free space

The status page must distinguish upstream feed delay, recorder failure, archive failure, database failure, projection lag, schedule-data failure, storage pressure and playback impairment.

## 11. Backup and recovery

Before public use or indefinite unattended capture:

- Nightly PostgreSQL backup to storage outside the PostgreSQL volume.
- Object archive replication or backup outside the archive volume/server.
- Documented database and archive restore procedures.
- Periodic restore and event-reprocessing tests.
- Published map JSON also exported to Git or backup storage.
- Application image tags and schema versions recorded with backups.

A verified `pg_dump` process is acceptable while small. Move to physical/WAL backups when logical backup time or database size makes them unsuitable.

## 12. Security

- Public APIs are read-only and rate-limited.
- Raw nationwide feeds and diagnostic endpoints are private by default.
- Editor endpoints are disabled or private by default.
- Prefer private networking/Tailscale or upstream OIDC for the first owner-only editor.
- Validate all map JSON and labels before publication.
- Apply request-size, result-count and time-range limits.
- Use a strict Content Security Policy.
- Never expose Network Rail credentials, archive credentials, sensitive broker headers, stack environment or raw exception internals.
