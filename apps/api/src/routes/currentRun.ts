import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import {
  TD_PROJECTION_VERSION,
  circularDiffMinutes,
  decodeTrustMovementFlags,
  parseCifTimeToMinutes,
  resolveRunMatch,
  signedVariationMinutes,
  type RunMatchCandidate,
} from "@railway/domain";
import { apiError } from "../lib/queryRange.js";
import { locationToJson, type CifLocationRowLike } from "./schedule.js";
import { SESSION_COOKIE_NAME, getSession } from "../auth/session.js";

export interface CurrentRunRoutesDeps {
  pool: Pool;
  redis: Redis;
  sessionTtlSeconds: number;
}

/**
 * `GET /api/v1/td/areas/{tdArea}/berths/{berth}/current-run` — the live map's click-a-berth
 * popup.
 *
 * Milestone 34 (docs/adr/0006): the rebuilt berth-run resolver. Candidate `cif_schedules` rows
 * (garner-mirrored, matching the berth's TD headcode and running today) are **position-scoped**
 * first — narrowed to only those calling at a TIPLOC this berth's SMART data (`smart_berth_step`)
 * says is plausible — before any STP/activation tie-break runs, closing the false-positive risk
 * of matching a same-headcode schedule running somewhere else in the country entirely (CLAUDE.md
 * rule 5). Only when this berth has no SMART coverage at all does it fall back to the unscoped
 * nationwide headcode match, explicitly labelled the weakest evidence tier (`headcode_only`).
 * `resolveRunMatch` (pure, `@railway/domain`) then picks among whichever candidate set was used:
 * a same-day TRUST activation wins if exactly one candidate has one (rule 6); else STP precedence
 * if that resolves to one; more than one tied candidate at either tier is `ambiguous`, never a
 * guess (rule 7) — `matchStatus`/`matchBasis`/`positionScoped` on the response say plainly which
 * tier produced the result, or that none did.
 *
 * Milestone 35 addendum (docs/adr/0006): when a berth is position-scoped (a known "station") and
 * STP precedence alone still leaves more than one tied candidate, break the tie by which
 * candidate's calling time at that station is closest to the current moment — deliberately not
 * by how close it is to when the berth was entered, since a signaller interposes a headcode
 * whenever the train is physically present, routinely hours before its scheduled departure (a
 * train stabled overnight, or simply early for its working). This also correctly keeps a
 * running-late candidate in play — its nominal time being "in the past" doesn't exclude it,
 * since there's no real-time evidence at this tier to say the working has actually finished.
 *
 * Owner request (2026-09-13), role-gated response: an anonymous visitor (no session cookie) gets
 * no popup content at all unless the berth is a **solid match** — `matchStatus === "matched"`
 * *and* position-scoped (i.e. not the weakest `headcode_only` tier, which is explicitly "verify
 * before trusting this" and shouldn't be shown as confident public fact). Even then they see a
 * reduced, departure-board-style view — headcode, origin/destination, calling points, operator —
 * never TRUST IDs, CIF schedule IDs, the `deduced` flag, or raw movement/variation detail, which
 * read as operational/diagnostic rather than public-facing. A logged-in session (any role — this
 * app only has `editor`/`admin`, no separate "viewer" tier) always gets the full response,
 * ambiguity detail included, exactly as Milestones 34/35 built it. This is enforced **server-side**
 * (the response itself is shaped differently, not just hidden in the UI) — an anonymous request
 * never receives the fields it isn't shown.
 *
 * Also owner request, shown to every visitor regardless of session: real unit/stock allocation
 * for the matched train, mirrored from garner's own `train_allocation` table (migration 0031) —
 * one row per unit in the formation, keyed by `cif_train_uid` + the traffic day.
 */
interface CurrentStateRow {
  description: string | null;
  occupancy_entered_at: Date | null;
}

