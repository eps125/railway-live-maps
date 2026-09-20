import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { Redis } from "ioredis";
import {
  TD_PROJECTION_VERSION,
  decodeTrustMovementFlags,
  signedVariationMinutes,
} from "@railway/domain";
import {
  findOpenOccupancy,
  findOccupancyLink,
  upsertResolvedLink,
  resolveFreshRunMatch,
  fetchScheduleRowById,
  buildCandidateSchedules,
  berthStanoxes,
  normalizeStp,
  londonToday,
  londonMinutesSinceMidnight,
  fetchTrustChanges,
  type CandidateScheduleRow,
  type ActivationRow,
} from "@railway/database";
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
 *
 * Milestone 57 — `?at=<iso>` (playback). Without it this route answers "who is in this berth
 * *now*", reading `berth_current_state`; that made every click on the playback map a no-op,
 * since a berth occupied half an hour ago is almost always vacant now and 404'd. With `at`, the
 * occupancy covering that instant is read from `berth_occupancy` instead, and — the point of the
 * whole thing — its `berth_occupancy_run_link` row is reused as-is. That link was written while
 * the train was live (by a click here, or by `run-lineage-daemon`'s proactive sweep) and carries
 * the traffic day it was actually resolved against, so playback replays the identification the
 * live map already made rather than recomputing one. Where no link exists the same
 * `resolveFreshRunMatch` fallback runs, but keyed to `at` rather than the wall clock (owner
 * decision, 2026-09-20, in preference to reporting those occupancies as `unmatched`).
 *
 * A `?at=` request is strictly read-only: it never writes a link (see the `!at` guard below), so
 * scrubbing through history can't rewrite what the live path established, and a stored link and
 * a fresh resolution can never disagree — the fallback only runs where there is no link.
 */
interface CurrentStateRow {
  description: string | null;
  occupancy_entered_at: Date | null;
}

/** The occupancy interval covering a `?at=` instant (Milestone 57) — `berth_occupancy` rather
 * than `berth_current_state`, since the latter only ever describes right now. */
interface HistoricalOccupancyRow {
  id: string;
  entered_at: Date;
  description: string;
}

/** How far back before `at` an occupancy may have *started* and still be considered. This is a
 * partition-pruning bound, not a business rule: `berth_occupancy` is partitioned monthly by
 * `entered_at` (apps/worker/src/commands/ensurePartitions.ts), so `entered_at <= at` alone has
 * no lower bound and makes the planner scan every partition ever created — the same class of
 * mistake as the 2026-09-14 run-lineage incident. With this bound at most two partitions are
 * touched. A real TD occupancy lasts minutes; 24h is far beyond any genuine one, and the effect
 * of exceeding it is a `BERTH_NOT_OCCUPIED` for a berth that has been sat on a stale description
 * for over a day — correct enough, and never a wrong identification. */
const HISTORICAL_OCCUPANCY_LOOKBACK = "24 hours";

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

/** docs/adr/0009: a TRUST Change of Origin/Identity, or a part-cancellation (owner-confirmed
 * 2026-09-17 reading: its own location is the run's new effective destination — TRUST has no
 * dedicated "change of destination" message), in effect for the matched run right now. `null`
 * when nothing of that kind has happened. Full/authenticated response only — see
 * `toPublicEffective`'s own doc comment for why: this reads as resolver-internal/diagnostic detail,
 * the same reasoning that already keeps TRUST ids and the `deduced` flag out of the public view. */
interface EffectiveChangeDetail {
  previousTiploc: string | null;
  previousName: string | null;
  changedAt: string;
  reason: string | null;
}

interface EffectiveIdentityChange {
  previousTrustId: string;
  newTrustId: string;
  changedAt: string;
  /** docs/adr/0010: the run's own reporting headcode, decoded from each TRUST id — a Change of
   * Identity confirmed to change this for real (2026-09-17 incident: trust_id "426C02C417" ->
   * "420C02C417" is headcode 6C02 -> 0C02). `null` when either id isn't decodable. */
  previousHeadcode: string | null;
  newHeadcode: string | null;
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
  /** Milestone 49 (docs/adr/0009): the run's *current* origin/destination — overridden from the
   * static schedule's LO/LT tiploc when a Change of Origin/part-cancellation is in effect. Always
   * the field to display; `originChange`/`destinationChange` below are the "what it used to be and
   * when" detail. */
  originTiploc: string | null;
  originName: string | null;
  originChange: EffectiveChangeDetail | null;
  destinationTiploc: string | null;
  destinationName: string | null;
  destinationChange: EffectiveChangeDetail | null;
  identityChange: EffectiveIdentityChange | null;
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
  // garner's `train_allocation` is an append-only log of allocation *reports*, not a mutable
  // "current formation" table (its own migration comment assumed the latter) — every time control
  // swaps a unit, garner emits a brand-new row for the same `position` with a new `id`/`message_id`
  // rather than updating the old one, and RLM's mirror (upsert-by-id, ADR 0002) faithfully keeps
  // every one of them. Without `distinct on (position)` here, a position reallocated N times today
  // shows as N different units in the formation simultaneously (reported 2026-09-14 against 1P09/
  // W34091: 6 rows, all `position = 1`, real allocation changes through the day — only the last,
  // 390050, was actually the current unit). `coalesce(reported, synced_at)` falls back to RLM's own
  // mirror-ingestion time when garner didn't send a `reported` timestamp for a given report; `id`
  // (garner's own monotonic PK) is the final tiebreak for an exact tie either way.
  const result = await pool.query<UnitAllocationRow>(
    `select distinct on ("position") unit_no, "position", fleet_id, vehicles, reported
     from train_allocation
     where cif_train_uid = $1 and schedule_start_date = $2::date
     order by "position" asc, coalesce(reported, synced_at) desc, id desc`,
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

  app.get<{ Params: { tdArea: string; berth: string }; Querystring: { at?: string } }>(
    "/api/v1/td/areas/:tdArea/berths/:berth/current-run",
    async (request, reply) => {
      const { tdArea, berth } = request.params;

      // Owner request (2026-09-13): optional auth — never required to view the map or this
      // popup at all, only to see full detail. A missing/invalid cookie is just "anonymous",
      // never a 401 (this route stays public, matching every other live-map read).
      const isAuthenticated =
        (await getSession(redis, request.cookies[SESSION_COOKIE_NAME], sessionTtlSeconds)) !== null;

      // Milestone 57: `?at=<iso>` asks this same question about a past moment, so the playback
      // map's click-a-berth popup behaves like the live one. Everything time-dependent below
      // keys off `referenceNow`, never the wall clock — see this route's doc comment.
      const atRaw = request.query.at;
      let at: Date | null = null;
      if (atRaw !== undefined) {
        const parsed = new Date(atRaw);
        if (Number.isNaN(parsed.getTime())) {
          reply.code(400);
          return apiError("INVALID_AT", "`at` must be an ISO 8601 timestamp");
        }
        at = parsed;
      }
      const referenceNow = at ?? new Date();

      let headcode: string;
      let occupancyEnteredAt: string | null;
      let occupancy: { id: string; enteredAt: Date } | null;

      if (at) {
        // The occupancy interval covering `at`: started at or before it, and either still open
        // or released after it. `berth_current_state` is deliberately not consulted — it only
        // describes right now, and reading it for a historical question is exactly the bug this
        // milestone fixes (a berth vacant now 404'd, so every playback click did nothing).
        const historical = (
          await pool.query<HistoricalOccupancyRow>(
            `select id, entered_at, description
             from berth_occupancy
             where projection_version = $1 and td_area = $2 and berth_code = $3
               and entered_at <= $4::timestamptz
               and entered_at > $4::timestamptz - $5::interval
               and (left_at is null or left_at > $4::timestamptz)
             order by entered_at desc
             limit 1`,
            [TD_PROJECTION_VERSION, tdArea, berth, at.toISOString(), HISTORICAL_OCCUPANCY_LOOKBACK],
          )
        ).rows[0];
        if (!historical) {
          reply.code(404);
          return apiError(
            "BERTH_NOT_OCCUPIED",
            `${tdArea} ${berth} had no occupancy at ${at.toISOString()}`,
          );
        }
        headcode = historical.description;
        occupancyEnteredAt = historical.entered_at.toISOString();
        occupancy = { id: historical.id, enteredAt: historical.entered_at };
      } else {
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
        headcode = state.description;
        occupancyEnteredAt = state.occupancy_entered_at
          ? state.occupancy_entered_at.toISOString()
          : null;
        occupancy = await findOpenOccupancy(pool, tdArea, berth);
      }

      const today = londonToday(referenceNow);

      // Milestone 39 (docs/adr/0007): does this occupancy already carry a run link — established
      // by an earlier click here, or inherited by `run-lineage-daemon` from a berth this train
      // physically stepped from (or across an owner-curated TD-area boundary)? If so, skip
      // headcode/position resolution entirely: the physical evidence behind the link is stronger
      // than re-deriving from a headcode string, and re-deriving nationwide is exactly the
      // redundant work sticky matching exists to avoid.
      //
      // For `?at=` this is also the *whole* point (Milestone 57): the link was written while the
      // run was live, carrying the traffic day it was actually resolved against, so playback
      // reads back the identification the live map already made instead of recomputing one.
      const occupancyLink = occupancy ? await findOccupancyLink(pool, occupancy) : null;
      const lineageSchedule =
        occupancyLink?.cifScheduleId != null
          ? await fetchScheduleRowById(pool, occupancyLink.cifScheduleId)
          : null;

      let matchStatus: "matched" | "ambiguous" | "unmatched";
      let matchBasis:
        | "trust_activation"
        | "stp_precedence"
        | "station_berth_timetable"
        | "headcode_only"
        | "step_chain"
        | "boundary_correlated"
        | null;
      let positionScoped: boolean;
      let effectiveRow: CandidateScheduleRow | null;
      let candidateSchedules: ReturnType<typeof buildCandidateSchedules>;
      let isSolidMatch: boolean;
      // Traffic-day-boundary fix (docs/adr/0008): the real traffic day `effectiveRow` was matched
      // against — `today` for the overwhelming majority of matches, but genuinely `today`'s
      // *previous* day for an overnight train whose schedule only that earlier date covers. Never
      // hardcode `today` downstream (TRUST activation detail, unit allocation, the link written
      // below) — use this instead, since it's the one that's actually correct for this match.
      let effectiveTrafficDay: string | null = null;

      if (lineageSchedule && occupancyLink) {
        matchStatus = "matched";
        matchBasis = occupancyLink.matchBasis as "step_chain" | "boundary_correlated";
        // positionScoped describes this berth's own SMART coverage, independent of how the match
        // was actually produced — still worth reporting honestly either way.
        positionScoped = (await berthStanoxes(pool, tdArea, berth)).length > 0;
        effectiveRow = lineageSchedule;
        isSolidMatch = occupancyLink.matchConfidence === "solid";
        // The link's own `traffic_day` (docs/adr/0007) is already the traffic day this schedule
        // was actually resolved against — not necessarily "today" for a still-open overnight run.
        effectiveTrafficDay = occupancyLink.trafficDay;
        const activation = (
          await pool.query<ActivationRow>(
            `select cif_schedule_id::text as cif_schedule_id, trust_id, deduced, created
             from trust_activation
             where cif_schedule_id = $1
               and created >= ($2::date)::timestamp at time zone 'Europe/London'
             order by created desc limit 1`,
            [lineageSchedule.id, effectiveTrafficDay],
          )
        ).rows[0];
        candidateSchedules = buildCandidateSchedules(
          [lineageSchedule],
          new Map(activation ? [[activation.cif_schedule_id, activation]] : []),
          lineageSchedule.id,
        );
      } else {
        // Milestone 34 (docs/adr/0006), extracted to @railway/database's resolveFreshRunMatch so
        // apps/worker's proactive sweep (docs/adr/0007 addendum) shares the exact same logic —
        // see that function's own doc comment for the position-scoping/fallback rules.
        // Milestone 57: `today`/`nowMinutes` both derive from `referenceNow`, so a `?at=` query
        // resolves against the traffic day that was current *at that moment*, not the one that
        // happens to be current when the request arrives. `resolveFreshRunMatch` takes both as
        // explicit arguments and derives its own `yesterday` via `previousCalendarDate(today)`
        // (docs/adr/0008's two-date window), so the whole overnight-boundary behaviour follows
        // `at` correctly without any date arithmetic here: a 23:50 departure inspected at 00:30
        // the next day gets `today = <the 20th>` and probes `[<20th>, <19th>]`, matching the
        // 19th-dated schedule exactly as the live path does when clicked at 00:30 for real.
        const nowMinutes = londonMinutesSinceMidnight(referenceNow);
        const fresh = await resolveFreshRunMatch(pool, {
          tdArea,
          berth,
          headcode,
          today,
          nowMinutes,
        });
        matchStatus = fresh.matchStatus;
        matchBasis = fresh.matchBasis;
        positionScoped = fresh.positionScoped;
        effectiveRow = fresh.effectiveRow;
        isSolidMatch = fresh.isSolidMatch;
        candidateSchedules = fresh.candidateSchedules;
        effectiveTrafficDay = fresh.trafficDay;

        // Milestone 39 (docs/adr/0007): a real (non-lineage) match establishes/corrects the link
        // a later physical step can carry forward — never blocks the response on failure.
        //
        // Milestone 57: never from a `?at=` query. Browsing history is a read; it must not
        // rewrite stored lineage, and a historical re-resolution is weaker evidence than the
        // live one it would overwrite (garner's activation/movement data has moved on since).
        // Keeping playback read-only also means a stored link and a fresh resolution can never
        // contradict each other: the fallback only ever runs where no link exists, and what it
        // computes stays in the response rather than becoming a new fact about the past.
        if (
          !at &&
          matchStatus === "matched" &&
          effectiveRow &&
          occupancy &&
          matchBasis &&
          effectiveTrafficDay
        ) {
          const scheduleForLink = effectiveRow;
          const basisForLink = matchBasis;
          const trafficDayForLink = effectiveTrafficDay;
          try {
            await upsertResolvedLink(pool, occupancy, {
              cifScheduleId: scheduleForLink.id,
              cifTrainUid: scheduleForLink.cif_train_uid,
              trafficDay: trafficDayForLink,
              matchBasis: basisForLink as
                "trust_activation" | "stp_precedence" | "station_berth_timetable" | "headcode_only",
              matchConfidence: isSolidMatch ? "solid" : "weak",
              tdArea,
              berth,
            });
          } catch (error) {
            app.log.error({ error }, "run-lineage: failed to establish/correct resolved link");
          }
        }
      }

      let effective: EffectiveScheduleFull | null = null;
      if (effectiveRow) {
        // `effectiveTrafficDay` is always set whenever `effectiveRow` is (both branches above set
        // it together) — `?? today` only guards TypeScript's narrowing, never a real fallback.
        const activation =
          (
            await pool.query<ActivationRow>(
              `select cif_schedule_id::text as cif_schedule_id, trust_id, deduced, created
               from trust_activation
               where cif_schedule_id = $1
                 and created >= ($2::date)::timestamp at time zone 'Europe/London'
               order by created desc limit 1`,
              [effectiveRow.id, effectiveTrafficDay ?? today],
            )
          ).rows[0] ?? null;

        const locations = (
          await pool.query<CifLocationRowLike>(
            `select seq_no, record_identity, location_type, tiploc_code, arrival, departure, "pass",
                    public_arrival, public_departure, platform, path, line, next_day
             from cif_schedule_locations where cif_schedule_id = $1 order by seq_no`,
            [effectiveRow.id],
          )
        ).rows;

        // docs/adr/0009: what's actually true for this run right now, beyond the static schedule —
        // resolved before `latestMovement` below, since a Change of Identity means movements can
        // arrive under a *different* TRUST id than the one that activated it.
        const trustChanges = activation
          ? await fetchTrustChanges(
              pool,
              activation.trust_id,
              effectiveRow.origin_tiploc,
              effectiveRow.destination_tiploc,
            )
          : null;

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
               where trust_id = any($1::text[])
               order by actual_timestamp desc nulls last, created desc
               limit 1`,
              [trustChanges?.trustIdChain ?? [activation.trust_id]],
            )
          ).rows[0];
        }

        // TIPLOC / STANOX -> human-readable names (CORPUS mirror, location_reference). Includes
        // any revised origin/destination/calling-point tiplocs docs/adr/0009 resolved above, so
        // they're named in this same query rather than a second round trip.
        const tiplocsNeeded = new Set<string>(locations.map((l) => l.tiploc_code));
        if (effectiveRow.origin_tiploc) tiplocsNeeded.add(effectiveRow.origin_tiploc);
        if (effectiveRow.destination_tiploc) tiplocsNeeded.add(effectiveRow.destination_tiploc);
        if (trustChanges?.originTiploc) tiplocsNeeded.add(trustChanges.originTiploc);
        if (trustChanges?.destinationTiploc) tiplocsNeeded.add(trustChanges.destinationTiploc);
        for (const change of trustChanges?.locationChanges ?? []) {
          if (change.originalTiploc) tiplocsNeeded.add(change.originalTiploc);
          if (change.tiploc) tiplocsNeeded.add(change.tiploc);
        }
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

        // docs/adr/0009: the run's current origin/destination — the static schedule's LO/LT tiploc,
        // overridden when a Change of Origin / part-cancellation is in effect. `effectiveRow.*`
        // stays as the "previous" value in the *Change detail, exactly what it names.
        const originTiploc = trustChanges?.originTiploc ?? effectiveRow.origin_tiploc;
        const destinationTiploc =
          trustChanges?.destinationTiploc ?? effectiveRow.destination_tiploc;
        const originChange: EffectiveChangeDetail | null =
          trustChanges?.originTiploc && trustChanges.originChangedAt
            ? {
                previousTiploc: effectiveRow.origin_tiploc,
                previousName: effectiveRow.origin_tiploc
                  ? (nameByTiploc.get(effectiveRow.origin_tiploc) ?? null)
                  : null,
                changedAt: trustChanges.originChangedAt,
                reason: trustChanges.originChangeReason,
              }
            : null;
        const destinationChange: EffectiveChangeDetail | null =
          trustChanges?.destinationTiploc && trustChanges.destinationChangedAt
            ? {
                previousTiploc: effectiveRow.destination_tiploc,
                previousName: effectiveRow.destination_tiploc
                  ? (nameByTiploc.get(effectiveRow.destination_tiploc) ?? null)
                  : null,
                changedAt: trustChanges.destinationChangedAt,
                reason: trustChanges.destinationChangeReason,
              }
            : null;
        const identityChange: EffectiveIdentityChange | null =
          trustChanges?.previousTrustId && trustChanges.identityChangedAt
            ? {
                previousTrustId: trustChanges.previousTrustId,
                newTrustId: trustChanges.effectiveTrustId,
                changedAt: trustChanges.identityChangedAt,
                previousHeadcode: trustChanges.previousHeadcode,
                newHeadcode: trustChanges.newHeadcode,
              }
            : null;
        // A Change of Location revises one scheduled calling point in place — reflected here (not
        // struck through: owner request 2026-09-17, unlike openrail's own detail page), matched by
        // the *original* tiploc a change refers to.
        const locationChangeByOriginalTiploc = new Map(
          (trustChanges?.locationChanges ?? [])
            .filter((change) => change.originalTiploc && change.tiploc)
            .map((change) => [change.originalTiploc as string, change]),
        );

        effective = {
          scheduleId: effectiveRow.id,
          trainUid: effectiveRow.cif_train_uid,
          stpIndicator: normalizeStp(effectiveRow.cif_stp_indicator),
          source: "GARNER" as const,
          operatorCode: effectiveRow.atoc_code,
          trainStatus: effectiveRow.train_status,
          serviceCode: effectiveRow.cif_train_service_code,
          category: effectiveRow.cif_train_category,
          originTiploc,
          originName: originTiploc ? (nameByTiploc.get(originTiploc) ?? null) : null,
          originChange,
          destinationTiploc,
          destinationName: destinationTiploc ? (nameByTiploc.get(destinationTiploc) ?? null) : null,
          destinationChange,
          identityChange,
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
          locations: locations.map((row) => {
            const change = locationChangeByOriginalTiploc.get(row.tiploc_code);
            const tiploc = change?.tiploc ?? row.tiploc_code;
            return {
              ...locationToJson(row),
              tiploc,
              locationName: nameByTiploc.get(tiploc) ?? null,
            };
          }),
        };
      }

      // Always an array (docs/API_CONTRACT.md: "empty when garner has nothing allocated") — an
      // ambiguous/unmatched berth has no single train to key an allocation by, which is exactly
      // "nothing allocated", not the absence of the field. `null` here previously crashed the web
      // popup's unconditional `unitAllocation.length` (no effective schedule -> blank page,
      // reported 2026-09-14 against PX 0127/0133, both `unmatched` today).
      const unitAllocation = effectiveRow
        ? await queryUnitAllocation(pool, effectiveRow.cif_train_uid, effectiveTrafficDay ?? today)
        : [];

      // Owner request (2026-09-13): a "solid" match — matched, and not the weakest unscoped
      // headcode_only tier (that one's own note already says "verify before trusting this", so
      // it shouldn't be shown to anonymous visitors as if it were confident public fact).
      // `isSolidMatch` is computed per-branch above (Milestone 39: a lineage match's solidity
      // follows its inherited `match_confidence`, capped at whatever produced it originally,
      // rather than being re-derived from `matchBasis` alone).
      if (!isAuthenticated && !isSolidMatch) {
        reply.code(404);
        return apiError(
          "NO_PUBLIC_DETAIL",
          "No confirmed match to show without logging in — this berth's identification is either ambiguous, unmatched, or too weak to show publicly",
        );
      }

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
        matchStatus,
        matchBasis,
        positionScoped,
        note: matchNote(matchStatus, matchBasis, positionScoped),
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
  basis:
    | "trust_activation"
    | "stp_precedence"
    | "station_berth_timetable"
    | "headcode_only"
    | "step_chain"
    | "boundary_correlated"
    | null,
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
  if (status === "matched" && basis === "step_chain") {
    return `Identity carried forward from an earlier berth this train physically stepped from (docs/adr/0007) — not re-derived from this berth's own headcode/position data. Not a confirmed RLM identification.`;
  }
  if (status === "matched" && basis === "boundary_correlated") {
    return `Identity carried forward across a TD-area boundary crossing, corroborated by schedule timing and/or TRUST movement continuity (docs/adr/0007) — never by headcode alone. Not a confirmed RLM identification.`;
  }
  if (status === "matched") {
    return `Matched by headcode alone (no SMART position data for this berth) — the weakest evidence tier; verify before trusting this. Not a confirmed RLM identification.`;
  }
  if (status === "ambiguous") {
    return `More than one candidate schedule remains tied, ${scopeNote} — see the list below rather than a single guess (CLAUDE.md rule 7).`;
  }
  return "No candidate schedule found for this headcode today, mirrored from openrail-eps (garner).";
}
