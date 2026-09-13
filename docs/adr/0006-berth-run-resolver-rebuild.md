# ADR 0006 — Rebuild the berth-run resolver on garner data, position-scoped, query-time only

## Status

Accepted and implemented 2026-09-13. Reinstates CLAUDE.md rules 5 and 7 (held in abeyance since
ADR 0002, 2026-09-01). Implements Milestone 34. Two spikes ADR 0004 D7 named as prerequisites
were run against the real operator infrastructure while drafting this ADR — see Context.

## Context

ADR 0002 removed RLM's original berth-run resolver wholesale (`berth_run_resolution` — a 23 GB
table, a `project-resolver` daemon, `--backfill`/version-bump machinery) after it became the
single largest source of production incidents. It left an interim popup
(`apps/api/src/routes/currentRun.ts`, `GET /api/v1/td/areas/{area}/berths/{berth}/current-run`)
that:

1. Reads the berth's current TD description (headcode).
2. Finds every `cif_schedules` row (garner-mirrored) whose `signalling_id` equals that headcode
   and runs today — **nationwide, with no positional scoping at all**.
3. Picks one via `selectEffectiveSchedule` (pure STP precedence: `C > O > N > P`); if that's
   ambiguous but exactly one candidate has a `trust_activation` today, that one wins instead.
4. Labels the result plainly as garner's data, not an RLM identification.

This is honest about _whose_ data it is, but not about _how weak_ the match is: headcode strings
are only locally unique (CLAUDE.md rule 5 exists precisely because a 4-char description doesn't
uniquely identify a run), and step 2 admits every same-headcode schedule in the country as a
candidate with no check that any of them are anywhere near this berth today. It also doesn't use
`trust_activation.cif_schedule_id` as primary evidence — only as an ambiguity tie-break — even
though it's the strongest signal available (rule 6 already treats it as authoritative when
present).

ADR 0004 D7 already designed the target shape and named two spikes to run before opening this
phase:

> whether garner already exposes a berth-level `trust_id`/schedule deduction RLM should consume
> rather than rebuild (its `td_states`/`livesig` link is not currently mirrored); SMART coverage
> and quality for berth → STANOX nationwide.

### Spike 1 — garner's `td_states` is not a shortcut

Queried the operator's live openrail-eps MariaDB directly (read-only `rlm_bridge` grant, the same
credential `ingest-garner` uses) rather than guessing from garner's source. `td_states` is a
47,310-row table, schema `(updated int, k char(8) primary key, v char(8))` — `k` is
`<td_area><berth>` (e.g. `PXb0009`), `v` is the current headcode or empty when vacant. It is
**garner's own live TD state cache, not a trust_id or schedule link** — the same raw information
RLM's `berth_current_state` already has. No table named `livesig` exists in garner's schema at
all (it's a web UI feature name, not a stored table). **There is no shortcut to consume here —
the correlation has to be built.**

### Spike 2 — SMART berth→STANOX coverage is real and usable

Queried RLM's own `smart_berth_step` mirror (already populated, ADR 0002). Nationwide: 33,052
rows across 194 TD areas. For `PX` (Preston, which Lancaster's Milestone 33 map sits inside)
specifically: 423 rows, **100% carrying a `stanox`** (`A`/`B`/`C`/`D` SMART event types — every
one). Sample:

```
td_area | from_berth | to_berth | stanox | platform | event_type
PX      | 0007       | 0012     | 30165  |          | D
PX      | 0019       | BJ04     | 30321  | 1        | B
```

One real wrinkle: a berth code is not always a single STANOX. `from_berth = '0491'` in `PX`
appears with 3 distinct STANOXes; several others have 2. This isn't a data-quality problem to
paper over — a TD berth number is only unique within its own TD area's SMART extract, and where a
berth genuinely sits between two named locations (or garner's SMART source itself records more
than one plausible STANOX for it) the honest answer is a small **set** of candidate STANOXes, not
a forced single pick. The design below treats it as a set throughout, which is also just what
rule 7 already asks for.

## Decision

### Scope: this ADR covers the headcode-present case only

The click-a-berth popup only ever fires when the berth has a non-empty description (the route
404s `BERTH_NOT_OCCUPIED` otherwise) — a headcode is always present when this logic runs. ADR
0004 D7's fourth `matchBasis` tier, `station_berth_timetable` (matching by calling-point time
alone, no headcode corroboration — for the _no-headcode-at-all_ scenario), stays out of scope
here and is Milestone 35's job, exactly as the implementation plan already sequences it.

### Candidate generation: scope by headcode **and** position, not headcode alone

For an occupied berth `(tdArea, berth, headcode, enteredAt)`:

1. **STANOX candidate set**: every distinct `stanox` from `smart_berth_step` where
   `td_area = tdArea` and the berth appears as either `from_berth` or `to_berth`. Usually one,
   sometimes a handful (see Spike 2) — never assumed to be exactly one.
2. **TIPLOC set**: those STANOXes joined through `location_reference` (`stanox → tiploc`) — also
   treated as a set, not assumed 1:1.
3. **Position-scoped schedule candidates**: `cif_schedules` rows with `signalling_id = headcode`,
   running today (existing STP date-range/bitmask check, unchanged), **and** a
   `cif_schedule_locations` row whose `tiploc_code` is in the TIPLOC set from step 2. This is the
   actual fix — a same-headcode schedule calling nowhere near this berth today is excluded before
   any STP/activation logic runs, rather than being an equal candidate alongside the real one.
4. **Fallback only when there is no SMART coverage at all for this berth** (empty STANOX set in
   step 1): repeat the headcode match with no positional scope — today's existing nationwide
   behavior, kept as the `headcode_only` tier, explicitly labeled as the _weakest_ evidence
   (matching ADR 0004 D7's ranking, where it sits below even `station_berth_timetable`). A
   position-scoped set that comes back **empty** is not a reason to fall back to the unscoped
   search — that's real information (this train's schedule doesn't call here today), and quietly
   re-admitting the nationwide search at that point would reintroduce the exact false-positive
   risk this rebuild exists to close.

### `matchBasis` verdict, evaluated over the step-3 (or step-4 fallback) candidate set

Highest to lowest confidence, per ADR 0004 D7's enum (`station_berth_timetable` excluded, out of
scope — see above):

1. **`trust_activation`** — exactly one candidate has a `trust_activation` row created since
   today's London midnight. More than one → ambiguous at this tier (do not fall through to STP
   as a tie-break among _activated_ candidates; two independently-activated schedules sharing a
   headcode and calling point is itself the ambiguity rule 7 exists to surface, not a case to
   paper over).
