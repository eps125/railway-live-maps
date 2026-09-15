# ADR 0008 — Traffic-day boundary fix for the berth-run resolver

## Status

Accepted and implemented 2026-09-15 (post-Milestone 39 bugfix, no new milestone). Amends ADR 0006
and ADR 0007's resolver — no data model change, no new tables.

## Context

`GET .../current-run` (ADR 0006, Milestone 34/35) and the proactive sweep/step-chain upgrade paths
built on it (ADR 0007, Milestone 39) all compute a single `today` — `londonToday(new Date())`, the
Europe/London _calendar_ date — and use it everywhere: as the SQL date-range filter for candidate
`cif_schedules`, as the day-of-week bitmask check in `resolveRunMatch`'s pure logic, as the TRUST
activation cutoff, and as the `traffic_day` recorded on a `berth_occupancy_run_link`. `londonToday`'s
own doc comment already flagged the simplification ("does not need WTT 02:00 boundary precision")
without anyone noticing it could make a real, currently-running train literally unmatchable.

**Real incident, 2026-09-14**: PX berth 0052 showed headcode `5F05` (train UID `W33229`, Preston →
Edge Hill Depot, departed 23:28 the previous night) as `unmatched` — "no candidate schedule found"
— seconds after the London calendar rolled to the next day, even though the train was still
genuinely running (confirmed near Crewe via the reference site) and its schedule (dated only the
previous day) still existed in the garner mirror with every calling point synced. Confirmed by
direct SQL, not guessed: querying with the previous date found the schedule; querying with the date
the app actually computed did not.

Widening the SQL candidate query's date filter alone is not sufficient by itself.
`resolveRunMatch`'s pure logic (`candidatesRunningOn`/`runsOnDate`,
`packages/domain/src/schedule/resolveStpPrecedence.ts`) independently re-filters every candidate
against one shared `serviceDate` string — checking **both** the date range **and** the
day-of-week bitmask against that one date. A yesterday-dated candidate pulled in by a widened SQL
query would be filtered straight back out by this pure function unless it's made aware of which
day (today or yesterday) each candidate actually belongs to. The TRUST activation cutoff and the
traffic day recorded downstream (`train_allocation` lookups, `train_run.traffic_day`) have exactly
the same problem, one level up.

