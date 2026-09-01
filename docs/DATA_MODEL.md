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
- occupancy ID nullable — **NULL in steady state since ADR 0003** (its primary writer, the fast
  `project-td-live` projector, does not manage `berth_occupancy`). Treat `description IS NOT NULL`
  as the "occupied" signal; read `berth_occupancy` directly for the occupancy id.
- occupancy entered at — kept correct by the live projector (the `event_at` of the CA/CC that set
  the description)
- event time
- source event ID
- source ingestion sequence
- data-quality state

Two writers (ADR 0003): `project-td-live` (real-time, the hot path) and `project-td` (catch-up /
`--rebuild`). Both upserts carry the monotonic guard `excluded.source_ingestion_sequence >=
berth_current_state.source_ingestion_sequence` and sort rows by `(td_area, berth_code)`, so
neither can regress the other and there is no deadlock cycle.

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

> **ADR 0002 (2026-09-01):** RLM no longer runs its own SCHEDULE/VSTP importer. `schedule` /
> `schedule_location` are replaced by `cif_schedules` / `cif_schedule_locations` — a near-verbatim
> mirror of the operator's openrail-eps ("garner") tables, populated by `ingest-garner`
> (`apps/worker/src/garner/bridge.ts`), migration 0024. garner is the NR-subscribed retention
> layer for this feed; "raw with lineage" here is the garner row + `(cif_schedules.id, created)`.

### `source_file_import`

Tracks complete downloaded files (CORPUS/SMART only, since ADR 0002):

- source kind
- archive object ID
- checksum
- effective period/version
- started/completed time
- row counts
- status and error summary

### `cif_schedules`

Near-verbatim mirror of garner `cif_schedules` (column names lowercased). Primary key is garner's
own `id` so the bridge is a pure upsert-by-id. Notable columns:

- `cif_train_uid`, `cif_stp_indicator` (`C`/`N`/`O`/`P`), `signalling_id`
- `schedule_start_date` / `schedule_end_date` — `date`, converted from garner's epoch INTs
- `runs_mo`..`runs_su` booleans + generated `days_runs_bitmask` (7-char Mon..Sun `1`/`0`)
- `created` / `deleted` — `timestamptz`; garner (openrail cifdb) marks a _live_ row with
  `deleted = 0xffffffff` (its `NOT_DELETED` sentinel) and a withdrawn row with the real epoch.
  The bridge writes NULL for the sentinel and the real timestamp otherwise; every "candidates
  for matching" query filters `deleted is null`. The bridge keeps two watermarks —
  `garner-cif_schedules-id` on garner's auto-increment `id` for new/amended rows (never seeded
  forward — every live schedule must be mirrored; `created` is unusable as a cursor because a
  full CIF reload stamps ~300k rows with one identical value) and `garner-cif_schedules-deleted`
  on `deleted` for withdrawals.
