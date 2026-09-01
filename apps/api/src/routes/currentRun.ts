import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  TD_PROJECTION_VERSION,
  decodeTrustMovementFlags,
  selectEffectiveSchedule,
  signedVariationMinutes,
  type ScheduleCandidate,
} from "@railway/domain";
import { apiError } from "../lib/queryRange.js";
import { locationToJson, type CifLocationRowLike } from "./schedule.js";

export interface CurrentRunRoutesDeps {
  pool: Pool;
}

/**
 * `GET /api/v1/td/areas/{tdArea}/berths/{berth}/current-run` — the live map's click-a-berth
 * popup.
 *
 * Since ADR 0002 (2026-09-01) RLM has no berth-run resolver: it does not claim a single train
 * identity for a berth. Instead this returns, honestly labelled as garner's data:
 *   - the TD headcode currently in the berth,
 *   - every `cif_schedules` row whose signalling id equals that headcode and that runs today
 *     (the STP-effective one flagged), mirrored from the operator's openrail-eps instance,
 *   - for the effective schedule, its calling points, its most recent TRUST activation, and the
 *     latest `trust_movement` report for that activation.
 * When more than one schedule shares the headcode and none is TRUST-activated today, `effective`
 * is null and the caller sees the ambiguity rather than a guess (CLAUDE.md rule 7 in spirit).
 */
interface CurrentStateRow {
  description: string | null;
  occupancy_id: string | null;
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

export async function registerCurrentRunRoutes(
  app: FastifyInstance,
  deps: CurrentRunRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get<{ Params: { tdArea: string; berth: string } }>(
    "/api/v1/td/areas/:tdArea/berths/:berth/current-run",
    async (request, reply) => {
      const { tdArea, berth } = request.params;

      const stateResult = await pool.query<CurrentStateRow>(
        `select description, occupancy_id, occupancy_entered_at
         from berth_current_state
         where projection_version = $1 and td_area = $2 and berth_code = $3`,
        [TD_PROJECTION_VERSION, tdArea, berth],
      );
      const state = stateResult.rows[0];
      if (!state || !state.occupancy_id || !state.description) {
        reply.code(404);
        return apiError("BERTH_NOT_OCCUPIED", `${tdArea} ${berth} has no current occupancy`);
      }

      const headcode = state.description;
      const today = londonToday(new Date());

      const candidateResult = await pool.query<CandidateScheduleRow>(
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
           and $2::date between s.schedule_start_date and s.schedule_end_date`,
        [headcode, today],
      );

      const candidateRows = candidateResult.rows;
      const scheduleIds = candidateRows.map((row) => row.id);

      // TRUST activations for any candidate schedule since the start of today (London).
      const activationRows = scheduleIds.length
        ? (
            await pool.query<ActivationRow>(
              `select cif_schedule_id::text as cif_schedule_id, trust_id, deduced, created
               from trust_activation
               where cif_schedule_id = any($1::bigint[])
                 and created >= ($2::date)::timestamptz
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

      const stpCandidates: (ScheduleCandidate & { row: CandidateScheduleRow })[] =
        candidateRows.map((row) => ({
          stpIndicator: normalizeStp(row.cif_stp_indicator),
          scheduleStartDate: row.schedule_start_date,
          scheduleEndDate: row.schedule_end_date,
          daysRunsBitmask: row.days_runs_bitmask,
          row,
        }));
      const stpOutcome = selectEffectiveSchedule(stpCandidates, today);

      // Effective schedule: the STP winner if unambiguous; otherwise, if exactly one candidate
      // has a TRUST activation today, that one (garner's own confirmation breaks the tie);
      // otherwise none.
      let effectiveRow: CandidateScheduleRow | null = null;
      if (stpOutcome.outcome === "matched") {
        effectiveRow = stpOutcome.selected.row;
      } else {
        const activatedCandidates = candidateRows.filter((row) =>
          activationByScheduleId.has(row.id),
        );
        if (activatedCandidates.length === 1) effectiveRow = activatedCandidates[0]!;
      }

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

      let effective: unknown = null;
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
          selectedBy: stpOutcome.outcome === "matched" ? "stp_precedence" : "trust_activation",
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

      return {
        tdArea,
        berth,
        description: headcode,
        headcode,
        occupancyEnteredAt: state.occupancy_entered_at
          ? state.occupancy_entered_at.toISOString()
          : null,
        note:
          "Candidate schedules for this headcode running today, mirrored from openrail-eps " +
          "(garner). RLM's berth-to-run resolver is being rebuilt (ADR 0002) — this is garner's " +
          "data, not a confirmed RLM identification.",
        effective,
        candidateSchedules,
      };
    },
  );
}