2. **`stp_precedence`** — else, `selectEffectiveSchedule` (existing pure function, unchanged)
   over the position-scoped candidates. `matched` → that tier; `ambiguous` → ambiguous at this
   tier; `none` (nothing in the scoped set runs today) → falls through to 3 only via the
   no-SMART-coverage path in step 4, never because the scoped search came back empty.
3. **`headcode_only`** — the step-4 fallback, same STP-precedence logic, unscoped.

### Verdict shape (CLAUDE.md rule 7)

```ts
type ResolverVerdict =
  | {
      status: "matched";
      basis: "trust_activation" | "stp_precedence" | "headcode_only";
      schedule: ScheduleCandidate;
    }
  | {
      status: "ambiguous";
      basis: "trust_activation" | "stp_precedence" | "headcode_only";
      candidates: ScheduleCandidate[];
    }
  | { status: "unmatched" };
```

Never hidden, never a silent single guess presented as fact — `matched` always carries which
`basis` produced it, so the popup can show confidence honestly (e.g. "confirmed by TRUST" vs.
"headcode match only, unscoped — verify").

### Stays query-time only — no persisted table, no daemon, no WS delta

The rebuilt resolver runs **inside `currentRun.ts`'s existing request handler**, the same shape
as today's interim popup — pure SQL joins plus the existing pure `selectEffectiveSchedule`
function, no new domain reducer holding state. It does **not** reintroduce:

- a `berth_run_resolution`-shaped table or any other persisted resolution row,
- a `project-resolver` daemon, backfill command, or `RESOLVER_VERSION` bump machinery,
- the `run.resolution.updated` WS message or a `runSummary` delta field.

This is deliberate, not an oversight: ADR 0002's entire rationale for removing the original
resolver was operational fragility from exactly that shape (a 23 GB table, reprocessing storms on
every version bump, projector lock contention with the live berth path) — see
`[[resolver_version_bump_incident]]` for the cautionary tale. A query-time lookup, computed only
when a visitor clicks an occupied berth, has none of that failure surface. If nationwide
berth-run history (not just live lookups) is ever wanted, that is new scope requiring its own ADR
— not assumed here.

### Correcting the plan text

