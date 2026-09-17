import type { Pool } from "pg";
import {
  TD_PROJECTION_VERSION,
  candidatesRunningOnAny,
  circularDiffMinutes,
  isSameRunIdentity,
  parseCifTimeToMinutes,
  resolveRunMatch,
  type RunMatchCandidate,
} from "@railway/domain";
import type { Queryable } from "./checkpoint.js";

/**
 * Milestone 34/35 (docs/adr/0006) + Milestone 39 (docs/adr/0007): the garner-backed run-matching
 * logic shared by `apps/api/src/routes/currentRun.ts` (resolves reactively, on a popup click) and
 * `apps/worker/src/runLineage/projector.ts`'s proactive sweep (docs/adr/0007 addendum,
 * 2026-09-14 — resolves eagerly for TD areas covered by a published map, so a train doesn't need
 * to be clicked at exactly the right berth to ever get identified). Lives here, not in either app,
 * because `apps/worker` cannot import from `apps/api` (only `packages/*` are shared between the
 * two) — moved verbatim from `apps/api/src/lib/runLineage.ts` and the inlined block in
 * `currentRun.ts`'s route handler, so both callers use the exact same logic and can never drift
 * apart. `Queryable` (not `Pool`) throughout so callers already inside a transaction can pass their
 * `PoolClient` too.
 */

export interface CandidateScheduleRow {
  id: string;
  cif_train_uid: string;
  cif_stp_indicator: string;
  days_runs_bitmask: string | null;
  schedule_start_date: string;
  schedule_end_date: string;
  atoc_code: string | null;
  train_status: string | null;
  cif_train_service_code: string | null;
  cif_train_category: string | null;
  signalling_id: string | null;
  origin_tiploc: string | null;
  destination_tiploc: string | null;
}

export interface ActivationRow {
  cif_schedule_id: string;
  trust_id: string;
  deduced: number;
  created: Date;
}

/** Today's date in Europe/London (traffic day is close enough to the calendar day for this
 * resolver — it does not need WTT 02:00 boundary precision). */
export function londonToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** The calendar date immediately before `dateStr` (`YYYY-MM-DD`) — pure calendar-string
 * arithmetic, deliberately never touching a real zoned instant, so it can't be thrown off by a
 * DST transition the way `new Date(dateStr) - 24h` could be. Traffic-day-boundary fix (docs/adr/
 * 0008): the "yesterday" half of the two-date window `resolveFreshRunMatch` now probes, so an
 * overnight-running train's still-valid, yesterday-dated schedule doesn't disappear the instant
 * the calendar rolls over past London midnight. */
export function previousCalendarDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/** Milestone 35: the current wall-clock time in Europe/London, as minutes since midnight — the
 * `nowMinutes` the `station_berth_timetable` tier ranks candidates against. */
