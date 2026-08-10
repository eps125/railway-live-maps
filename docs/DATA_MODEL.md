# Event and Data Model

## 1. Principles

- Source events are immutable.
- Every subscribed event is retained regardless of TD area or current map coverage.
- Projections are disposable and rebuildable.
- Every derived record retains source lineage.
- Normalization never destroys raw values.
- Identifiers are composite where required; a berth is `(td_area, berth_code)`, not berth code alone.
- Nationwide capture requires partitioning, storage metrics and archive lineage from the first production-capable migration.
- Map bindings select from nationwide data; they do not control ingestion.

## 2. Time fields

For source events retain:

- `raw_source_timestamp_ms`
- `raw_source_timestamp_text` where applicable
- `normalized_event_at_utc`
- `received_at_utc`
- `broker_queue_at_utc` where available
- `ingestion_sequence`
- `timestamp_correction_code`
- `timestamp_correction_details`

Display in `Europe/London`. Preserve schedule service dates separately from timestamps.

TD has rare timestamp anomalies around midnight; TRUST contains documented DST/BST irregularities in several fields. Corrections must use explicit tested plausibility rules and retain raw values.

## 3. Raw archive and feed lineage

### `feed_connection_session`

- `id`
- `feed_name`
- `client_id`
- `connected_at`
- `disconnected_at`
- `disconnect_reason`
- `last_frame_at`
- `created_gap_id`

### `raw_archive_object`

Index for immutable objects in S3-compatible storage:

- `id`
- `object_key` unique
- `bucket`
- `content_sha256`
- `content_encoding`
- `content_type`
- `compressed_size_bytes`
- `uncompressed_size_bytes` nullable
- `created_at`
- `verified_at` nullable
- `verification_status`
- `source_kind`: broker frame, schedule file, reference file, export or backup

The actual bytes live in object storage. PostgreSQL holds the authoritative index and checksums.

### `feed_frame`

- `id`
- `feed_name`
- `topic`
- `broker_message_id`
- `headers_json`
- `received_at`
- `body_hash`
- `archive_object_id`
- `child_count`
- `parsed_child_count`
- `unsupported_child_count`
- `failed_child_count`
- `parse_status`
- `acked_at`
- `connection_session_id`

Every accepted broker frame must reference an archived original body.

### `raw_feed_event`

One row for every child event in every subscribed broker frame:

- `id`
- monotonic `ingestion_sequence`
- `frame_id`
- `child_index`
- `feed_name`
- `event_type`
- `message_class` nullable
- `td_area` nullable
- `raw_event_json`
- raw and normalized timestamps
- `semantic_hash`
- `received_at`
- `parse_status`: parsed, unsupported, malformed or duplicate-redelivery
- `parse_error_code` nullable
- `parse_version`

Unknown/not-yet-supported child messages must be stored with `parse_status=unsupported`. Do not silently drop them.

Use idempotency keys based on broker metadata plus child index/hash, while retaining redelivery metrics. Do not collapse genuinely identical source events that were separately emitted.

### `feed_gap`

- feed and optional TD area
- detected start/end
- detection reason
- recoverability
- affected sequence/time range
- operator note

## 4. TD C-Class model

### `td_berth_event`

Normalized CA/CB/CC event:

- `raw_event_id`
- `td_area`
- `message_type`
- `from_berth`
- `to_berth`
- `description`
- `event_at`
- `ingestion_sequence`
- `normalization_version`

### `td_heartbeat`

- `raw_event_id`
- `td_area`
- `report_time`
- `event_at`
- `received_at`

### `berth_current_state`

Projection keyed by `(projection_version, td_area, berth_code)`:

- current description nullable
- occupancy ID nullable
- event time
- source event ID
- source ingestion sequence
- data-quality state

This table covers every observed TD area, including areas without maps.

### `berth_occupancy`

- `id`
- `projection_version`
- `td_area`
- `berth_code`
- `description`
- `entered_at`
- `left_at` nullable
- `entry_event_id`
- `exit_event_id` nullable
- `entry_reason`
- `exit_reason`
- `resolved_run_id` nullable
- `resolution_status`
- `anomaly_flags`

Indexes:

- `(td_area, berth_code, entered_at desc)`
- `(description, entered_at desc)`
- `(resolved_run_id, entered_at)`
- BRIN on `entered_at`
- indexes supporting bounded time-window queries