`docs/IMPLEMENTATION_PLAN.md`'s Milestone 34 entry cites
`deduced_headcode`/`deduced_headcode_status` as fields to use alongside
`trust_activation.cif_schedule_id`. Checked against garner's real schema (`describe
trust_activation`): only `created`, `trust_id`, `cif_schedule_id`, `deduced` exist — no
`deduced_headcode`/`deduced_headcode_status` columns exist anywhere in garner's database. That
detail in the plan was aspirational/incorrect and is corrected here; `deduced` (a boolean —
"garner's own link was inferred rather than exact-matched") is the only activation-quality signal
actually available, and is already mirrored and already surfaced in today's popup response.

## Consequences

- `apps/api/src/routes/currentRun.ts` is rewritten to the four-step candidate generation and
  three-tier `matchBasis` above, replacing the current headcode-only-nationwide query. Response
  shape changes: `effective`/`candidateSchedules` gain an explicit `matchBasis`, and an ambiguous
  case now returns every tied candidate rather than only the ones the old STP/activation logic
  happened to consider.
- New pure domain function for the tiered decision (parallel to `selectEffectiveSchedule`,
  covered by unit tests independent of the DB), plus the position-scoping SQL added to the route.
- No schema/migration change — `smart_berth_step` and `location_reference` already have what's
  needed; no new tables.
- CLAUDE.md rules 5 and 7 are reinstated by this ADR. Rule 6 (TRUST activation as the
  authoritative run↔schedule link when available) already pointed at garner's
  `trust_activation.cif_schedule_id`; this ADR is what actually makes that the top-priority
  `matchBasis` tier in practice rather than a same-day tie-break.
- Milestone 35 builds directly on the STANOX/TIPLOC candidate-set plumbing introduced here, adding
  the `station_berth_timetable` tier this ADR deliberately left out — see the addendum below for
  what that tier actually turned out to be (materially different from this ADR's original guess).

## Addendum — Milestone 35: the `station_berth_timetable` tier

Implemented 2026-09-13, same day, after the owner corrected this ADR's original framing of the
deferred fourth tier ("station-berth deduction when there's no headcode at all"). The real
scenario is different: a signaller interposes a TD headcode whenever the train is **physically
present** in the berth — routinely hours before its scheduled departure (stabled overnight, or
simply early for its next working). A headcode is always present in this scenario; the gap is
between _when the berth was entered_ and _when the schedule says it should be there_, not a
missing headcode.

**Design** (confirmed with the owner before implementing, after two earlier proposals were
identified as wrong — see below):

- Triggers only when the berth is position-scoped (a known "station") **and** STP precedence
  alone still leaves more than one tied candidate (no single winner, no TRUST activation).
- Among that tied set, pick whichever candidate's scheduled calling time at the station is
  **closest to the current moment** (`now`, not `occupancy_entered_at`) — no "already passed"
  filter. Exactly one closest → matched, `basis: "station_berth_timetable"`. More than one
  exactly tied → ambiguous at that tier. None with a usable time → falls back to the plain
  `stp_precedence` ambiguous result (rule 7 — timing didn't help, so nothing is hidden).

**Two rejected designs, kept here because the reasoning matters for anyone touching this later:**

1. _A fixed ±5 minute window against `occupancy_entered_at`._ Wrong — would have excluded the
   textbook early-interpose case (train sitting 5 hours ahead of its 10:00 departure) outright,
   the single most common real scenario this tier exists for.
2. _Closest-to-now, but first dropping any candidate whose scheduled time has "already passed"._
   Wrong for a different reason: there's no real-time evidence at this tier (that's what
   `trust_activation`, ranked above it, is for) to say whether a nominally-past time means the
   working genuinely finished or the train is simply running late. A train scheduled for 10:00
   and still sitting there at 10:15 must not be excluded just because 10:00 is technically "in
   the past" — closest-to-now with no passed/future distinction handles both directions
   correctly (a heavily-delayed early trip losing out to a not-yet-due later repeat of the same
   headcode is a known, accepted residual edge case, and only actually wrong if it confidently
   picks the losing one — not a hidden ambiguity).

**Implementation**: `packages/domain/src/schedule/stationBerthTiming.ts` (pure —
`parseCifTimeToMinutes` for CIF `HHMM`/`HHMMH` strings, `circularDiffMinutes` wrapping at the
day boundary, `closestToNow` returning every exactly-tied candidate rather than guessing) plus
the new `timing` parameter on `resolveRunMatch`. `currentRun.ts` fetches each position-scoped
candidate's best (closest-to-now) calling time at the scoped TIPLOCs only when position-scoped —
an unscoped (`headcode_only`) search has no station to time-match against, so this tier never
applies there. No migration — reads the same `cif_schedule_locations` columns Milestone 34
already joins.

Known limitation carried over from Milestone 34's own note: the author-supplied `berth.crs`/
`stationId` schema hooks (ADR 0004 D6/D7) are still not consulted as an additional/overriding
station-identity source — only the SMART-derived STANOX set is used. A berth SMART doesn't cover
gets no `station_berth_timetable` tier at all, regardless of map-authored CRS metadata.