export function londonMinutesSinceMidnight(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** Milestone 34 (docs/adr/0006): every STANOX a berth's SMART data plausibly places it at — a
 * berth code is only unique within its own TD area's SMART extract, and can genuinely carry more
 * than one (spike: `PX` berth `0491` has 3) — treated as a set throughout, never forced to one. */
export async function berthStanoxes(
  pool: Queryable,
  tdArea: string,
  berth: string,
): Promise<string[]> {
  const result = await pool.query<{ stanox: string }>(
    `select distinct stanox from smart_berth_step
     where td_area = $1 and (from_berth = $2 or to_berth = $2) and stanox is not null`,
    [tdArea, berth],
  );
  return result.rows.map((row) => row.stanox);
}

export async function tiplocsForStanoxes(pool: Queryable, stanoxes: string[]): Promise<string[]> {
  if (stanoxes.length === 0) return [];
  const result = await pool.query<{ tiploc: string }>(
    `select distinct tiploc from location_reference where stanox = any($1::text[])`,
    [stanoxes],
  );
  return result.rows.map((row) => row.tiploc);
}

/** Milestone 34 (docs/adr/0006): candidate `cif_schedules` for a headcode running on any of
 * `serviceDates` — position-scoped to `tiplocs` (an `exists` against `cif_schedule_locations`)
 * when given a non-empty set, unscoped (whole-country headcode match, the `headcode_only`
 * fallback tier) when `tiplocs` is empty. Same query either way, differing only by that one
 * clause, to keep the two paths from drifting apart.
 *
 * Traffic-day-boundary fix (docs/adr/0008): `serviceDates` is a small window (today and
 * yesterday, from `resolveFreshRunMatch`) rather than a single date — the SQL filter only needs
 * to check the schedule's date *range* overlaps that window (`start <= max(serviceDates) and end
 * >= min(serviceDates)`); the precise per-date day-of-week bitmask check still happens afterward,
 * purely, in `resolveRunMatch` (`runsOnDate`/`candidatesRunningOnAny`) — this is deliberately a
 * superset, not a second copy of that logic. */
export async function queryCandidateSchedules(
  pool: Queryable,
  headcode: string,
  serviceDates: readonly string[],
  tiplocs: string[],
): Promise<CandidateScheduleRow[]> {
  const positionScoped = tiplocs.length > 0;
  const maxDate = serviceDates.reduce((a, b) => (a > b ? a : b));
  const minDate = serviceDates.reduce((a, b) => (a < b ? a : b));
  const result = await pool.query<CandidateScheduleRow>(
    `select s.id, s.cif_train_uid, s.cif_stp_indicator, s.days_runs_bitmask,
            s.schedule_start_date::text as schedule_start_date,
            s.schedule_end_date::text as schedule_end_date,
            s.atoc_code, s.train_status, s.cif_train_service_code, s.cif_train_category,
            s.signalling_id,
            (select l.tiploc_code from cif_schedule_locations l
              where l.cif_schedule_id = s.id order by l.seq_no asc limit 1) as origin_tiploc,
            (select l.tiploc_code from cif_schedule_locations l
              where l.cif_schedule_id = s.id order by l.seq_no desc limit 1) as destination_tiploc
     from cif_schedules s
     where s.signalling_id = $1 and s.deleted is null
       and s.schedule_start_date <= $2::date and s.schedule_end_date >= $3::date
       ${
         positionScoped
           ? `and exists (
                select 1 from cif_schedule_locations l
                where l.cif_schedule_id = s.id and l.tiploc_code = any($4::text[])
              )`
           : ""
       }`,
    positionScoped ? [headcode, maxDate, minDate, tiplocs] : [headcode, maxDate, minDate],
  );
  return result.rows;
}

/** Milestone 39 (docs/adr/0007): fetches one known schedule by id — same column shape as
 * `queryCandidateSchedules` — for the lineage-shortcut path, where the schedule is already known
 * from an inherited `berth_occupancy_run_link` rather than found by a headcode/position search. */
export async function fetchScheduleRowById(
  pool: Queryable,
  scheduleId: string,
): Promise<CandidateScheduleRow | null> {
  const result = await pool.query<CandidateScheduleRow>(
    `select s.id, s.cif_train_uid, s.cif_stp_indicator, s.days_runs_bitmask,
            s.schedule_start_date::text as schedule_start_date,
            s.schedule_end_date::text as schedule_end_date,
            s.atoc_code, s.train_status, s.cif_train_service_code, s.cif_train_category,
            s.signalling_id,
            (select l.tiploc_code from cif_schedule_locations l
              where l.cif_schedule_id = s.id order by l.seq_no asc limit 1) as origin_tiploc,
            (select l.tiploc_code from cif_schedule_locations l
              where l.cif_schedule_id = s.id order by l.seq_no desc limit 1) as destination_tiploc
     from cif_schedules s
     where s.id = $1 and s.deleted is null`,
    [scheduleId],
  );
  return result.rows[0] ?? null;
}

export interface TrustLocationChange {
  originalStanox: string;
  originalTiploc: string | null;
  stanox: string;
  tiploc: string | null;
  changedAt: string;
}

export interface TrustChangeSummary {
  /** The TRUST id actually current for this run right now — the activation's own id, unless a
   * Change of Identity has superseded it. Everything TRUST-id-keyed that reads "now" (movements,
   * the unit-allocation link is by train_uid so unaffected) must key off this, not the activation's
   * original id. */
  effectiveTrustId: string;
  /** Every TRUST id this run has been known by, oldest first — `[activationTrustId]` when no
   * Change of Identity has happened. Used to search the change tables across the whole run, since a
   * change can arrive either side of a later identity change. */
  trustIdChain: string[];
  previousTrustId: string | null;
  identityChangedAt: string | null;
  originStanox: string | null;
  originTiploc: string | null;
  originChangedAt: string | null;
  originChangeReason: string | null;
  destinationStanox: string | null;
  destinationTiploc: string | null;
  destinationChangedAt: string | null;
  destinationChangeReason: string | null;
  locationChanges: TrustLocationChange[];
}

const MAX_IDENTITY_CHAIN_HOPS = 8;

/**
 * docs/adr/0009: garner already mirrors TRUST's Change of Origin / Change of Identity / Change of
 * Location / (partial) Cancellation messages verbatim (migration 0025, `trust_changeorigin`/
 * `trust_changeid`/`trust_changelocation`/`trust_cancellation`) — this reduces them to "what's
 * actually true for this run right now," the same derived-projection discipline CLAUDE.md already
 * requires of current state and history (rule 3), just applied to a schedule's origin/destination/
 * calling points/identity instead of a berth's occupancy.
 *
 * Identity is resolved first, walking `trust_changeid` forward one hop at a time (bounded by
 * `MAX_IDENTITY_CHAIN_HOPS` — a same-id cycle in production data is the real hazard being guarded
 * against, not a genuinely long chain). Origin/destination/location changes are then read across
 * every id the run has ever been known by (`trustIdChain`), not just the latest, and each reduced
 * to its single latest event — a change can legitimately arrive either side of a later identity
 * change.
 *
 * A destination change is read from `trust_cancellation`, not a dedicated "change of destination"
 * message (TRUST has none) — owner-confirmed reading (2026-09-17): a part-cancellation's own
 * `loc_stanox` is the point the train now actually terminates at, so it *is* the run's new
 * effective destination, as long as the latest cancellation-family event for this run is a
 * cancellation and not a later reinstatement (`reinstate <> 0`) of it.
 */
export async function fetchTrustChanges(
  pool: Queryable,
  activationTrustId: string,
): Promise<TrustChangeSummary> {
  const chain: string[] = [activationTrustId];
  let identityChangedAt: string | null = null;
  let current = activationTrustId;
  for (let hop = 0; hop < MAX_IDENTITY_CHAIN_HOPS; hop++) {
    const result = await pool.query<{ created: Date; new_trust_id: string }>(
      `select created, new_trust_id from trust_changeid where trust_id = $1 order by created desc limit 1`,
      [current],
    );
    const row = result.rows[0];
    if (!row || chain.includes(row.new_trust_id)) break;
    identityChangedAt = row.created.toISOString();
    current = row.new_trust_id;
    chain.push(current);
  }
  const effectiveTrustId = current;
  const previousTrustId = effectiveTrustId === activationTrustId ? null : activationTrustId;

  const [originResult, cancellationResult, locationResult] = await Promise.all([
    pool.query<{ created: Date; reason: string | null; loc_stanox: string | null }>(
      `select created, reason, loc_stanox from trust_changeorigin
       where trust_id = any($1::text[]) order by created desc limit 1`,
      [chain],
    ),
    pool.query<{
      created: Date;
      reason: string | null;
      loc_stanox: string | null;
      reinstate: number;
    }>(
      `select created, reason, loc_stanox, reinstate from trust_cancellation
       where trust_id = any($1::text[]) order by created desc limit 1`,
      [chain],
    ),
    pool.query<{ created: Date; original_stanox: string; stanox: string }>(
      `select created, original_stanox, stanox from trust_changelocation
       where trust_id = any($1::text[]) order by created asc`,
      [chain],
    ),
  ]);

  const originRow = originResult.rows[0] ?? null;
  const cancellationRow = cancellationResult.rows[0] ?? null;
  // In effect only while not reinstated — the *latest* cancellation-family event for this run
  // decides that, mirroring how openrail's own livetrain.c already treats `reinstate` as "back to
  // Activated" for the same trust_id.
  const destinationInEffect =
    cancellationRow !== null &&
    Number(cancellationRow.reinstate) === 0 &&
    !!cancellationRow.loc_stanox;
  const destinationStanox = destinationInEffect ? (cancellationRow?.loc_stanox ?? null) : null;

  const stanoxesNeeded = new Set<string>();
  if (originRow?.loc_stanox) stanoxesNeeded.add(originRow.loc_stanox);
  if (destinationStanox) stanoxesNeeded.add(destinationStanox);
  for (const row of locationResult.rows) {
    stanoxesNeeded.add(row.original_stanox);
    stanoxesNeeded.add(row.stanox);
  }
  const tiplocByStanox = new Map<string, string>();
  if (stanoxesNeeded.size > 0) {
    const tiplocResult = await pool.query<{ stanox: string; tiploc: string }>(
      `select distinct on (stanox) stanox, tiploc from location_reference
       where stanox = any($1::text[]) order by stanox, tiploc`,
      [[...stanoxesNeeded]],
    );
    for (const row of tiplocResult.rows) tiplocByStanox.set(row.stanox, row.tiploc);
  }

  return {
    effectiveTrustId,
    trustIdChain: chain,
    previousTrustId,
    identityChangedAt,
    originStanox: originRow?.loc_stanox ?? null,
    originTiploc: originRow?.loc_stanox ? (tiplocByStanox.get(originRow.loc_stanox) ?? null) : null,
    originChangedAt: originRow ? originRow.created.toISOString() : null,
    originChangeReason: originRow?.reason ?? null,
    destinationStanox,
    destinationTiploc: destinationStanox ? (tiplocByStanox.get(destinationStanox) ?? null) : null,
    destinationChangedAt: destinationInEffect
      ? (cancellationRow?.created.toISOString() ?? null)
      : null,
    destinationChangeReason: destinationInEffect ? (cancellationRow?.reason ?? null) : null,
    locationChanges: locationResult.rows.map((row) => ({
      originalStanox: row.original_stanox,
      originalTiploc: tiplocByStanox.get(row.original_stanox) ?? null,
      stanox: row.stanox,
      tiploc: tiplocByStanox.get(row.stanox) ?? null,
      changedAt: row.created.toISOString(),
    })),
  };
}

/** Shared by both the full headcode/position search and the Milestone 39 lineage-shortcut path
 * (there given a single already-known schedule) — builds the `candidateSchedules` response shape
 * from whichever rows were actually considered. */
export function buildCandidateSchedules(
  rows: CandidateScheduleRow[],
  activationByScheduleId: Map<string, ActivationRow>,
  effectiveScheduleId: string | null,
) {
  return rows.map((row) => {
    const activation = activationByScheduleId.get(row.id);
    return {
      scheduleId: row.id,
      trainUid: row.cif_train_uid,
      stpIndicator: normalizeStp(row.cif_stp_indicator),
      source: "GARNER" as const,
      operatorCode: row.atoc_code,
      trainStatus: row.train_status,
      serviceCode: row.cif_train_service_code,
      category: row.cif_train_category,
      signallingId: row.signalling_id,
      scheduleStartDate: row.schedule_start_date,
      scheduleEndDate: row.schedule_end_date,
      daysRunsBitmask: row.days_runs_bitmask,
      originTiploc: row.origin_tiploc,
      destinationTiploc: row.destination_tiploc,
      activatedToday: activation !== undefined,
      trustId: activation?.trust_id ?? null,
      activationDeduced: activation ? activation.deduced !== 0 : false,
      isEffective: effectiveScheduleId === row.id,
    };
  });
}

const STP: ReadonlySet<string> = new Set(["C", "N", "O", "P"]);
export function normalizeStp(value: string): "C" | "N" | "O" | "P" {
  return STP.has(value) ? (value as "C" | "N" | "O" | "P") : "P";
}

/** Milestone 35: for each candidate schedule, its best (closest-to-now) parseable calling time
 * at any of the position-scoped `tiplocs` — a schedule can call at more than one of them (rare
 * but possible), and each calling row itself may carry more than one time field, so every
 * candidate is resolved down to a single "best" minutes-since-midnight value here rather than
 * leaving `resolveRunMatch` to pick among rows. Only called when position-scoped — with no real
 * station tied to this berth there's nothing to time-match against. */
export async function callingTimeMinutesByScheduleId(
  pool: Queryable,
  scheduleIds: string[],
  tiplocs: string[],
  nowMinutes: number,
): Promise<Map<string, number>> {
  if (scheduleIds.length === 0 || tiplocs.length === 0) return new Map();
  const result = await pool.query<{
    cif_schedule_id: string;
    arrival: string | null;
    departure: string | null;
    public_arrival: string | null;
    public_departure: string | null;
  }>(
    `select cif_schedule_id::text as cif_schedule_id, arrival, departure, public_arrival, public_departure
     from cif_schedule_locations
     where cif_schedule_id = any($1::bigint[]) and tiploc_code = any($2::text[])`,
    [scheduleIds, tiplocs],
  );

  const best = new Map<string, number>();
  for (const row of result.rows) {
    for (const raw of [row.public_departure, row.public_arrival, row.departure, row.arrival]) {
      const minutes = parseCifTimeToMinutes(raw);
      if (minutes === null) continue;
      const existing = best.get(row.cif_schedule_id);
      if (
        existing === undefined ||
        circularDiffMinutes(minutes, nowMinutes) < circularDiffMinutes(existing, nowMinutes)
      ) {
        best.set(row.cif_schedule_id, minutes);
      }
    }
  }
  return best;
}

/**
 * Movement-progress refinement (2026-09-15, real report: PX 0237, headcode `1M11` — a same-
 * headcode Caledonian Sleeper working, genuinely activated the evening before and within the
 * widened trust-activation window, but whose own TRUST movement history already showed it well
 * past this exact berth, terminated hours earlier). For each `(scheduleId, trustId)` pair —
 * schedules with *some* activation in the window, worth checking — returns the subset whose own
 * `trust_movement` history already reports a location at or beyond this berth's own calling
 * point in that schedule's sequence. Only ever positive evidence: a schedule with no movement
 * rows at all (hasn't started yet, or a data gap in the garner mirror) is never included here —
 * `resolveRunMatch` treats absence from this set as "not confirmed gone", never as proof either
 * way. Position-scoped only — with no real calling point tied to this berth there's nothing to
 * compare movement progress against.
 */
export async function findAlreadyPassedScheduleIds(
  pool: Queryable,
  candidates: ReadonlyArray<{ scheduleId: string; trustId: string }>,
  tiplocs: string[],
): Promise<Set<string>> {
  if (candidates.length === 0 || tiplocs.length === 0) return new Set();
  const result = await pool.query<{ schedule_id: string; passed: boolean }>(
    `with pairs as (
       select unnest($1::bigint[]) as schedule_id, unnest($2::text[]) as trust_id
     ),
     berth_seq as (
       select l.cif_schedule_id, min(l.seq_no) as berth_seq_no
       from cif_schedule_locations l
       where l.cif_schedule_id = any($1::bigint[]) and l.tiploc_code = any($3::text[])
       group by l.cif_schedule_id
     )
     select p.schedule_id::text as schedule_id,
            exists (
              select 1
              from trust_movement m
              join location_reference lr on lr.stanox = m.loc_stanox
              join cif_schedule_locations l
                on l.cif_schedule_id = p.schedule_id and l.tiploc_code = lr.tiploc
              where m.trust_id = p.trust_id
                and l.seq_no >= coalesce(
                  (select bs.berth_seq_no from berth_seq bs where bs.cif_schedule_id = p.schedule_id),
                  2147483647
                )
            ) as passed
     from pairs p`,
    [candidates.map((c) => c.scheduleId), candidates.map((c) => c.trustId), tiplocs],
  );
  return new Set(result.rows.filter((row) => row.passed).map((row) => row.schedule_id));
}

export interface FreshResolutionResult {
  matchStatus: "matched" | "ambiguous" | "unmatched";
  matchBasis:
    "trust_activation" | "stp_precedence" | "station_berth_timetable" | "headcode_only" | null;
  positionScoped: boolean;
  effectiveRow: CandidateScheduleRow | null;
  isSolidMatch: boolean;
  candidateSchedules: ReturnType<typeof buildCandidateSchedules>;
  /** The actual traffic day `effectiveRow` was matched against — `today` in the overwhelming
   * majority of cases, but `previousCalendarDate(today)` for an overnight train whose schedule
   * only the earlier date covers (docs/adr/0008). `null` iff `effectiveRow` is `null`. Callers
   * must use this, not a hardcoded `today`, for anything keyed by the match's traffic day: the
   * TRUST activation cutoff for `effectiveRow`'s full detail, `train_allocation` lookups, and the
   * `trafficDay` recorded on a `berth_occupancy_run_link`. */
  trafficDay: string | null;
}

/**
 * The garner headcode/position search (Milestone 34/35, docs/adr/0006): position-scope by SMART
 * STANOX(es) first, falling back to the unscoped nationwide headcode match only when this berth
 * has no SMART coverage at all — never because the scoped search itself came back with zero rows,
 * which is real information, not a reason to widen. Pure computation + reads only — does NOT
 * upsert a `train_run`/link; callers (the click path, the proactive sweep) do that themselves once
 * they decide the result is worth recording, since only they know the occupancy it applies to.
 */
export async function resolveFreshRunMatch(
  pool: Queryable,
  args: { tdArea: string; berth: string; headcode: string; today: string; nowMinutes: number },
): Promise<FreshResolutionResult> {
  const { tdArea, berth, headcode, today, nowMinutes } = args;
  // Traffic-day-boundary fix (docs/adr/0008): probe both today and yesterday (London), ordered
  // most-preferred first, throughout — never just `today` alone. See resolveRunMatch.ts's own
  // doc comment for why a single shared date was the actual root cause of the overnight-train
  // matching bug (2026-09-14 incident, PX 0052/5F05/W33229).
  const yesterday = previousCalendarDate(today);
  const serviceDates = [today, yesterday] as const;

  const stanoxes = await berthStanoxes(pool, tdArea, berth);
  const tiplocs = await tiplocsForStanoxes(pool, stanoxes);
  const positionScoped = tiplocs.length > 0;

  const candidateRows = await queryCandidateSchedules(pool, headcode, serviceDates, tiplocs);
  const scheduleIds = candidateRows.map((row) => row.id);

  // TRUST activations for any candidate schedule since the start of *yesterday* (London), not
  // today — the earlier of the two probed dates, so an overnight train activated before midnight
  // still shows as activated after it. The cutoff has to be the *instant* midnight-London occurs
  // — see currentRun.ts's own historical note on why `($2::date)::timestamp at time zone
  // 'Europe/London'` matters under BST.
  const activationRows = scheduleIds.length
    ? (
        await pool.query<ActivationRow>(
          `select cif_schedule_id::text as cif_schedule_id, trust_id, deduced, created
           from trust_activation
           where cif_schedule_id = any($1::bigint[])
             and created >= ($2::date)::timestamp at time zone 'Europe/London'
           order by created desc`,
          [scheduleIds, yesterday],
        )
      ).rows
    : [];
  // ADR 0008 addendum: widening the query above to `yesterday` means a row here isn't
  // necessarily *today's* activation — a daily-repeating schedule sharing this headcode gets its
  // own distinct activation for each real day it runs, and yesterday's is now inside this window
  // too. `activatedDatesByScheduleId` keeps every row's own London calendar date (`created`, not
  // the query's cutoff bound) so `resolveRunMatch` can check a candidate's resolved traffic day
  // against the specific date it was actually activated on — see that function's own doc comment
  // for the real incident (PX 0107, headcode 1Y61, G89843 vs G89845) this fixes.
  const activatedDatesByScheduleId = new Map<string, Set<string>>();
  // Separately, the single most-recent activation dated specifically *today* per schedule — for
  // `buildCandidateSchedules`'s display fields (`activatedToday`/`trustId`/`activationDeduced`),
  // which must stay honestly scoped to today even though the decision logic above now needs the
  // wider window.
  const todaysActivationByScheduleId = new Map<string, ActivationRow>();
  for (const row of activationRows) {
    const activationDate = londonToday(row.created);
    const dates = activatedDatesByScheduleId.get(row.cif_schedule_id);
    if (dates) dates.add(activationDate);
    else activatedDatesByScheduleId.set(row.cif_schedule_id, new Set([activationDate]));

    if (activationDate === today && !todaysActivationByScheduleId.has(row.cif_schedule_id)) {
      todaysActivationByScheduleId.set(row.cif_schedule_id, row);
    }
  }

  const matchCandidates: (RunMatchCandidate & { row: CandidateScheduleRow })[] = candidateRows.map(
    (row) => ({
      scheduleId: row.id,
      stpIndicator: normalizeStp(row.cif_stp_indicator),
      scheduleStartDate: row.schedule_start_date,
      scheduleEndDate: row.schedule_end_date,
      daysRunsBitmask: row.days_runs_bitmask,
      row,
    }),
  );
  // Milestone 35: only a position-scoped berth is a known "station" to time-match against — an
  // unscoped (headcode_only) search has no station to tie a calling time to.
  const callingTimes = positionScoped
    ? await callingTimeMinutesByScheduleId(pool, scheduleIds, tiplocs, nowMinutes)
    : new Map<string, number>();
  // Movement-progress refinement: only worth checking when position-scoped (nothing to compare
  // progress against otherwise) and more than one schedule has *some* activation in the window —
  // the only situation this filter could actually change anything. Picks each schedule's most
  // recent trust_id (`activationRows` is ordered `created desc` overall, so the first row seen
  // per schedule id is its most recent).
  let alreadyPassedScheduleIds: Set<string> | undefined;
  if (positionScoped && activatedDatesByScheduleId.size > 1) {
    const latestTrustIdByScheduleId = new Map<string, string>();
    for (const row of activationRows) {
      if (!latestTrustIdByScheduleId.has(row.cif_schedule_id)) {
        latestTrustIdByScheduleId.set(row.cif_schedule_id, row.trust_id);
      }
    }
    alreadyPassedScheduleIds = await findAlreadyPassedScheduleIds(
      pool,
      [...latestTrustIdByScheduleId].map(([scheduleId, trustId]) => ({ scheduleId, trustId })),
      tiplocs,
    );
  }
  const matchResult = resolveRunMatch(
    matchCandidates,
    activatedDatesByScheduleId,
    serviceDates,
    positionScoped
      ? { callingTimeMinutes: (c) => callingTimes.get(c.scheduleId) ?? null, nowMinutes }
      : undefined,
    alreadyPassedScheduleIds,
  );

  const matchBasis =
    matchResult.status === "unmatched"
      ? null
      : positionScoped
        ? matchResult.basis
        : "headcode_only";
  const effectiveRow = matchResult.status === "matched" ? matchResult.selected.row : null;
  const trafficDay = matchResult.status === "matched" ? matchResult.trafficDay : null;
  // Owner decision (2026-09-15, docs/adr/0008 addenda): `headcode_only` is weak because the
  // headcode *could* mean a different, unrelated train elsewhere on the network — but that's a
  // question of how many *distinct physical trains* (`cif_train_uid`) share it today, not how
  // many candidate schedule *rows* the SQL returned. A single train_uid routinely has both a
  // Permanent and an Overlay/New row simultaneously satisfying today's date+bitmask before STP
  // precedence even runs — counting rows would undercount "genuinely unique" as "two candidates"
  // and wrongly keep a perfectly safe match hidden. `runningNationwideTrainCount === 1` means the
  // collision risk is provably zero regardless of tie-break basis.
  //
  // Separately: `matchResult.basis === "trust_activation"` is solid even with *more* than one
  // running train_uid, because TRUST activation isn't inferred from the headcode text at all — a
  // `trust_activation` row is created by Network Rail's own systems already linked to one specific
  // `cif_schedule_id`, independent of anything this resolver matched on. The real risk this would
  // otherwise guard against (two genuinely different trains sharing this headcode *both* having a
  // live activation today) is already caught one tier up in `resolveRunMatch` itself — two
  // activated candidates report `ambiguous`, never a silent pick (CLAUDE.md rule 7) — so by the
  // time `basis === "trust_activation"` reaches here, it's already the *unique* activated
  // candidate among however many rows/train_uids shared the headcode. `stp_precedence` alone,
  // across *different* train_uids, carries no such guarantee — an Overlay outranking a Permanent
  // is meaningful only within one train's own schedule variants, not as a way to choose between
  // two unrelated trains — so that basis still needs the count check.
  const runningNationwideTrainCount = positionScoped
    ? null
    : new Set(
        candidatesRunningOnAny(matchCandidates, serviceDates).map(
          (dated) => dated.candidate.row.cif_train_uid,
        ),
      ).size;
  const isSolidMatch =
    matchResult.status === "matched" &&
    (positionScoped ||
      matchResult.basis === "trust_activation" ||
      runningNationwideTrainCount === 1);
  const candidateSchedules = buildCandidateSchedules(
    candidateRows,
    todaysActivationByScheduleId,
    effectiveRow?.id ?? null,
  );

  return {
    matchStatus: matchResult.status,
    matchBasis,
    positionScoped,
    effectiveRow,
    isSolidMatch,
    candidateSchedules,
    trafficDay,
  };
}

// ---------------------------------------------------------------------------------------------
// Milestone 39 (docs/adr/0007): sticky run-lineage — link bookkeeping. Moved verbatim from
// apps/api/src/lib/runLineage.ts so apps/worker can share it too.
// ---------------------------------------------------------------------------------------------

export interface OpenOccupancyRef {
  id: string;
  enteredAt: Date;
}

export interface OccupancyLink {
  trainRunId: string;
  cifScheduleId: string | null;
  cifTrainUid: string;
  trafficDay: string;
  matchBasis: "step_chain" | "boundary_correlated" | string;
  matchConfidence: "solid" | "weak";
}

export async function findOpenOccupancy(
  pool: Queryable,
  tdArea: string,
  berth: string,
): Promise<OpenOccupancyRef | null> {
  const result = await pool.query<{ id: string; entered_at: Date }>(
    `select id, entered_at from berth_occupancy
     where projection_version = $1 and td_area = $2 and berth_code = $3 and left_at is null
     order by entered_at desc limit 1`,
    [TD_PROJECTION_VERSION, tdArea, berth],
  );
  const row = result.rows[0];
  return row ? { id: row.id, enteredAt: row.entered_at } : null;
}

/** Only ever returns a link to a *current* (non-superseded) run — `upsertResolvedLink` always
 * repoints the link itself when superseding, so this filter is defence in depth, not the primary
 * mechanism. */
export async function findOccupancyLink(
  pool: Queryable,
  occupancy: OpenOccupancyRef,
): Promise<OccupancyLink | null> {
  const result = await pool.query<{
    train_run_id: string;
    cif_schedule_id: string | null;
    cif_train_uid: string;
    traffic_day: string;
    match_basis: string;
    match_confidence: "solid" | "weak";
  }>(
    `select l.train_run_id, r.cif_schedule_id::text as cif_schedule_id, r.cif_train_uid,
            r.traffic_day::text as traffic_day, r.match_basis, r.match_confidence
     from berth_occupancy_run_link l
     join train_run r on r.id = l.train_run_id
     where l.berth_occupancy_id = $1 and l.occupancy_entered_at = $2 and r.superseded_by is null`,
    [occupancy.id, occupancy.enteredAt],
  );
  const row = result.rows[0];
  return row
    ? {
        trainRunId: row.train_run_id,
        cifScheduleId: row.cif_schedule_id,
        cifTrainUid: row.cif_train_uid,
        trafficDay: row.traffic_day,
        matchBasis: row.match_basis,
        matchConfidence: row.match_confidence,
      }
    : null;
}

export interface ResolvedRunToLink {
  cifScheduleId: string;
  cifTrainUid: string;
  trafficDay: string;
  matchBasis: "trust_activation" | "stp_precedence" | "station_berth_timetable" | "headcode_only";
  /** Docs/adr/0008 second addendum (2026-09-15): the caller's own `resolveFreshRunMatch`-computed
   * `isSolidMatch`, passed through explicitly rather than re-derived here from `matchBasis` alone
   * (`confidenceForBasis` treats every `headcode_only` match as `weak`, unconditionally — it has
   * no way to know a specific match was actually the sole running train nationwide, or confirmed
   * by a genuine TRUST activation among several). Passing it through means a link's *stored*
   * confidence — and therefore what step-chain is willing to inherit/upgrade to (docs/adr/0007) —
   * benefits from the same reasoning as the public API response, not just the response itself. */
  matchConfidence: "solid" | "weak";
  tdArea: string;
  berth: string;
}

/** Establishes (or corrects) the `resolved` link for `occupancy`. A no-op if it already points at
 * the same physical run; supersedes the old `train_run` row and repoints the link if it points at
 * a genuinely different one — correction, not silent drift (docs/adr/0007). Always opens its own
 * connection/transaction (needs `Pool`, not just `Queryable`) — both the click path and the
 * proactive sweep call this independently of whatever transaction (if any) their own read side
 * used, since a resolution's write should commit or fail on its own. */
export async function upsertResolvedLink(
  pool: Pool,
  occupancy: OpenOccupancyRef,
  resolved: ResolvedRunToLink,
): Promise<void> {
  const existing = await findOccupancyLink(pool, occupancy);
  const sameIdentity =
    existing !== null &&
    existing.cifScheduleId !== null &&
    isSameRunIdentity(
      {
        cifScheduleId: existing.cifScheduleId,
        cifTrainUid: existing.cifTrainUid,
        trafficDay: existing.trafficDay,
      },
      {
        cifScheduleId: resolved.cifScheduleId,
        cifTrainUid: resolved.cifTrainUid,
        trafficDay: resolved.trafficDay,
      },
    );
  // docs/adr/0007 addendum (2026-09-15): the same schedule confirmed again at a *stronger*
  // confidence tier than what's already recorded (a step-chain-inherited weak/headcode_only link
  // reaching a well-covered berth, say) is a real correction worth writing — not a no-op — or the
  // record would stay permanently capped at whatever tier first identified it. A same-or-weaker
  // repeat (e.g. the click path's own 5s poll re-confirming the same solid match) still no-ops,
  // exactly as before, so this never churns the DB on every routine re-confirmation.
  const isUpgrade = existing?.matchConfidence === "weak" && resolved.matchConfidence === "solid";
  if (sameIdentity && !isUpgrade) {
    return; // Already correctly linked at an equal-or-better confidence — nothing to do.
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    if (existing) {
      // One round trip: insert the corrected run, then mark the old one superseded by it —
      // a data-modifying CTE, not a scalar subquery (Postgres doesn't allow INSERT there).
      const result = await client.query<{ new_run_id: string }>(
        `with new_run as (
           insert into train_run (
             cif_schedule_id, cif_train_uid, traffic_day, match_basis, match_confidence,
             established_td_area, established_berth
           ) values ($1, $2, $3::date, $4, $5, $6, $7)
           returning id
         )
         update train_run set superseded_by = new_run.id
         from new_run
         where train_run.id = $8
         returning new_run.id as new_run_id`,
        [
          resolved.cifScheduleId,
          resolved.cifTrainUid,
          resolved.trafficDay,
          resolved.matchBasis,
          resolved.matchConfidence,
          resolved.tdArea,
          resolved.berth,
          existing.trainRunId,
        ],
      );
      const newRunId = result.rows[0]!.new_run_id;
      await client.query(
        `update berth_occupancy_run_link
         set train_run_id = $1, link_basis = 'resolved', updated_at = now()
         where berth_occupancy_id = $2 and occupancy_entered_at = $3`,
        [newRunId, occupancy.id, occupancy.enteredAt],
      );
    } else {
      const runResult = await client.query<{ id: string }>(
        `insert into train_run (
           cif_schedule_id, cif_train_uid, traffic_day, match_basis, match_confidence,
           established_td_area, established_berth
         ) values ($1, $2, $3::date, $4, $5, $6, $7)
         returning id`,
        [
          resolved.cifScheduleId,
          resolved.cifTrainUid,
          resolved.trafficDay,
          resolved.matchBasis,
          resolved.matchConfidence,
          resolved.tdArea,
          resolved.berth,
        ],
      );
      await client.query(
        `insert into berth_occupancy_run_link (berth_occupancy_id, occupancy_entered_at, train_run_id, link_basis)
         values ($1, $2, $3, 'resolved')`,
        [occupancy.id, occupancy.enteredAt, runResult.rows[0]!.id],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Every TD area currently referenced by at least one *published* map's berth bindings — the
 * default scope for proactive resolution (`RUN_LINEAGE_FRESH_RESOLUTION_SCOPE=mapped`): if a map
 * binds one CL berth, every CL berth becomes eligible, not just the bound one, since the point is
 * identifying trains before they reach a specific mapped berth, not only once they're on it. */
export async function getMappedTdAreas(pool: Queryable): Promise<Set<string>> {
  const result = await pool.query<{ td_area: string }>(
    `select distinct mbi.td_area
     from map_binding_index mbi
     join map_version mv on mv.id = mbi.map_version_id
     where mbi.binding_type = 'td_berth' and mv.effective_to is null`,
  );
  return new Set(result.rows.map((row) => row.td_area));
}
