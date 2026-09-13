# ADR 0007 — Sticky run-lineage matching across berth steps and TD-area boundaries

## Status

Accepted and implemented 2026-09-14 (Milestone 39). Partially reverses ADR 0002's removal of
RLM's bespoke run-tracking model — see Context for how this differs from what was removed. See
the Consequences addendum for a production incident on first deploy and its fix.

## Context

ADR 0006 (Milestone 34/35) made `GET .../current-run` an honest, position-scoped, query-time-only
resolver: every click (and every 5s poll while the popup is open) re-derives the match from
scratch — current headcode, SMART-scoped candidate schedules, TRUST activation, STP precedence,
station-timing tie-break. Nothing persists between requests.

That surfaced a real gap the same day it shipped: headcode 1P03 (13/09/26) was **genuinely
ambiguous** at PX berth 0076 — two different real trains (UID `C00574`, and UID `G26746`) both had
a same-day TRUST activation under that headcode, and berth 0076 has zero SMART/STANOX coverage, so
there was no position data to break the tie. The same physical train resolved cleanly a few
minutes later at PX berth 0114 (SMART-covered, near Preston), once position-scoping excluded the
unrelated `G26746` candidate.

The owner's observation: once a berth occupancy is confidently matched, and TD itself tells us
(via a `CA` step event, `from_berth` → `to_berth`) that the same physical train moved to the next
berth, there is no reason to re-run headcode/position resolution there at all — the physical step
_is_ the identity link, and it is strictly stronger evidence than a headcode string. Re-resolving
from zero at every hop means a berth with no SMART coverage is a weak point in the chain even when
every berth around it was already solved.