- `atoc_code`, `cif_train_service_code`, `cif_train_category`, `train_status`, `cif_power_type`,
  `deduced_headcode` (garner's own headcode deduction for schedules lacking a signalling id)

Origin/destination TIPLOC are **not** stored — derived from the first/last calling point.

### `cif_schedule_locations`

Near-verbatim mirror of garner `cif_schedule_locations`. `(cif_schedule_id, seq_no)` primary key,
`seq_no` assigned by the bridge in garner's `sort_time` order (garner has no ordering column).

- `record_identity` (`LO`/`LI`/`LT`), `location_type` (garner's misnamed column — actually the
  packed CIF activity string), `tiploc_code`
- `arrival` / `departure` / `pass` (working) + `public_arrival` / `public_departure` — raw
  CIF HHMM(H) strings exactly as garner supplies them
- `platform`, `path`, `line`, `next_day`, `sort_time`

### `location_reference`

TIPLOC, STANOX, CRS, NLC, UIC, names and geography with source/version.

### `smart_berth_step`

Retain complete permitted SMART fields and source version. Use as evidence, not proof that every relationship is complete. No natural key exists on the wire, so a dedicated unique index (`td_area`, `from_berth`, `to_berth`, `event_type`, coalesced for nullable fields) makes reimport idempotent.

### `import_unhandled_record`

File-based ingestion has no per-message ack to hang lineage off the way STOMP frames do (`raw_feed_event`'s per-child `parse_status` serves that role there) — this table is the equivalent for SCHEDULE/CORPUS/SMART file imports: every record type outside an importer's modeled scope (e.g. `AssociationV1`/`TiplocV1` lines inside a SCHEDULE extract) and every malformed line is retained here with `source_file_import_id`/`record_type`/`seq_no_in_file`/`raw_json`, never silently discarded (CLAUDE.md rule 18).

## 7. Nationwide TRUST model

> **ADR 0002 (2026-09-01):** RLM's bespoke `train_run` / `train_run_event` / `run_schedule_link`
> model was **dropped** (migration 0025). TRUST data is now a near-verbatim mirror of garner's
> `trust_*` tables, populated by `ingest-garner`, watermarked by each table's `created` column in
> `projection_checkpoint` under `garner-<table>` names. RLM keeps its synced rows after garner
> archives them at ~15 days, so the mirror is still RLM's own long-term nationwide TRUST history.

- **`trust_activation`** — `trust_id`, `created`, `cif_schedule_id` (garner's link to
  `cif_schedules.id`; NULL when garner could not deduce one — deliberately not an FK),
  `deduced` flag.
- **`trust_activation_extra`** — the full activation payload: `train_uid`, `toc_id`,
  `schedule_wtt_id`, `schedule_type`, `origin_dep_timestamp`, origin STANOX, etc.
- **`trust_movement`** — `trust_id`, `created`, `loc_stanox`, `platform`, `actual_timestamp` /
  `gbtt_timestamp` / `planned_timestamp`, `timetable_variation` (unsigned magnitude in minutes),
  `flags` (bit-field: event kind + early/on-time/late/off-route + terminated + correction, decoded
  by `packages/domain/src/trust/garnerMovement.ts`), `next_report_stanox` / `next_report_run_time`.
- **`trust_cancellation`** / **`trust_changeorigin`** / **`trust_changeid`** /
  **`trust_changelocation`** — mirrored as-is.

## 8. Berth-to-run correlation

> **ADR 0002 (2026-09-01):** RLM's Milestone 9 berth-run resolver (`berth_run_resolution`,
> `packages/domain/src/resolver/`, `apps/worker/src/resolver/`, `project-resolver`) was **removed
> wholesale** — it was the single largest source of production incidents. It is to be **rebuilt in
> a later phase** on top of garner's own correlation work (`trust_activation.cif_schedule_id`,
> `deduced_headcode`, SMART berth-offset tracking).
>
> Interim, the click-a-berth popup (`GET .../current-run`) shows the TD headcode plus every
> mirrored `cif_schedules` row matching that headcode today, with the STP-effective one (or the
> one a `trust_activation` today confirms) expanded — explicitly labelled as garner's data, not an
> RLM `matched`/`ambiguous`/`unmatched` verdict. CLAUDE.md non-negotiables 5/6/7 are held in
> abeyance until the rebuild.

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
- `berth_occupancy`

(`train_run_event` was partitioned until it was dropped with RLM's bespoke run model — ADR 0002,
migration 0025. Partitioning the garner `trust_movement` mirror on `created` is a deferred
follow-up — see docs/IMPLEMENTATION_PLAN.md Milestone 15 step 4.)

Recommended initial partition key is normalized event month, with a safe default partition for malformed/unresolved timestamps. Partition creation must be automated ahead of time and tested across month boundaries.

Use:

- BRIN indexes on append-ordered event time and ingestion sequence
- B-tree indexes for `(td_area, berth)`, description, train ID and resolver lookups
- archive checksums to rehydrate/reprocess events
- daily aggregate tables or metrics for event/byte counts by feed and area

Do not add an area-retention filter. Storage control must use compression, partition maintenance, verified tiered archival and explicit retention policy—not silent loss of unmapped-area data.