interface CandidateScheduleRow {
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

interface ActivationRow {
  cif_schedule_id: string;
  trust_id: string;
  deduced: number;
  created: Date;
}

interface ActivationExtraRow {
  trust_id: string;
  train_uid: string | null;
  toc_id: string | null;
  schedule_wtt_id: string | null;
  schedule_type: string | null;
  origin_dep_timestamp: Date | null;
}

interface MovementRow {
  trust_id: string;
  loc_stanox: string | null;
  platform: string | null;
  actual_timestamp: Date | null;
  planned_timestamp: Date | null;
  gbtt_timestamp: Date | null;
  timetable_variation: number | null;
  flags: number | null;
  next_report_stanox: string | null;
}

interface UnitAllocationRow {
  unit_no: string;
  position: number;
  fleet_id: string;
  vehicles: string;
  reported: Date | null;
}

interface UnitAllocationEntry {
  unitNo: string;
  position: number;
  fleetId: string;
  vehicles: string[];
  reportedAt: string | null;
}

/** The full, authenticated-only shape of the resolved schedule's detail. `toPublicEffective`
 * below reduces this to the anonymous view. */
interface EffectiveScheduleFull {
  scheduleId: string;
  trainUid: string;
  stpIndicator: "C" | "N" | "O" | "P";
  source: "GARNER";
  operatorCode: string | null;
  trainStatus: string | null;
  serviceCode: string | null;
  category: string | null;
  originTiploc: string | null;
  originName: string | null;
  destinationTiploc: string | null;
  destinationName: string | null;
  activation: {
    trustId: string;
    deduced: boolean;
    activatedAt: string;
    trainUid: string | null;
    tocId: string | null;
    scheduleWttId: string | null;
    scheduleType: string | null;
    originDepartureAt: string | null;
  } | null;
  latestMovement: {
    trustId: string;
    locStanox: string | null;
    locName: string | null;
    platform: string | null;
    actualTimestamp: string | null;
    plannedTimestamp: string | null;
    gbttTimestamp: string | null;
    eventKind: string;
    variationStatus: string;
    variationMinutes: number | null;
    terminated: boolean;
    offRoute: boolean;
    manual: boolean;
    correction: boolean;
    nextReportStanox: string | null;
  } | null;
  locations: (ReturnType<typeof locationToJson> & { locationName: string | null })[];
}

/** Owner request (2026-09-13): the anonymous, "reduced" view of a matched schedule —
 * departure-board-style (headcode is returned separately at the top level; origin/destination/
 * calling points/operator here), never TRUST IDs, CIF schedule IDs, the `deduced` flag, or raw
 * movement/variation detail, which read as operational/diagnostic rather than public-facing. */
function toPublicEffective(effective: EffectiveScheduleFull): {
  originTiploc: string | null;
  originName: string | null;
  destinationTiploc: string | null;
  destinationName: string | null;
  operatorCode: string | null;
  locations: EffectiveScheduleFull["locations"];
} {
  return {
    originTiploc: effective.originTiploc,
    originName: effective.originName,
    destinationTiploc: effective.destinationTiploc,
    destinationName: effective.destinationName,
    operatorCode: effective.operatorCode,
    locations: effective.locations,
  };
}

const STP: ReadonlySet<string> = new Set(["C", "N", "O", "P"]);
function normalizeStp(value: string): "C" | "N" | "O" | "P" {
  return STP.has(value) ? (value as "C" | "N" | "O" | "P") : "P";
}

/** Today's date in Europe/London (traffic day is close enough to the calendar day for this
 * popup — a schedule popup does not need WTT 02:00 boundary precision). */
function londonToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Milestone 35: the current wall-clock time in Europe/London, as minutes since midnight — the
 * `nowMinutes` the `station_berth_timetable` tier ranks candidates against. */
function londonMinutesSinceMidnight(now: Date): number {
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
async function berthStanoxes(pool: Pool, tdArea: string, berth: string): Promise<string[]> {
  const result = await pool.query<{ stanox: string }>(
    `select distinct stanox from smart_berth_step
     where td_area = $1 and (from_berth = $2 or to_berth = $2) and stanox is not null`,
    [tdArea, berth],
  );
  return result.rows.map((row) => row.stanox);
}

async function tiplocsForStanoxes(pool: Pool, stanoxes: string[]): Promise<string[]> {
  if (stanoxes.length === 0) return [];
  const result = await pool.query<{ tiploc: string }>(
    `select distinct tiploc from location_reference where stanox = any($1::text[])`,
    [stanoxes],
  );
  return result.rows.map((row) => row.tiploc);
}

/** Milestone 34 (docs/adr/0006): candidate `cif_schedules` for a headcode running today —
 * position-scoped to `tiplocs` (an `exists` against `cif_schedule_locations`) when given a
 * non-empty set, unscoped (today's whole-country headcode match, the `headcode_only` fallback
 * tier) when `tiplocs` is empty. Same query either way, differing only by that one clause, to
 * keep the two paths from drifting apart. */
async function queryCandidateSchedules(
  pool: Pool,
  headcode: string,
  today: string,
  tiplocs: string[],
): Promise<CandidateScheduleRow[]> {
  const positionScoped = tiplocs.length > 0;
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
       and $2::date between s.schedule_start_date and s.schedule_end_date
       ${
         positionScoped
           ? `and exists (
                select 1 from cif_schedule_locations l
                where l.cif_schedule_id = s.id and l.tiploc_code = any($3::text[])
              )`
           : ""
       }`,
    positionScoped ? [headcode, today, tiplocs] : [headcode, today],
  );
  return result.rows;
}

/** Milestone 35: for each candidate schedule, its best (closest-to-now) parseable calling time
 * at any of the position-scoped `tiplocs` — a schedule can call at more than one of them (rare
 * but possible), and each calling row itself may carry more than one time field, so every
 * candidate is resolved down to a single "best" minutes-since-midnight value here rather than
 * leaving `resolveRunMatch` to pick among rows. Only called when position-scoped — with no real
 * station tied to this berth there's nothing to time-match against. */
async function callingTimeMinutesByScheduleId(
  pool: Pool,
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

/** Owner request (2026-09-13): real unit/stock allocation for the matched train, mirrored from
 * garner's `train_allocation` (migration 0031) — one row per unit, ordered by formation
 * position. Shown to every visitor regardless of login. Only called for the resolved `effective`
 * schedule (a single, known `cif_train_uid` + traffic day) — ambiguous/unmatched cases have no
 * single train_uid to key by. */
async function queryUnitAllocation(
  pool: Pool,
  cifTrainUid: string,
  serviceDate: string,
): Promise<UnitAllocationEntry[]> {
  const result = await pool.query<UnitAllocationRow>(
    `select unit_no, "position", fleet_id, vehicles, reported
     from train_allocation
     where cif_train_uid = $1 and schedule_start_date = $2::date
     order by "position" asc, unit_no asc`,
    [cifTrainUid, serviceDate],
  );
  return result.rows.map((row) => ({
    unitNo: row.unit_no,
    position: row.position,
    fleetId: row.fleet_id,
    vehicles: row.vehicles.split(/\s+/).filter(Boolean),
    reportedAt: row.reported ? row.reported.toISOString() : null,
  }));
}

export async function registerCurrentRunRoutes(
  app: FastifyInstance,
  deps: CurrentRunRoutesDeps,
): Promise<void> {
  const { pool, redis, sessionTtlSeconds } = deps;

  app.get<{ Params: { tdArea: string; berth: string } }>(
    "/api/v1/td/areas/:tdArea/berths/:berth/current-run",
    async (request, reply) => {
      const { tdArea, berth } = request.params;

      // Owner request (2026-09-13): optional auth — never required to view the map or this
      // popup at all, only to see full detail. A missing/invalid cookie is just "anonymous",
      // never a 401 (this route stays public, matching every other live-map read).
      const isAuthenticated =
        (await getSession(redis, request.cookies[SESSION_COOKIE_NAME], sessionTtlSeconds)) !== null;

      const stateResult = await pool.query<CurrentStateRow>(
        `select description, occupancy_entered_at
         from berth_current_state
         where projection_version = $1 and td_area = $2 and berth_code = $3`,
        [TD_PROJECTION_VERSION, tdArea, berth],
      );
      const state = stateResult.rows[0];
      // `description is not null` is the occupied signal — `occupancy_id` is NULL for berths the
      // fast `project-td-live` projector has touched (ADR 0003) and was vestigial anyway.
      if (!state || !state.description) {
        reply.code(404);
        return apiError("BERTH_NOT_OCCUPIED", `${tdArea} ${berth} has no current occupancy`);
      }

      const headcode = state.description;
      const today = londonToday(new Date());

      // Milestone 34 (docs/adr/0006): position-scope by this berth's SMART-derived STANOX(es)
      // first; only when there's no SMART coverage at all for this berth (empty tiploc set) do
      // we fall back to the unscoped nationwide headcode match — never because the scoped search
      // itself came back with zero rows, which is real information, not a reason to widen.
      const stanoxes = await berthStanoxes(pool, tdArea, berth);
      const tiplocs = await tiplocsForStanoxes(pool, stanoxes);
      const positionScoped = tiplocs.length > 0;

      const candidateRows = await queryCandidateSchedules(pool, headcode, today, tiplocs);
      const scheduleIds = candidateRows.map((row) => row.id);

      // TRUST activations for any candidate schedule since the start of today (London). The
      // cutoff has to be the *instant* midnight-London occurs — `($2::date)::timestamp at time
      // zone 'Europe/London'` — not `today` reinterpreted in the DB session's zone: under BST,
      // between 23:00 and 00:00 UTC `today` is already tomorrow's date and `($2::date)::timestamptz`
      // in a UTC session lands an hour in the future, wrongly excluding a just-created activation.
      const activationRows = scheduleIds.length
        ? (
            await pool.query<ActivationRow>(
              `select cif_schedule_id::text as cif_schedule_id, trust_id, deduced, created
               from trust_activation
               where cif_schedule_id = any($1::bigint[])
                 and created >= ($2::date)::timestamp at time zone 'Europe/London'
               order by created desc`,
              [scheduleIds, today],
            )
          ).rows
        : [];
      const activationByScheduleId = new Map<string, ActivationRow>();
      for (const row of activationRows) {
        if (!activationByScheduleId.has(row.cif_schedule_id)) {
          activationByScheduleId.set(row.cif_schedule_id, row);
        }
      }

      const matchCandidates: (RunMatchCandidate & { row: CandidateScheduleRow })[] =
        candidateRows.map((row) => ({
          scheduleId: row.id,
          stpIndicator: normalizeStp(row.cif_stp_indicator),
          scheduleStartDate: row.schedule_start_date,
          scheduleEndDate: row.schedule_end_date,
          daysRunsBitmask: row.days_runs_bitmask,
          row,
        }));
      const activatedScheduleIds = new Set(activationByScheduleId.keys());

      // Milestone 35: only a position-scoped berth is a known "station" to time-match against —
      // an unscoped (headcode_only) search has no station to tie a calling time to.
      const nowMinutes = londonMinutesSinceMidnight(new Date());
      const callingTimes = positionScoped
        ? await callingTimeMinutesByScheduleId(pool, scheduleIds, tiplocs, nowMinutes)
        : new Map<string, number>();
      const matchResult = resolveRunMatch(
        matchCandidates,
        activatedScheduleIds,
        today,
        positionScoped
          ? { callingTimeMinutes: (c) => callingTimes.get(c.scheduleId) ?? null, nowMinutes }
          : undefined,
      );

      // The internal basis (trust_activation/stp_precedence/station_berth_timetable) is only
      // meaningful when the candidate set was position-scoped — an unscoped fallback match is
      // always the weakest, `headcode_only` tier regardless of which internal method picked the
      // winner within it (docs/adr/0006: position-scoping, not the tie-break method, is what
      // this ranking is about).
      const matchBasis:
        "trust_activation" | "stp_precedence" | "station_berth_timetable" | "headcode_only" | null =
        matchResult.status === "unmatched"
          ? null
          : positionScoped
            ? matchResult.basis
            : "headcode_only";
      const effectiveRow = matchResult.status === "matched" ? matchResult.selected.row : null;

      const candidateSchedules = candidateRows.map((row) => {
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
          isEffective: effectiveRow?.id === row.id,
        };
      });

      let effective: EffectiveScheduleFull | null = null;
      if (effectiveRow) {
        const activation = activationByScheduleId.get(effectiveRow.id) ?? null;

        const locations = (
          await pool.query<CifLocationRowLike>(
            `select seq_no, record_identity, location_type, tiploc_code, arrival, departure, "pass",
                    public_arrival, public_departure, platform, path, line, next_day
             from cif_schedule_locations where cif_schedule_id = $1 order by seq_no`,
            [effectiveRow.id],
          )
        ).rows;

        let activationExtra: ActivationExtraRow | undefined;
        let latestMovement: MovementRow | undefined;
        if (activation) {
          activationExtra = (
            await pool.query<ActivationExtraRow>(
              `select trust_id, train_uid, toc_id, schedule_wtt_id, schedule_type, origin_dep_timestamp
               from trust_activation_extra where trust_id = $1 order by created desc limit 1`,
              [activation.trust_id],
            )
          ).rows[0];
          latestMovement = (
            await pool.query<MovementRow>(
              `select trust_id, loc_stanox, platform, actual_timestamp, planned_timestamp,
                      gbtt_timestamp, timetable_variation, flags, next_report_stanox
               from trust_movement
               where trust_id = $1
               order by actual_timestamp desc nulls last, created desc
               limit 1`,
              [activation.trust_id],
            )
          ).rows[0];
        }

        // TIPLOC / STANOX -> human-readable names (CORPUS mirror, location_reference).
        const tiplocsNeeded = new Set<string>(locations.map((l) => l.tiploc_code));
        if (effectiveRow.origin_tiploc) tiplocsNeeded.add(effectiveRow.origin_tiploc);
        if (effectiveRow.destination_tiploc) tiplocsNeeded.add(effectiveRow.destination_tiploc);
        const nameByTiploc = new Map<string, string>();
        if (tiplocsNeeded.size > 0) {
          const nameResult = await pool.query<{ tiploc: string; name: string | null }>(
            `select tiploc, name from location_reference where tiploc = any($1::text[])`,
            [[...tiplocsNeeded]],
          );
          for (const row of nameResult.rows) if (row.name) nameByTiploc.set(row.tiploc, row.name);
        }
        let movementLocationName: string | null = null;
        if (latestMovement?.loc_stanox) {
          const byStanox = await pool.query<{ name: string | null }>(
            `select name from location_reference where stanox = $1 limit 1`,
            [latestMovement.loc_stanox],
          );
          movementLocationName = byStanox.rows[0]?.name ?? null;
        }

        const flags = latestMovement ? decodeTrustMovementFlags(latestMovement.flags) : null;

        effective = {
          scheduleId: effectiveRow.id,
          trainUid: effectiveRow.cif_train_uid,
          stpIndicator: normalizeStp(effectiveRow.cif_stp_indicator),
          source: "GARNER" as const,
          operatorCode: effectiveRow.atoc_code,
          trainStatus: effectiveRow.train_status,
          serviceCode: effectiveRow.cif_train_service_code,
          category: effectiveRow.cif_train_category,
          originTiploc: effectiveRow.origin_tiploc,
          originName: effectiveRow.origin_tiploc
            ? (nameByTiploc.get(effectiveRow.origin_tiploc) ?? null)
            : null,
          destinationTiploc: effectiveRow.destination_tiploc,
          destinationName: effectiveRow.destination_tiploc
            ? (nameByTiploc.get(effectiveRow.destination_tiploc) ?? null)
            : null,
          activation: activation
            ? {
                trustId: activation.trust_id,
                deduced: activation.deduced !== 0,
                activatedAt: activation.created.toISOString(),
                trainUid: activationExtra?.train_uid ?? null,
                tocId: activationExtra?.toc_id ?? null,
                scheduleWttId: activationExtra?.schedule_wtt_id ?? null,
                scheduleType: activationExtra?.schedule_type ?? null,
                originDepartureAt: activationExtra?.origin_dep_timestamp
                  ? activationExtra.origin_dep_timestamp.toISOString()
                  : null,
              }
            : null,
          latestMovement:
            latestMovement && flags
              ? {
                  trustId: latestMovement.trust_id,
                  locStanox: latestMovement.loc_stanox,
                  locName: movementLocationName,
                  platform: latestMovement.platform,
                  actualTimestamp: latestMovement.actual_timestamp
                    ? latestMovement.actual_timestamp.toISOString()
                    : null,
                  plannedTimestamp: latestMovement.planned_timestamp
                    ? latestMovement.planned_timestamp.toISOString()
                    : null,
                  gbttTimestamp: latestMovement.gbtt_timestamp
                    ? latestMovement.gbtt_timestamp.toISOString()
                    : null,
                  eventKind: flags.eventKind,
                  variationStatus: flags.variation,
                  variationMinutes: signedVariationMinutes(
                    latestMovement.timetable_variation,
                    flags.variation,
                  ),
                  terminated: flags.terminated,
                  offRoute: flags.offRoute,
                  manual: flags.manual,
                  correction: flags.correction,
                  nextReportStanox: latestMovement.next_report_stanox,
                }
              : null,
          locations: locations.map((row) => ({
            ...locationToJson(row),
            locationName: nameByTiploc.get(row.tiploc_code) ?? null,
          })),
        };
      }

      // Always an array (docs/API_CONTRACT.md: "empty when garner has nothing allocated") — an
      // ambiguous/unmatched berth has no single train to key an allocation by, which is exactly
      // "nothing allocated", not the absence of the field. `null` here previously crashed the web
      // popup's unconditional `unitAllocation.length` (no effective schedule -> blank page,
      // reported 2026-09-14 against PX 0127/0133, both `unmatched` today).
      const unitAllocation = effectiveRow
        ? await queryUnitAllocation(pool, effectiveRow.cif_train_uid, today)
        : [];

      // Owner request (2026-09-13): a "solid" match — matched, and not the weakest unscoped
      // headcode_only tier (that one's own note already says "verify before trusting this", so
      // it shouldn't be shown to anonymous visitors as if it were confident public fact).
      const isSolidMatch = matchResult.status === "matched" && matchBasis !== "headcode_only";

      if (!isAuthenticated && !isSolidMatch) {
        reply.code(404);
        return apiError(
          "NO_PUBLIC_DETAIL",
          "No confirmed match to show without logging in — this berth's identification is either ambiguous, unmatched, or too weak to show publicly",
        );
      }

      const occupancyEnteredAt = state.occupancy_entered_at
        ? state.occupancy_entered_at.toISOString()
        : null;

      if (!isAuthenticated) {
        // Reduced, departure-board-style view — see toPublicEffective's own doc comment for
        // exactly what's withheld and why. Owner request (2026-09-14): no `note` either — its
        // "matched by TRUST activation / STP precedence / verify this" language is resolver
        // internals, meaningless (and a little alarming) to a visitor with no matchBasis to
        // interpret it against; that explanation stays for the logged-in, full response only.
        return {
          tdArea,
          berth,
          headcode,
          occupancyEnteredAt,
          matchStatus: "matched" as const,
          effective: effective ? toPublicEffective(effective) : null,
          unitAllocation,
        };
      }

      return {
        tdArea,
        berth,
        description: headcode,
        headcode,
        occupancyEnteredAt,
        matchStatus: matchResult.status,
        matchBasis,
        positionScoped,
        note: matchNote(matchResult.status, matchBasis, positionScoped),
        effective,
        candidateSchedules,
        unitAllocation,
      };
    },
  );
}