### C-Class projection behavior

`descr` of `"----"` (four literal hyphens) is a real Train Describer convention for a
signaller manually blanking a berth's display, not a genuine headcode (confirmed against real
production data, 2026-08-10). It is treated as "no train" throughout: never opens a new
occupancy carrying it, and never compared against a `from`-berth's real description (a
placeholder can never meaningfully mismatch a real headcode). Closing behavior is unaffected —
message type alone determines whether something physically left a berth.

`CA(from,to,descr)`:

1. Close any open occupancy in `from` at event time.
2. Close any open occupancy in `to` at event time with reason `overwritten_by_step`.
3. Open `to` with `descr` — unless `descr` is `"----"`, in which case `to` is left cleared.
4. Record a mismatch anomaly if `from` was empty or contained another description — skipped
   entirely when `descr` is `"----"`.

`CB(from,descr)`:

1. Close any open occupancy in `from`.
2. Record a mismatch if empty or different — skipped entirely when `descr` is `"----"`.

`CC(to,descr)`:

1. Close any open occupancy in `to` with reason `overwritten_by_interpose`.
2. Open `to` with `descr` — unless `descr` is `"----"`, in which case `to` is left cleared.

`CT` updates area health only.

Do not reject a valid event because projected state is unexpected.

## 5. TD S-Class model

Lancaster has no usable S-Class data, but all S-Class events from other areas must be retained.

### `td_s_event`

Generic normalized record preserving source semantics without pretending every area is mapped:

- `raw_event_id`
- `td_area`
- `message_type`
- `address` or source key where supplied
- raw data word/value
- decoded bitset nullable
- `event_at`
- `ingestion_sequence`
- `normalization_version`
- `decode_status`

### `td_s_current_state`

Map-independent current state keyed by `(projection_version, td_area, address/source_key)`:

- current raw word/value
- decoded bitset nullable
- last event time
- source event ID
- source ingestion sequence
- freshness state

### `td_s_bit_transition`

Optional normalized bit transitions when decoding is well-defined:

- `td_area`
- address/source key
- bit index
- previous value nullable
- new value
- event time
- source event ID
- projection version

The system stores bit facts only. Signal meaning comes from an explicit versioned map binding. No aspect, route or signal inference is permitted.

## 6. Schedule and reference data

### `source_file_import`

Tracks complete downloaded files:

- source kind
- archive object ID
- checksum
- effective period/version
- started/completed time
- row counts
- status and error summary

### `schedule`

Natural uniqueness includes:

- `train_uid`
- `schedule_start_date`
- `schedule_end_date`
- STP indicator/schedule type
- source/version as required

Retain:

- signalling ID/headcode where supplied
- operator/business code
- train service code
- train category/status/power type fields
- cached origin/destination
- source `SCHEDULE` or `VSTP`
- raw source lineage

Import the complete available dataset, not only schedules that traverse published maps.

### `schedule_location`

- `schedule_id`
- ordered sequence
- TIPLOC
- STANOX where resolved
- arrival/departure/pass times, public and working
- platform, path and line
- activity codes
- day offset

### `location_reference`

TIPLOC, STANOX, CRS, NLC, UIC, names and geography with source/version.

### `smart_berth_step`

Retain complete permitted SMART fields and source version. Use as evidence, not proof that every relationship is complete. No natural key exists on the wire, so a dedicated unique index (`td_area`, `from_berth`, `to_berth`, `event_type`, coalesced for nullable fields) makes reimport idempotent.

### `import_unhandled_record`