Owner-confirmed approach (2026-09-13/14 discussion): check both today's and yesterday's date, not
a full Working Timetable (WTT) 02:00-boundary rewrite — WTT-accurate traffic-day modelling (the
railway's own definition of a "day" runs roughly 02:00-to-02:00, not midnight-to-midnight) is a
materially bigger undertaking than this bug needs; a two-date probe window closes the real gap
(a schedule crossing exactly one midnight) without that scope.

## Decision

**Give each schedule candidate its own resolved traffic day, rather than testing every candidate
against one shared date.**

- `packages/domain/src/schedule/resolveStpPrecedence.ts` gains `candidatesRunningOnAny` and
  `selectEffectiveScheduleAcrossDates` — additive, alongside the existing single-date
  `candidatesRunningOn`/`selectEffectiveSchedule` (unchanged, still used by
  `apps/api/src/routes/schedule.ts`'s unrelated single-date effective-schedule lookup). Both new
  functions take `serviceDates: readonly string[]` (ordered most-preferred first — callers pass
  `[today, yesterday]`) and tag each running candidate with the _first_ date in that order it
  actually runs on.
- `resolveRunMatch` (`packages/domain/src/schedule/resolveRunMatch.ts`) takes `serviceDates`
  instead of a single `serviceDate`, and a `matched`/`ambiguous` result now carries the resolved
  `trafficDay` alongside the selected/tied candidate(s) — the caller must use this, not a
  hardcoded `today`, for anything keyed by the match's traffic day.
- `packages/database/src/runResolution.ts`:
  - New `previousCalendarDate(dateStr)` — pure calendar-string arithmetic (parses as UTC midnight,
    steps back a day, reformats), deliberately never touching a real zoned instant so it can't be
    thrown off by the BST/GMT transition.
  - `queryCandidateSchedules` takes `serviceDates` and widens its SQL filter to `schedule_start_date
<= max(serviceDates) and schedule_end_date >= min(serviceDates)` — a deliberate superset; the
    precise per-date day-of-week check still happens purely, afterward, in `resolveRunMatch`.
  - `resolveFreshRunMatch` computes `yesterday = previousCalendarDate(today)`, probes
    `[today, yesterday]` throughout, widens the TRUST activation cutoff to `created >= yesterday's
London midnight`, and returns the resolved `trafficDay` (`null` iff unmatched) alongside
    `effectiveRow`.
- `apps/api/src/routes/currentRun.ts` and `apps/worker/src/runLineage/projector.ts`
  (`sweepFreshResolution`, `attemptStepChainUpgrades`) all now use the resolver's own
  `trafficDay`/`effectiveTrafficDay` — never a hardcoded `today` — for: the TRUST activation
  full-detail query, the `train_allocation` unit-allocation lookup, and the `trafficDay` written to
  `berth_occupancy_run_link`/`train_run`. The Milestone 39 lineage-shortcut path
  (`currentRun.ts`'s `lineageSchedule` branch) already had the correct traffic day available —
  `occupancyLink.trafficDay`, from `train_run.traffic_day` — but was using hardcoded `today`
  instead; fixed alongside the fresh-resolution path since it's the same class of bug.

**Ordering (`[today, yesterday]`) matters**: a candidate satisfying both probed dates (the
overwhelming common case — a permanent, daily-running schedule) resolves to _today_, preserving
existing behaviour for every non-overnight match. Only a candidate that runs on yesterday but not
today (the overnight case this fixes) resolves to yesterday.

**Two independently-activated candidates across the two dates is `ambiguous`, not a silent pick**
(CLAUDE.md rule 7) — e.g. a still-running overnight schedule and a fresh, same-headcode service
starting today, if both happen to already have a same-day TRUST activation. This is a real,
correct ambiguity to surface, not a regression the widening introduced.

## Consequences

- Closes the real gap: an overnight train's schedule stays matchable across the London midnight
  boundary it was always going to cross, without a full WTT 02:00-boundary rewrite.
- `RunMatchResult`'s `matched`/`ambiguous` shape gained a `trafficDay` field on the matched variant
  — a type-level change to `@railway/domain`'s public API, but with only two real callers
  (`packages/database/src/runResolution.ts`, tests), both updated in the same change.
- Still not WTT-accurate (a schedule crossing _two_ midnights, or a real 02:00 traffic-day
  boundary rather than a calendar one, is out of scope) — deliberately, per the owner's own
  scoping call above. If a future incident needs that precision, it's a separate ADR, not an
  extension of this two-date probe.
- No migration: `train_run.traffic_day` already stored a `date` column (migration 0032); this
  changes which date gets written into it, not the column itself.

## Addendum (2026-09-15): TRUST activation must be checked per resolved date, not per schedule id

Found the same day this ADR shipped, investigating a real report: PX berth 0107, headcode `1Y61`,
reported `unmatched`/`ambiguous` by the owner despite an obviously correct, confidently-activated
candidate (`G89843`, confirmed against the reference site). Two schedules — `G89843` (calls PRST
~10:52) and `G89845` (calls PRST ~20:50) — share this headcode and both call at the same
position-scoped berth **every day** (`days_runs_bitmask` all-1s). Confirmed by direct SQL: `G89843`
had a genuine activation from that same morning (08:25); `G89845`'s most recent activation was from
**the evening before** (18:22 the prior day), for its own prior day's working — its today's-due
20:50 service hadn't been activated yet.

**Root cause**: widening the TRUST activation SQL query's cutoff to `yesterday`'s midnight (this
ADR's own fix, above — needed so an overnight train's pre-midnight activation still counts) was
paired with a flat `activatedScheduleIds: Set<scheduleId>` membership check in `resolveRunMatch` —
"was there _any_ activation row for this schedule id within the widened window," with no awareness
of which calendar day each row actually belonged to. For a daily-repeating schedule sharing a
headcode with another daily-repeating schedule at the same station, this reintroduced exactly the
kind of false collision the two-date probe was designed to avoid: `G89845`'s stale, entirely
unrelated prior-day activation started counting as "activated" for _today's_ tier check too,
alongside `G89843`'s real same-morning one — `activated.length === 2` → wrongly `ambiguous`.

**Fix**: `resolveRunMatch` now takes `activatedDatesByScheduleId: ReadonlyMap<string,
ReadonlySet<string>>` — schedule id → the specific calendar dates (the activation row's own
`created`, resolved to its London calendar date) it actually has an activation on — and checks each
`DatedCandidate` (`candidatesRunningOnAny`'s own scheduleId+resolvedServiceDate pairing) against
that specific date, not schedule-id membership alone. `packages/database/src/runResolution.ts`
builds this from the same already-widened activation query (no new SQL, no new round trip) by
grouping each row under `londonToday(row.created)` instead of collapsing to one row per schedule.
This fixes both cases correctly with the same structure: an overnight train's activation is dated
on the same day its resolved `serviceDate` correctly comes out to (yesterday), so it still counts;
a same-headcode sibling's stale prior-day activation no longer collides with a _different_
schedule's today occurrence. `buildCandidateSchedules`'s `activatedToday` display field (shown to
authenticated users in the candidate list) is similarly re-scoped to a `todaysActivationByScheduleId`
map containing only rows dated specifically `today` — it was inheriting the same "activated
anywhere in the widened window" imprecision for display purposes, which this also corrects.

No SQL/schema change — same widened query as the original fix, just grouped by the row's own date
instead of collapsed to "most recent regardless of date." Tests: `resolveRunMatch.test.ts` (+1 case
reproducing this exact PX 0107/1Y61 scenario), `currentRun.integration.test.ts` (+1 integration
case: two daily-running, position-scoped, same-headcode schedules, one activated today, one
activated only the day before — must resolve `matched`/`trust_activation` to today's, not
`ambiguous`).