/** Milestone 34/35 (docs/adr/0006 + addendum): plain-language summary of how (or whether) this
 * popup's schedule was picked, shown verbatim in the UI — always honest about confidence, never
 * implying a confirmed RLM identification (garner's data, mirrored). */
function matchNote(
  status: "matched" | "ambiguous" | "unmatched",
  basis: "trust_activation" | "stp_precedence" | "station_berth_timetable" | "headcode_only" | null,
  positionScoped: boolean,
): string {
  const scopeNote = positionScoped
    ? "scoped to schedules calling near this berth (SMART data)"
    : "no SMART position data for this berth — matched by headcode alone, unscoped nationwide";

  if (status === "matched" && basis === "trust_activation") {
    return `Matched by garner's TRUST activation for a schedule ${scopeNote} — not a confirmed RLM identification.`;
  }
  if (status === "matched" && basis === "stp_precedence") {
    return `Matched by STP precedence among schedules ${scopeNote}; no TRUST activation seen today — not a confirmed RLM identification.`;
  }
  if (status === "matched" && basis === "station_berth_timetable") {
    return `Matched by which candidate's timetabled call here is closest to now (no TRUST activation, STP alone left more than one) — not a confirmed RLM identification.`;
  }
  if (status === "matched") {
    return `Matched by headcode alone (no SMART position data for this berth) — the weakest evidence tier; verify before trusting this. Not a confirmed RLM identification.`;
  }
  if (status === "ambiguous") {
    return `More than one candidate schedule remains tied, ${scopeNote} — see the list below rather than a single guess (CLAUDE.md rule 7).`;
  }
  return "No candidate schedule found for this headcode today, mirrored from openrail-eps (garner).";
}