File-based ingestion has no per-message ack to hang lineage off the way STOMP frames do (`raw_feed_event`'s per-child `parse_status` serves that role there) — this table is the equivalent for SCHEDULE/CORPUS/SMART file imports: every record type outside an importer's modeled scope (e.g. `AssociationV1`/`TiplocV1` lines inside a SCHEDULE extract) and every malformed line is retained here with `source_file_import_id`/`record_type`/`seq_no_in_file`/`raw_json`, never silently discarded (CLAUDE.md rule 18).

## 7. Nationwide train-run model

### `train_run`

A single operational run:

- internal UUID
- `trust_train_id` unique within appropriate source/date scope
- extracted four-character signalling description
- service date
- linked schedule ID nullable
- activation time
- origin departure timestamp
- call type/mode where supplied
- operator/service code
- lifecycle state
- last event time

### `train_run_event`

Every normalized nationwide TRUST message with raw lineage. Partition/index by event time and train run. Do not filter to map corridors.

### `run_schedule_link`

Normally created from activation. Retain exact activation fields and outcome if the referenced schedule is temporarily missing and linked later.

### `berth_run_resolution`

- occupancy ID
- selected train run nullable
- status: `matched`, `ambiguous`, `unmatched`
- confidence score
- resolver version
- decision time
- candidate/evidence JSON
- manual override metadata if later supported

## 8. Run resolver

A four-character description is only a candidate key.

Evidence in descending importance:

1. Exact active TRUST run with matching signalling identity.
2. Activation directly linked to a valid schedule for the service date.
3. Temporal plausibility around booked and actual times.
4. Continuity from preceding berth occupancy/run links.
5. SMART berth/STANOX evidence.
6. A selected map or queried corridor's TIPLOC/STANOX coverage.
7. Operator and direction consistency where known.

Output all plausible candidates and evidence. Thresholds belong in versioned resolver configuration and tests.

Map/corridor evidence improves a decision but never controls whether a run or event is stored.

## 9. Map tables

### `map`

- stable map ID/slug
- name and description
- owner metadata

### `map_draft`

**Implemented (Milestone 11/12):** migration `0011_map_draft.sql`.

- canonical document JSON
- revision number
- updated by/at
- base published version

One row per map `slug` (no multi-user collaborative editing — `docs/PROJECT_SPEC.md` §10's
explicit MVP exclusion). `slug` is unique and independent of `map`/`map_id` (nullable, set
once the draft is first published) so a draft can exist before the map has ever been
published. `GET /api/v1/editor/maps/{slug}/draft` seeds a fresh draft on first access — from
the currently published version's canonical document if one exists, otherwise a blank
scaffold.

### `map_draft_revision`

**Implemented (Milestone 11/12):** migration `0011_map_draft.sql`.

- immutable draft snapshots or command batches
- author/time/comment

One row inserted per successful `PUT .../draft` save. `docs/PROJECT_SPEC.md` §9 requires at
least 90 days of draft revision history; automatic pruning after that window is not
implemented yet (Milestone 13 operational-hardening concern).

### `map_version`

- immutable canonical document JSON
- compiled runtime bundle JSON
- version number
- `effective_from`
- `effective_to`
- published by/at
- schema version
- checksum

### `map_binding_index`

**Implemented (Milestone 6):** migration `0010_map_binding_index.sql`. Generated at
publication:

- map version
- element ID
- binding type
- TD area
- berth/address/bit as relevant

Two partial unique indexes enforce the real invariant per binding type — one element bound to
one TD berth source, or one S-bit source, per published map version — rather than a single
all-columns unique. Populated automatically by the `publish-map` worker command; versions
published before this migration existed were backfilled once via the idempotent
`backfill-map-bindings` command.

### `map_state_snapshot`

- map version
- projection version
- snapshot time
- last event sequence
- compressed state
- checksum

## 10. Projection/version tables

### `projection_definition`

Name, code version and configuration hash.

### `projection_checkpoint`

Projection name/version, last ingestion sequence, last completed time and error state.

Rebuilding creates a new projection version or isolated staging projection, validates it, then atomically switches readers.

## 11. Partitioning and scale

Create time partitions from the first nationwide-capable migration for:

- `raw_feed_event`
- `td_berth_event`
- `td_s_event`
- `td_s_bit_transition`
- `train_run_event`
- `berth_occupancy`

Recommended initial partition key is normalized event month, with a safe default partition for malformed/unresolved timestamps. Partition creation must be automated ahead of time and tested across month boundaries.

Use:

- BRIN indexes on append-ordered event time and ingestion sequence
- B-tree indexes for `(td_area, berth)`, description, train ID and resolver lookups
- archive checksums to rehydrate/reprocess events
- daily aggregate tables or metrics for event/byte counts by feed and area

Do not add an area-retention filter. Storage control must use compression, partition maintenance, verified tiered archival and explicit retention policy—not silent loss of unmapped-area data.
