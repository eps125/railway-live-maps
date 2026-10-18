# ADR 0020: Backfilling TD recovered from a secondary capture

- **Status:** Accepted (2026-10-16), with **option B** (events plus windowed occupancy repair) chosen by the owner.
- **Context incident:** the failed CT 116 cutover attempt 1, 2026-10-16 ~00:55 BST
  (`docs/runbooks/ct116-native-zfs-cutover.md`).

## Context

During the failed cutover attempt, RLM lost TD from **2026-10-15 23:55:49Z to about 23:56:44Z**. The `feed_gap` row
covers TD 00:55:49–01:01:47 BST. openrail-eps, a separate NR consumer on the same host, kept recording until
**23:56:13Z** in its `tddb-detail.log`. Its lines for that window are archived at
`/var/lib/docker/volumes/openrail_logs/_data/archive/tddb-detail.gap-2026-10-15T2350Z-2026-10-16T0005Z.log`
in CT 116. The full log, verified byte-exact against the original, sits alongside it.

**Verified fidelity:**

- **Completeness:** for 23:55:00–23:55:39Z, where both systems have data, openrail's line counts equal RLM's
  `raw_feed_event` counts exactly per class: CA 247, CB 30, CC 89, CT 145, SF 785. openrail logs every TD message,
  one line each.
- **Field exactness:** every NR TD field is present in the line (area, msg type, descr, from, to, CT report
  time, SF address and data). NR's `time` is whole seconds (ms always `000`), and openrail's `Timestamp` equals
  it. The NR JSON can be rebuilt exactly, with no approximation.
- **Recoverable:** 768 messages in 23:55:49–23:56:13Z (159 CA, 13 CB, 59 CC, 78 CT, 459 SF).
- **Unrecoverable:** TD 23:56:13–23:56:44Z (31 s) and TRUST/VSTP 23:56:13–23:56:48Z (35 s). No system captured
  them. They are documented as lost, never synthesised.

**Constraints:**

- CLAUDE.md rules 1 and 18 and "do not silently repair source data": raw data is retained with lineage, and
  recovered data must be distinguishable from NR broker frames.
- Both TD projectors read `raw_feed_event` strictly in `ingestion_sequence` order. `berth_current_state` is
  guarded only by sequence, and the history fold works against currently-open occupancies. Rows inserted now
  with old event times would corrupt current state and history if the projectors consumed them normally.
- Schema changes must not block live ingest. `raw_feed_event` is about 200 GB and partitioned, so no validating
  scans or rewrites.

## Decision

1. **Lineage, with no pretending these are NR frames.**
   - The excerpt file itself is archived to MinIO as one immutable `raw_archive_object`, with a new
     `source_kind = 'recovered-log'`. The CHECK is replaced with `NOT VALID`, so there is no table scan or lock
     on live archive inserts.
   - There is one `feed_frame` for the recovery batch: `topic = 'recovery:openrail-eps:tddb-detail.log'`.
     `headers_json` holds the source system, archive file, file sha256, line range and this ADR.
     `body_hash` is the file's sha256, so the import is idempotent.
   - There is one `raw_feed_event` per recovered message. `raw_event_json` is the exact NR wrapper shape, and
     `received_at_utc` is openrail's own log-write time. A new nullable column `recovery_source` (catalog-only
     `ADD COLUMN`, no rewrite) holds the verbatim source line and its line number.
2. **Projectors never consume recovered rows.** Both projector reads add `and recovery_source is null`. Live
   current state is never touched by historical data.
3. **The import tool writes the per-event derived rows itself,** reusing the projector's normalisation
   functions:
   - `td_berth_event` (CA/CB/CC), `td_s_event` (SF) and `td_heartbeat` (CT)
   - `td_berth_daily_activity` increments
   - `td_s_bit_transition` for the window, folded from the last byte state before 23:55:49Z (the same approach
     as `backfill-s-class-bits`)
4. **Berth occupancy (owner choice, see below).**
5. `feed_gap` keeps its row. `operator_note` records what was recovered, from where and under which ADR, and the
   ranges that stay unrecoverable.

## Owner decision needed: berth occupancy history

The gap caused about **220 extra `from_berth_empty` anomalies** in 23:56–23:59Z (normally about 10 a minute).
Occupancy intervals for the berths involved are wrong for those few minutes.

- **Option A: events only.** Steps, S-class and heartbeats for the 24 s become visible in event history and
  playback steps. Occupancy intervals around the gap stay as they are, with the anomalies explained by the
  `feed_gap` note. Small, low-risk.
- **Option B: A plus a windowed occupancy repair.** For only the berths touched by gap events or by the
  post-gap anomalies, re-fold `berth_occupancy` from 23:55:49Z until each berth's next "settled" state,
  using the recovered events in event-time order. This needs a new, tested windowed re-fold, because the only
  existing rebuild is nationwide. More work and more risk, but the history is right. Even B cannot make
  23:56:13–23:56:44Z fully right, because those events are lost.

## Consequences

- **Rollout order:** first hand-apply migration 0052 on production (non-blocking). Next, deploy the projector
  filter and the import command through the normal pipeline. Then run the import as `--dry-run`, then
  `--execute`, all in one transaction. Re-running is a no-op because of the `body_hash` uniqueness.
- **Mixed sources:** `raw_feed_event` now holds rows from two sources. Anything that must mean "NR wire data"
  filters on `recovery_source is null`, the API/history can say "recovered from openrail-eps", and lineage is
  explicit.
- **Reusability:** the same mechanism could later import `nr-backstop` captures. Those are true NR frames, so
  they would go through the normal frame path with `source_kind = 'recovered-log'` instead.

## Addendum (2026-10-17): execution model after the dry-run incident

The first dry run held one write transaction open while it planned. A slow planning read
(berth_occupancy history) kept row locks the live projector needed, and live map updates froze for
about 3 hours (18:55–21:55 BST, 2026-10-16). No data was lost.

The tool is now two-phase:

- **Plan (read-only):** this phase runs in a `read only` transaction with a 300 s statement timeout. All
  reads are bounded:
  - pre-gap occupancy is one `LIMIT 1` index probe per berth
  - post-gap events are area- and time-filtered `materialized` CTEs
  - S-Class reads only the start addresses that can state the affected bytes
  - deletes and counts are bounded by the exact event time

  Every query is timed on stderr. A dry run is only this phase, so it writes nothing and holds no locks.

- **Apply:** only with `--execute`. One short write transaction with `lock_timeout` 3 s and
  `statement_timeout` 30 s, run from inside the production worker container, not over a tunnel.
- The projector filters (`recovery_source is null`, `not recovered`) must be deployed **before** an
  `--execute`.

## Outcome (2026-10-17)

`--execute` committed in 11.8 s from inside the production worker container. Live map state stayed 0–1 s
fresh throughout, with only brief single lock waits.

- Archive object 14843733 (`raw/td-recovered/2026/10/15/bc2c7217…`), feed frame 14843572.
- 768 `raw_feed_event` rows (23:55:49–23:56:13Z), each with its source line: 231 berth events
  (`recovered = true`), 78 heartbeats, 459 S-Class events.
- TD per 10 s is now continuous to 23:56:13Z. 23:56:20–23:56:40Z stays empty (lost, documented in `feed_gap`).
- `from_berth_empty` anomalies 23:56–23:59Z fell from 46/147/40/21 to 41/119/27/17 per minute. The remainder is
  caused by the 31 s that no system captured.
- No recovered occupancy is left open, and none overlaps another. The only strict overlaps on the repaired
  berths are WE `WUSY` rapid interposes, which the normal projector also produces in daytime. They are not
  related to the recovery.