**Real TD message semantics** (`packages/domain/src/td/berthReducer.ts`, verified against the
actual reducers rather than assumed): `CA` = **berth step** — closes `from` (`stepped_out`) and
opens `to` (`ca_step`), both berths known, the genuine physical-continuity event this ADR chains
on. `CB` = **berth cancel** — closes `from` only, no destination; a chain-breaking event (the
train left this TD area's visible scope, or a spurious clear). `CC` = **berth interpose** — opens
`to` only, no origin; the "cold start" case with nothing to inherit. `berth_occupancy.entry_reason`
already records `'ca_step'` vs `'cc_interpose'` per row, so the projector below can key off that
column directly rather than re-deriving message semantics from raw `td_berth_event` rows.

### Why this isn't ADR 0002's mistake repeated

ADR 0002 removed `train_run` / `train_run_event` / `run_schedule_link` — a 23 GB table set, a
`project-resolver` daemon, and backfill/version-bump machinery that duplicated schedule content
and became the single largest source of production incidents (see
`[[resolver_version_bump_incident]]`). This ADR reintroduces a **much thinner** concept:

- `train_run` here holds only an **identity pointer** (`cif_schedule_id`, `cif_train_uid`,
  `traffic_day`, provenance) — it never duplicates schedule/location content, which stays in
  garner-mirrored `cif_schedules`/`cif_schedule_locations` exactly as ADR 0002 established.
- No backfill/version-bump machinery. The projector is checkpointed and rebuildable from
  `td_berth_event` plus the existing garner mirror, same pattern as every other projector — not a
  bespoke reprocessing system.
- Scoped narrowly: it only ever answers "does this occupancy inherit an existing identity," never
  re-implements schedule matching itself (that stays exactly as ADR 0006 built it, used as the
  fallback whenever nothing to inherit exists).

## Decision

### Data model — three new tables (migration 0032)

**`train_run`** — one row per resolved physical run:

```
id                bigserial primary key
cif_schedule_id   bigint references cif_schedules(id)   -- nullable: see "cold start" below
cif_train_uid     text
traffic_day       date not null
match_basis       text not null   -- trust_activation | stp_precedence | station_berth_timetable
                                   -- | headcode_only | step_chain | boundary_correlated
match_confidence  text not null   -- solid | weak  (mirrors today's headcode_only distinction)
established_at    timestamptz not null
established_td_area text not null
established_berth   text not null
superseded_by     bigint references train_run(id)  -- set when corrected by fresher evidence
created_at        timestamptz not null default now()
```

**`berth_occupancy_run_link`** — one row per occupancy interval, pointing at its run:

```
berth_occupancy_id  bigint primary key references berth_occupancy(id)
train_run_id        bigint not null references train_run(id)
link_basis          text not null  -- resolved | step_chain | boundary_correlated
created_at          timestamptz not null default now()
```

**`td_area_boundary`** — owner-curated reference data, entered through a new editor admin screen
(see below), **not** auto-derived or auto-applied:

```
id            bigserial primary key
area_a        text not null
berth_a       text not null
area_b        text not null
berth_b       text not null
notes         text
created_by    text not null   -- app_user.username
created_at    timestamptz not null default now()
unique (area_a, berth_a, area_b, berth_b)
```

Undirected in meaning (a physical adjacency), looked up both ways by the projector.

### Propagation mechanism — `projector-run-lineage`

A new daemon (`apps/worker/src/runLineage/`, same `daemonLoop`/checkpoint pattern as
`projector-td-live`/`projector-td`), consuming `td_berth_event` `CA` rows in ingestion-sequence
order (its own checkpoint, independent of `project-td`'s):

1. **Clean intra-area step (`CA`)**: closes occupancy O1 at `from_berth` (`exit_reason =
'stepped_out'`), opens O2 at `to_berth` (`entry_reason = 'ca_step'`) — found via the same
   `raw_event_id`/`raw_event_normalized_at_utc` both effects share (no new index needed on
   `berth_occupancy`: `td_area`/`berth_code`/`entered_at`/`left_at` narrow the existing
   `(td_area, berth_code, entered_at desc)` index down to one berth's rows first). If O1 has a
   `berth_occupancy_run_link`, create the same link for O2 with `link_basis = 'step_chain'`.
   **Confidence is capped at O1's own tier — inheriting from a `headcode_only` match stays
   `headcode_only` downstream, never upgrades** (owner decision, 2026-09-14). A step during a
   recorded `feed_gap` for that TD area never propagates — treated as a broken chain, falls back
   to fresh resolution.
2. **Headcode change mid-step**: still propagates — the step event itself is the identity
   evidence, not the headcode. A reporting-number change crossing certain areas is legitimate and
   shouldn't break the chain.
3. **Berth cancel (`CB`) or fresh interpose (`CC`)**: no inheritance possible — `CB` has no
   destination to propagate to, `CC` has no origin to inherit from. Falls back to today's ADR
   0006/0035 resolver exactly as it runs now whenever that berth is next clicked — this is the
   "cold start" path, unchanged.
4. **Portion joins/splits**: never propagated (owner decision, 2026-09-14 — safest default).
   Any occupancy transition that isn't a clean `CA` step with an O1 to inherit from resets to
   fresh resolution. This can be revisited later with real incident data; not attempted now.
5. **Correction, not freezing**: if a fresher signal contradicts an inherited link (a new
   `trust_activation` row appears for a different schedule against this same occupancy, or an STP
   amendment changes what's effective), the newer evidence wins — the old `train_run` row is
   marked `superseded_by` the corrected one, and the occupancy's link is repointed. Sticky
   matching is a shortcut for "nothing new to reconsider," never a way to keep a wrong answer
   after better evidence arrives — CLAUDE.md rules 6/7 apply to inherited links exactly as they do
   to fresh ones.

### Cross-TD-area boundary correlation

No `CB` event crosses TD areas — each area is its own STOMP subscription. A train leaving area A
just closes its last occupancy there; area B gets a bare `CA` with no formal link back. Boundary
correlation therefore needs **owner-curated reference data plus corroboration**, never a guess:

1. **Reference data**: `td_area_boundary`, entered by the owner through a new editor-only admin
   screen (see below) — **not** auto-derived from SMART or auto-applied. If no entry exists for a
   given berth-pair, boundary correlation simply doesn't fire there and the occupancy falls back
   to fresh resolution, exactly as it does today. This is a confidence _boost_ when data exists,
   never a requirement.
2. **Corroboration, always required, never headcode alone**: when area A's occupancy closes at a
   berth with a `td_area_boundary` entry, and area B's paired berth gets a fresh interpose within
   a plausible window, corroborate using whichever of these is available:
   - The already-established run's own schedule calling-point times between the last TIPLOC seen
     in A and the first TIPLOC in B (only usable when A's occupancy was actually `matched` —
     which is exactly the case that matters, since an unmatched occupancy has nothing to hand
     forward anyway).
   - `trust_movement` continuity on the same `trust_id` — nationwide, not TD-area-scoped, so a
     movement report at a B-side STANOX under the same `trust_id` is strong independent
     confirmation.
   - Headcode continuity, as the weakest of the three, corroborating only.
3. **Never a silent single guess**: if more than one plausible candidate exists on the B side
   within the window (rare — e.g. two trains crossing near-simultaneously at the same boundary),
   this is `ambiguous`, exactly as any other tier is when tied. `link_basis = 'boundary_correlated'`
   is always its own tier, ranked below a direct `step_chain` or `trust_activation` link, honestly
   labelled as inferred rather than observed.

### Editor: TD boundary management screen

A new admin-only page (pattern: `apps/web/src/auth/AdminUsersPage.tsx`, not the Konva map canvas —
this is reference data entry, not visual map authoring, and exists independently of whether either
TD area has a published map at all, per CLAUDE.md rule 17). Lets the owner list, add, and delete
`td_area_boundary` rows (area A + berth A, area B + berth B, optional notes). New role-gated API
routes (`apps/api/src/routes/tdBoundaries.ts`), admin-only to write, matching the existing
`AdminUsersPage`/`app_user` role-gating pattern (`requireRole`).

### `currentRun.ts` integration

Two touch points, both additive to the existing ADR 0006/0035 resolver:

1. **Read, first**: before running the existing resolver, check whether the berth's _currently
   open_ `berth_occupancy` row already has a `berth_occupancy_run_link`. If so, resolve
   `effective` directly from its `train_run.cif_schedule_id` (same detail-building code already
   in `currentRun.ts`, just keyed by a known schedule id instead of a freshly-resolved one) and
   report `matchBasis` as `step_chain` or `boundary_correlated` accordingly, at the confidence
   tier that was actually inherited — never displayed as if it were a fresh `trust_activation`
   match when it wasn't. No link → fall through to exactly today's resolver, unchanged.
2. **Write, after**: whenever the existing resolver (fallen through to, or run because there was
   no link) reaches `matchStatus === "matched"`, upsert a `train_run` + `berth_occupancy_run_link`
   (`link_basis = 'resolved'`) for the current open occupancy — this is what _establishes_ a link
   for the projector to later chain forward from. If the occupancy already had a link pointing at
   the same `(cif_schedule_id, cif_train_uid, traffic_day)`, this is a no-op; if it points at a
   _different_ one, the old `train_run` is marked `superseded_by` the new one and the link is
   repointed — correction, not silent drift. Ambiguous/unmatched results never write a link (there
   is no single schedule to record).

Without step 2, step 1 would never have anything to find — a click is what plants the seed a
later physical step can carry forward.

## Consequences

- Three new tables (migration 0032): `train_run`, `berth_occupancy_run_link`, `td_area_boundary`.
- New daemon `projector-run-lineage`, wired into the worker's command dispatch and
  `deploy/docker-compose.portainer.yml` (same shape as `project-td-live`/`project-td`), with its
  own checkpoint watermark.
- New pure domain logic (fixture-tested, no DB): confidence-capping on inheritance, boundary
  corroboration eligibility scoring, clean-step detection (matching headcode, no feed-gap overlap).
- New admin-only editor screen + API routes for curating `td_area_boundary`.
- `currentRun.ts` gains a lineage-lookup step ahead of its existing resolver; `matchBasis` enum
  grows two tiers (`step_chain`, `boundary_correlated`); response/API contract updated accordingly.
- Resolves the "Later/unscheduled" backlog item "Map continuation/follow-train behaviour — removed
  with the original resolver, no replacement built" (`docs/IMPLEMENTATION_PLAN.md`).
- Explicitly does **not** attempt: portion join/split tracking (reset to fresh resolution instead,
  revisit later with real incident data); auto-derivation or auto-application of boundary data
  from SMART (owner-curated only, by design); upgrading inherited confidence above its source tier.
- CLAUDE.md rules 5, 6, 7 apply identically to inherited/correlated matches as to fresh ones —
  ambiguity at any tier (including a boundary crossing with more than one plausible candidate) is
  surfaced honestly, never resolved by guessing.

## Addendum — first-deploy production incident and fix (2026-09-14)

On first real deployment, `run-lineage-daemon` started from a fresh checkpoint (`ingestion_sequence
0`) and tried to catch up through `td_berth_event`'s **entire nationwide history** — many months,
tens of millions of rows. Two problems surfaced immediately, both against real production data
only (no realistic-scale test was possible beforehand):

1. **No index supported the catch-up query.** `where ingestion_sequence > $1 order by
ingestion_sequence` against `td_berth_event` had nothing to use but `(id, event_at)`,
   `(td_area, event_at desc)`, and `(raw_event_id, event_at)` — a full scan+sort of the whole
   partitioned table on every tick. Fixed by adding `td_berth_event_ingestion_sequence_idx`
   (migration 0033) — built on production via `CREATE INDEX CONCURRENTLY` per existing month
   partition then `ALTER INDEX ... ATTACH PARTITION`, never blocking a write, with
   `schema_migrations` backfilled by hand immediately after (the exact discipline
   `migrate_verify_schema_migrations_first` exists to enforce — the migration file itself holds a
   plain `create index`, correct and fast on any fresh/empty database, but never intended to run
   that way against production).
2. **Even once the cursor query was fast, the per-row occupancy lookups
   (`findOccupancyClosedAt`/`findOpenedByStep`) hit cold, never-cached pages on old month
   partitions** — one lookup against August's partition took 15.4 seconds; the identical query
   re-run immediately after took 6.5ms. Confirmed as a pure cold-cache cost, not a missing index or
   a design flaw. But it meant the very first backlog batch reliably blew the daemon's own 15s
   statement timeout, rolling back and retrying forever with no forward progress. The real fix was
   architectural, not another index: **sticky matching only has value for live, ongoing train
   movements** — a step from months ago tells today's ambiguous berth nothing. `run-lineage-daemon`
   now seeds a genuinely fresh checkpoint straight to the current tail of `td_berth_event`
   (`seedRunLineageCheckpointIfFresh`, same "only if never advanced" guard as `apps/worker/src/
garner/bridge.ts`'s `seedWatermarkIfFresh`) instead of replaying history — called once by the
   daemon wrapper before its first tick, deliberately kept out of `runProjectRunLineage` itself so
   the integration tests (which insert fixture rows and expect them processed) are unaffected.

Both fixes shipped same-day; the daemon was stopped between diagnosis and fix to avoid repeated
load on production while investigating, and live traffic (`ingest-td`, `berth_current_state`
writes) was confirmed unaffected throughout — the slow queries were read-only, never blocking.

**A third round, same day**: after redeploying with both fixes above, the checkpoint still never
advanced past its seeded value — every tick kept failing. The seed fix correctly skipped the
_historical backlog_, but `findOccupancyClosedAt`'s query had no predicate at all on `entered_at`
(`berth_occupancy`'s own partition key), so Postgres could not prune old month partitions from the
plan for _any_ call, including ones triggered by brand-new live events — it had to check every
partition, and a berth whose specific pages in an old partition had never been touched paid the
same cold-page cost the seed fix was supposed to eliminate. One cache-warm doesn't help a
_different_ berth's _different_ pages, so this wasn't a one-time cost — it recurred for every
distinct berth's first lookup. Fixed by adding `entered_at >= (closing time − 7 days)`: confirmed
via `EXPLAIN` that this lets the planner prune historical partitions out of the plan entirely
(not just filter them out after scanning), while still generously covering any realistic stabling
duration. `findOpenedByStep`'s equivalent query was never affected — its exact `entered_at = $3`
equality against the partition key already pruned correctly on its own.
