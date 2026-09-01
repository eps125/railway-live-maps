import type { Pool as PgPool } from "pg";
import type { Pool as MysqlPool, RowDataPacket } from "mysql2/promise";
import {
  getOrCreateProjectionDefinition,
  ensureCheckpoint,
  getCheckpoint,
  advanceCheckpoint,
} from "@railway/database";

/**
 * garner-bridge importers (ADR 0002). Each reads a table from the operator's openrail-eps
 * ("garner") MariaDB and mirrors it into Railway Live Maps' Postgres. RLM does not subscribe to
 * Network Rail for TRUST / VSTP / SCHEDULE / CORPUS / SMART — garner is itself NR-subscribed and
 * retains/archives raw frames, so it is the retention layer for those feeds (ADR 0002 exception
 * to CLAUDE.md non-negotiable 1); "raw with lineage" here means the garner row plus its
 * `(table, key, created)`.
 *
 *  - CORPUS  -> location_reference   (full re-sync; small, changes at most daily)
 *  - SMART   -> smart_berth_step     (full re-sync)
 *  - cif_schedules / cif_schedule_locations -> cif_schedules / cif_schedule_locations
 *                                    (near-verbatim mirror; two watermarks —
 *                                    `garner-cif_schedules-id` on the auto-increment `id` for
 *                                    new/amended rows, `garner-cif_schedules-deleted` on `deleted`
 *                                    for withdrawals. `created` is NOT a watermark key — a full
 *                                    CIF reload gives ~300k rows one identical `created`. A live
 *                                    garner row's `deleted` is the GARNER_NOT_DELETED sentinel.)
 *  - trust_activation / trust_activation_extra / trust_movement / trust_cancellation /
 *    trust_changeorigin / trust_changeid / trust_changelocation -> same-named RLM tables
 *                                    (near-verbatim mirror, watermarked by `created`)
 *
 * Watermarks live in `projection_checkpoint` under `garner-<table>` names, storing the last
 * synced epoch-seconds value in `last_ingestion_sequence`. A fresh watermark is seeded forward to
 * `now - GARNER_BRIDGE_BACKFILL_DAYS` (except the schedule `created` watermark — every live
 * schedule must be mirrored regardless of age).
 */

const GARNER_SYNC_VERSION = 1;

// ---------------------------------------------------------------------------
// value conversion helpers (garner stores every timestamp as INT UNSIGNED epoch-seconds,
// 0 meaning "absent"; BOOLEAN columns come back as 0/1)
// ---------------------------------------------------------------------------

/** openrail cifdb `#define NOT_DELETED 0xffffffffL` — a *live* `cif_schedules` / `cif_tiplocs`
 * row carries this sentinel in its `deleted` column; a withdrawn row carries the real epoch it
 * was withdrawn at. (Distinct from the `trust_*` tables, which have no `deleted` column.) */
export const GARNER_NOT_DELETED = 4294967295;

function epochToTs(value: number | null | undefined): Date | null {
  return value && value > 0 ? new Date(value * 1000) : null;
}

/** garner's `cif_schedules.deleted`: `GARNER_NOT_DELETED` (or 0) means "live" -> NULL on the RLM
 * side; anything else is the real withdrawal timestamp. */
export function garnerDeletedToTs(value: number | null | undefined): Date | null {
  return value && value > 0 && value < GARNER_NOT_DELETED ? new Date(value * 1000) : null;
}

function epochToDateString(value: number | null | undefined): string | null {
  if (!value || value <= 0) return null;
  return new Date(value * 1000).toISOString().slice(0, 10);
}

function bool(value: number | boolean | null | undefined): boolean {
  return value === true || value === 1;
}

function nonEmpty(value: string | null | undefined): string | null {
  return value != null && String(value).trim().length > 0 ? String(value) : null;
}

/** garner stanox is an INT; RLM keeps it as CIF/CORPUS-style zero-padded text. `0` = "not supplied". */
function stanoxText(value: number | null | undefined): string | null {
  return value && value > 0 ? String(value).padStart(5, "0") : null;
}

// ---------------------------------------------------------------------------
// watermark plumbing
// ---------------------------------------------------------------------------

async function watermarkDefId(pg: PgPool, name: string): Promise<string> {
  const id = await getOrCreateProjectionDefinition(pg, name, GARNER_SYNC_VERSION, name);
  await ensureCheckpoint(pg, id);
  return id;
}

async function readWatermark(pg: PgPool, defId: string): Promise<number> {
  const cp = await getCheckpoint(pg, defId);
  return Number(cp?.lastIngestionSequence ?? "0");
}

/** Seed a never-run watermark forward to `epochFloor` so the bridge's first pass doesn't grind
 * from the Unix epoch through data garner no longer even retains. Only fires when the checkpoint
 * is genuinely fresh (`0` and never completed) — after that `advanceCheckpoint`'s own monotonic
 * `greatest(...)` takes over. */
async function seedWatermarkIfFresh(pg: PgPool, defId: string, epochFloor: number): Promise<void> {
  const cp = await getCheckpoint(pg, defId);
  if (cp && cp.lastIngestionSequence === "0" && cp.lastCompletedAt === null) {
    await advanceCheckpoint(pg, defId, String(Math.max(0, Math.floor(epochFloor))));
  }
}

/** Insert `rows` into `table` (columns `cols`) in chunks, with an `on conflict` tail. Each row is
 * a positional value array matching `cols`. */
async function chunkedInsert(
  pg: PgPool,
  table: string,
  cols: string[],
  rows: unknown[][],
  conflictTail: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const perChunk = Math.max(1, Math.floor(60000 / cols.length));
  let written = 0;
  for (let i = 0; i < rows.length; i += perChunk) {
    const chunk = rows.slice(i, i + perChunk);
    const params: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        params.push(value);
        return `$${params.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const result = await pg.query(
      `insert into ${table} (${cols.join(", ")}) values ${tuples.join(", ")} ${conflictTail}`,
      params,
    );
    written += result.rowCount ?? 0;
  }
  return written;
}

// ---------------------------------------------------------------------------
// CORPUS / SMART (unchanged: full re-sync)
// ---------------------------------------------------------------------------

interface CorpusRow extends RowDataPacket {
  tiploc: string;
  stanox: number;
  "3alpha": string;
  nlc: string;
  nlcdesc: string;
  nlcdesc16: string;
  uic: string;
}

interface SmartRow extends RowDataPacket {
  td: string;
  fromberth: string;
  toberth: string;
  stanox: number;
  event: string;
  steptype: string;
  route: number;
  platform: number;
  berthoffset: number;
  toline: string;
  fromline: string;
  stanme: string;
  comment: string;
}

async function syncCorpus(garner: MysqlPool, pg: PgPool): Promise<number> {
  const [rows] = await garner.query<CorpusRow[]>(
    `select tiploc, stanox, \`3alpha\`, nlc, nlcdesc, nlcdesc16, uic
     from corpus where tiploc <> ''`,
  );
  if (rows.length === 0) return 0;

  const tuples = rows.map((row) => [
    row.tiploc.trim(),
    stanoxText(row.stanox),
    nonEmpty(row["3alpha"]),
    nonEmpty(row.nlc),
    nonEmpty(row.uic),
    nonEmpty(row.nlcdesc) ?? nonEmpty(row.nlcdesc16),
    "GARNER",
    JSON.stringify(row),
  ]);

  return chunkedInsert(
    pg,
    "location_reference",
    ["tiploc", "stanox", "crs", "nlc", "uic", "name", "source", "raw_source_json"],
    tuples,
    `on conflict (tiploc) do update set
       stanox = excluded.stanox, crs = excluded.crs, nlc = excluded.nlc, uic = excluded.uic,
       name = excluded.name, source = 'GARNER', raw_source_json = excluded.raw_source_json,
       imported_at = now()`,
  );
}

async function syncSmart(garner: MysqlPool, pg: PgPool): Promise<number> {
  const [rows] = await garner.query<SmartRow[]>(
    `select td, fromberth, toberth, stanox, event, steptype, route, platform, berthoffset,
            toline, fromline, stanme, comment
     from smart where td <> ''`,
  );
  if (rows.length === 0) return 0;

  const tuples = rows.map((row) => [
    row.td.trim(),
    nonEmpty(row.fromberth),
    nonEmpty(row.toberth),
    stanoxText(row.stanox),
    row.platform && row.platform > 0 ? String(row.platform) : null,
    nonEmpty(row.event),
    row.route ? String(row.route) : null,
    null,
    JSON.stringify(row),
  ]);

  return chunkedInsert(
    pg,
    "smart_berth_step",
    [
      "td_area",
      "from_berth",
      "to_berth",
      "stanox",
      "platform",
      "event_type",
      "route_indicator",
      "source_file_import_id",
      "raw_source_json",
    ],
    tuples,
    `on conflict (td_area, coalesce(from_berth, ''), coalesce(to_berth, ''), coalesce(event_type, ''))
     do update set
       stanox = excluded.stanox, platform = excluded.platform,
       route_indicator = excluded.route_indicator, raw_source_json = excluded.raw_source_json,
       imported_at = now()`,
  );
}

// ---------------------------------------------------------------------------
// CIF schedules
// ---------------------------------------------------------------------------

interface CifScheduleRow extends RowDataPacket {
  id: number;
  update_id: number;
  created: number;
  deleted: number;
  CIF_bank_holiday_running: string;
  CIF_stp_indicator: string;
  CIF_train_uid: string;
  applicable_timetable: string;
  atoc_code: string;
  uic_code: string;
  runs_mo: number;
  runs_tu: number;
  runs_we: number;
  runs_th: number;
  runs_fr: number;
  runs_sa: number;
  runs_su: number;
  schedule_start_date: number;
  schedule_end_date: number;
  signalling_id: string;
  CIF_train_category: string;
  CIF_headcode: string;
  CIF_train_service_code: string;
  CIF_business_sector: string;
  CIF_power_type: string;
  CIF_timing_load: string;
  CIF_speed: string;
  CIF_operating_characteristics: string;
  CIF_train_class: string;
  CIF_sleepers: string;
  CIF_reservations: string;
  CIF_connection_indicator: string;
  CIF_catering_code: string;
  CIF_service_branding: string;
  train_status: string;
  deduced_headcode: string;
  deduced_headcode_status: string;
}

interface CifScheduleLocationRow extends RowDataPacket {
  cif_schedule_id: number;
  update_id: number;
  location_type: string;
  record_identity: string;
  tiploc_code: string;
  tiploc_instance: string;
  arrival: string;
  departure: string;
  pass: string;
  public_arrival: string;
  public_departure: string;
  sort_time: number;
  next_day: number;
  platform: string;
  line: string;
  path: string;
  engineering_allowance: string;
  pathing_allowance: string;
  performance_allowance: string;
}

const CIF_SCHEDULE_COLS = [
  "id",
  "update_id",
  "created",
  "deleted",
  "cif_bank_holiday_running",
  "cif_stp_indicator",
  "cif_train_uid",
  "applicable_timetable",
  "atoc_code",
  "uic_code",
  "runs_mo",
  "runs_tu",
  "runs_we",
  "runs_th",
  "runs_fr",
  "runs_sa",
  "runs_su",
  "schedule_start_date",
  "schedule_end_date",
  "signalling_id",
  "cif_train_category",
  "cif_headcode",
  "cif_train_service_code",
  "cif_business_sector",
  "cif_power_type",
  "cif_timing_load",
  "cif_speed",
  "cif_operating_characteristics",
  "cif_train_class",
  "cif_sleepers",
  "cif_reservations",
  "cif_connection_indicator",
  "cif_catering_code",
  "cif_service_branding",
  "train_status",
  "deduced_headcode",
  "deduced_headcode_status",
];

const CIF_SCHEDULE_CONFLICT = `on conflict (id) do update set
  update_id = excluded.update_id, created = excluded.created, deleted = excluded.deleted,
  cif_bank_holiday_running = excluded.cif_bank_holiday_running,
  cif_stp_indicator = excluded.cif_stp_indicator, cif_train_uid = excluded.cif_train_uid,
  applicable_timetable = excluded.applicable_timetable, atoc_code = excluded.atoc_code,
  uic_code = excluded.uic_code,
  runs_mo = excluded.runs_mo, runs_tu = excluded.runs_tu, runs_we = excluded.runs_we,
  runs_th = excluded.runs_th, runs_fr = excluded.runs_fr, runs_sa = excluded.runs_sa,
  runs_su = excluded.runs_su,
  schedule_start_date = excluded.schedule_start_date,
  schedule_end_date = excluded.schedule_end_date, signalling_id = excluded.signalling_id,
  cif_train_category = excluded.cif_train_category, cif_headcode = excluded.cif_headcode,
  cif_train_service_code = excluded.cif_train_service_code,
  cif_business_sector = excluded.cif_business_sector, cif_power_type = excluded.cif_power_type,
  cif_timing_load = excluded.cif_timing_load, cif_speed = excluded.cif_speed,
  cif_operating_characteristics = excluded.cif_operating_characteristics,
  cif_train_class = excluded.cif_train_class, cif_sleepers = excluded.cif_sleepers,
  cif_reservations = excluded.cif_reservations,
  cif_connection_indicator = excluded.cif_connection_indicator,
  cif_catering_code = excluded.cif_catering_code,
  cif_service_branding = excluded.cif_service_branding, train_status = excluded.train_status,
  deduced_headcode = excluded.deduced_headcode,
  deduced_headcode_status = excluded.deduced_headcode_status,
  synced_at = now()`;

const CIF_SCHEDULE_SELECT_COLS = `id, update_id, created, deleted, CIF_bank_holiday_running,
        CIF_stp_indicator, CIF_train_uid, applicable_timetable, atoc_code, uic_code,
        runs_mo, runs_tu, runs_we, runs_th, runs_fr, runs_sa, runs_su,
        schedule_start_date, schedule_end_date, signalling_id, CIF_train_category, CIF_headcode,
        CIF_train_service_code, CIF_business_sector, CIF_power_type, CIF_timing_load, CIF_speed,
        CIF_operating_characteristics, CIF_train_class, CIF_sleepers, CIF_reservations,
        CIF_connection_indicator, CIF_catering_code, CIF_service_branding,
        train_status, deduced_headcode, deduced_headcode_status`;

/** Mirrors garner `cif_schedules`. Two watermarks: `garner-cif_schedules` tracks `created` (new
 * and amended schedules), `garner-cif_schedules-deleted` tracks `deleted` for withdrawals —
 * garner stamps `deleted` in place with the real withdrawal epoch (a *live* row's `deleted` is
 * the `GARNER_NOT_DELETED` sentinel, which must not drive the watermark or it jumps to the year
 * 2106 and freezes the sync). Returns every `id` touched so its locations can be re-synced. */
async function syncCifSchedules(
  garner: MysqlPool,
  pg: PgPool,
  deletedWatermarkFloorEpoch: number,
): Promise<{ upserted: number; touchedIds: number[] }> {
  // The insert watermark is garner's auto-increment `id`, NOT `created`: a full CIF reload stamps
  // every one of ~300k rows with the same `created`, so a `created > wm` cursor skips the rest of
  // that cluster the instant one 20k-row batch touches the value and freezes the sync. `id` is
  // strictly monotonic and unique. Every in-place `UPDATE cif_schedules` in openrail cifdb
  // (`BX`/deduced-headcode) runs back-to-back with the row's own INSERT before it settles, so an
  // id cursor never misses a field change — only withdrawals (`SET deleted=...`) land later, and
  // the `-deleted` watermark below catches those. Checkpoint name has an `-id` suffix so it
  // starts fresh (the old `garner-cif_schedules` epoch checkpoint is left orphaned).
  const insDefId = await watermarkDefId(pg, "garner-cif_schedules-id");
  const delDefId = await watermarkDefId(pg, "garner-cif_schedules-deleted");
  await seedWatermarkIfFresh(pg, delDefId, deletedWatermarkFloorEpoch);
  const sinceId = await readWatermark(pg, insDefId);
  const sinceDeleted = await readWatermark(pg, delDefId);

  const [newRows] = await garner.query<CifScheduleRow[]>(
    `select ${CIF_SCHEDULE_SELECT_COLS} from cif_schedules
     where id > ? order by id asc limit 20000`,
    [sinceId],
  );
  const [deletedRows] = await garner.query<CifScheduleRow[]>(
    `select ${CIF_SCHEDULE_SELECT_COLS} from cif_schedules
     where deleted > ? and deleted < ${GARNER_NOT_DELETED} order by deleted asc limit 20000`,
    [sinceDeleted],
  );
  const rows = [...newRows, ...deletedRows];
  if (rows.length === 0) return { upserted: 0, touchedIds: [] };

  const tuples = rows.map((row) => [
    row.id,
    row.update_id,
    epochToTs(row.created),
    garnerDeletedToTs(row.deleted),
    nonEmpty(row.CIF_bank_holiday_running),
    row.CIF_stp_indicator ?? "",
    row.CIF_train_uid ?? "",
    nonEmpty(row.applicable_timetable),
    nonEmpty(row.atoc_code),
    nonEmpty(row.uic_code),
    bool(row.runs_mo),
    bool(row.runs_tu),
    bool(row.runs_we),
    bool(row.runs_th),
    bool(row.runs_fr),
    bool(row.runs_sa),
    bool(row.runs_su),
    epochToDateString(row.schedule_start_date),
    epochToDateString(row.schedule_end_date),
    nonEmpty(row.signalling_id),
    nonEmpty(row.CIF_train_category),
    nonEmpty(row.CIF_headcode),
    nonEmpty(row.CIF_train_service_code),
    nonEmpty(row.CIF_business_sector),
    nonEmpty(row.CIF_power_type),
    nonEmpty(row.CIF_timing_load),
    nonEmpty(row.CIF_speed),
    nonEmpty(row.CIF_operating_characteristics),
    nonEmpty(row.CIF_train_class),
    nonEmpty(row.CIF_sleepers),
    nonEmpty(row.CIF_reservations),
    nonEmpty(row.CIF_connection_indicator),
    nonEmpty(row.CIF_catering_code),
    nonEmpty(row.CIF_service_branding),
    nonEmpty(row.train_status),
    row.deduced_headcode ?? "",
    row.deduced_headcode_status ?? "",
  ]);

  const upserted = await chunkedInsert(
    pg,
    "cif_schedules",
    CIF_SCHEDULE_COLS,
    tuples,
    CIF_SCHEDULE_CONFLICT,
  );

  if (newRows.length > 0) {
    const hi = newRows.reduce((max, row) => Math.max(max, row.id), sinceId);
    await advanceCheckpoint(pg, insDefId, String(hi));
  }
  if (deletedRows.length > 0) {
    const hi = deletedRows.reduce((max, row) => Math.max(max, row.deleted), sinceDeleted);
    await advanceCheckpoint(pg, delDefId, String(hi));
  }

  return { upserted, touchedIds: rows.map((row) => row.id) };
}

/** garner has no ordering column on `cif_schedule_locations`; `sort_time` is its within-day
 * ordering key. For each schedule touched this cycle, delete the RLM copy and re-insert in
 * `sort_time` order so `seq_no` is a stable calling-order index. */
async function syncCifScheduleLocations(
  garner: MysqlPool,
  pg: PgPool,
  scheduleIds: number[],
): Promise<number> {
  if (scheduleIds.length === 0) return 0;

  const [rows] = await garner.query<CifScheduleLocationRow[]>(
    `select cif_schedule_id, update_id, location_type, record_identity, tiploc_code,
            tiploc_instance, arrival, departure, \`pass\`, public_arrival, public_departure,
            sort_time, next_day, platform, line, path, engineering_allowance, pathing_allowance,
            performance_allowance
     from cif_schedule_locations
     where cif_schedule_id in (?)
     order by cif_schedule_id asc, sort_time asc`,
    [scheduleIds],
  );

  await pg.query(`delete from cif_schedule_locations where cif_schedule_id = any($1::bigint[])`, [
    scheduleIds,
  ]);
  if (rows.length === 0) return 0;

  const seqByScheduleId = new Map<number, number>();
  const tuples = rows.map((row) => {
    const seq = (seqByScheduleId.get(row.cif_schedule_id) ?? 0) + 1;
    seqByScheduleId.set(row.cif_schedule_id, seq);
    return [
      row.cif_schedule_id,
      seq,
      row.update_id,
      nonEmpty(row.location_type),
      row.record_identity ?? "",
      row.tiploc_code ?? "",
      nonEmpty(row.tiploc_instance),
      nonEmpty(row.arrival),
      nonEmpty(row.departure),
      nonEmpty(row.pass),
      nonEmpty(row.public_arrival),
      nonEmpty(row.public_departure),
      row.sort_time ?? null,
      bool(row.next_day),
      nonEmpty(row.platform),
      nonEmpty(row.line),
      nonEmpty(row.path),
      nonEmpty(row.engineering_allowance),
      nonEmpty(row.pathing_allowance),
      nonEmpty(row.performance_allowance),
    ];
  });

  return chunkedInsert(
    pg,
    "cif_schedule_locations",
    [
      "cif_schedule_id",
      "seq_no",
      "update_id",
      "location_type",
      "record_identity",
      "tiploc_code",
      "tiploc_instance",
      "arrival",
      "departure",
      "pass",
      "public_arrival",
      "public_departure",
      "sort_time",
      "next_day",
      "platform",
      "line",
      "path",
      "engineering_allowance",
      "pathing_allowance",
      "performance_allowance",
    ],
    tuples,
    "on conflict (cif_schedule_id, seq_no) do nothing",
  );
}

// ---------------------------------------------------------------------------
// TRUST tables
// ---------------------------------------------------------------------------

interface CreatedKeyedRow extends RowDataPacket {
  created: number;
}

/** Shared shape: pull garner rows with `created` past the watermark, map, chunked-insert with
 * `on conflict do nothing`, advance the watermark to the max `created` seen. A fresh watermark is
 * seeded to `floorEpoch` first, so the initial pass starts near "now" rather than grinding from
 * the Unix epoch through data garner has already archived. */
async function syncTrustTable<R extends CreatedKeyedRow>(
  pg: PgPool,
  garner: MysqlPool,
  floorEpoch: number,
  opts: {
    watermarkName: string;
    selectSql: string;
    table: string;
    cols: string[];
    conflictTail: string;
    map: (row: R) => unknown[];
  },
): Promise<number> {
  const defId = await watermarkDefId(pg, opts.watermarkName);
  await seedWatermarkIfFresh(pg, defId, floorEpoch);
  const since = await readWatermark(pg, defId);

  const [rows] = await garner.query<R[]>(opts.selectSql, [since]);
  if (rows.length === 0) return 0;

  const written = await chunkedInsert(
    pg,
    opts.table,
    opts.cols,
    rows.map(opts.map),
    opts.conflictTail,
  );
  const highWater = rows.reduce((max, row) => Math.max(max, row.created), since);
  await advanceCheckpoint(pg, defId, String(highWater));
  return written;
}

interface TrustActivationRow extends CreatedKeyedRow {
  trust_id: string;
  cif_schedule_id: number;
  deduced: number;
}
interface TrustActivationExtraRow extends CreatedKeyedRow {
  trust_id: string;
  schedule_source: string;
  train_file_address: string;
  schedule_end_date: number;
  tp_origin_timestamp: number;
  creation_timestamp: number;
  tp_origin_stanox: string;
  origin_dep_timestamp: number;
  train_service_code: string;
  toc_id: string;
  d1266_record_number: string;
  train_call_type: string;
  train_uid: string;
  train_call_mode: string;
  schedule_type: string;
  sched_origin_stanox: string;
  schedule_wtt_id: string;
  schedule_start_date: number;
}
interface TrustMovementRow extends CreatedKeyedRow {
  trust_id: string;
  platform: string;
  loc_stanox: string;
  actual_timestamp: number;
  gbtt_timestamp: number;
  planned_timestamp: number;
  timetable_variation: number;
  next_report_stanox: string;
  next_report_run_time: number;
  flags: number;
}
interface TrustCancellationRow extends CreatedKeyedRow {
  trust_id: string;
  reason: string;
  type: string;
  loc_stanox: string;
  reinstate: number;
}
interface TrustChangeOriginRow extends CreatedKeyedRow {
  trust_id: string;
  reason: string;
  loc_stanox: string;
}
interface TrustChangeIdRow extends CreatedKeyedRow {
  trust_id: string;
  new_trust_id: string;
}
interface TrustChangeLocationRow extends CreatedKeyedRow {
  trust_id: string;
  original_stanox: string;
  stanox: string;
}

async function syncTrustAll(
  garner: MysqlPool,
  pg: PgPool,
  floorEpoch: number,
): Promise<Record<string, number>> {
  const activation = await syncTrustTable<TrustActivationRow>(pg, garner, floorEpoch, {
    watermarkName: "garner-trust_activation",
    selectSql: `select created, trust_id, cif_schedule_id, deduced from trust_activation
                where created >= ? order by created asc limit 50000`,
    table: "trust_activation",
    cols: ["trust_id", "created", "cif_schedule_id", "deduced"],
    conflictTail: "on conflict (trust_id, created) do nothing",
    map: (row) => [
      row.trust_id,
      epochToTs(row.created),
      row.cif_schedule_id && row.cif_schedule_id > 0 ? row.cif_schedule_id : null,
      row.deduced ?? 0,
    ],
  });

  const activationExtra = await syncTrustTable<TrustActivationExtraRow>(pg, garner, floorEpoch, {
    watermarkName: "garner-trust_activation_extra",
    selectSql: `select created, trust_id, schedule_source, train_file_address, schedule_end_date,
                       tp_origin_timestamp, creation_timestamp, tp_origin_stanox,
                       origin_dep_timestamp, train_service_code, toc_id, d1266_record_number,
                       train_call_type, train_uid, train_call_mode, schedule_type,
                       sched_origin_stanox, schedule_wtt_id, schedule_start_date
                from trust_activation_extra where created >= ? order by created asc limit 50000`,
    table: "trust_activation_extra",
    cols: [
      "trust_id",
      "created",
      "schedule_source",
      "train_file_address",
      "schedule_end_date",
      "tp_origin_timestamp",
      "creation_timestamp",
      "tp_origin_stanox",
      "origin_dep_timestamp",
      "train_service_code",
      "toc_id",
      "d1266_record_number",
      "train_call_type",
      "train_uid",
      "train_call_mode",
      "schedule_type",
      "sched_origin_stanox",
      "schedule_wtt_id",
      "schedule_start_date",
    ],
    conflictTail: "on conflict (trust_id, created) do nothing",
    map: (row) => [
      row.trust_id,
      epochToTs(row.created),
      nonEmpty(row.schedule_source),
      nonEmpty(row.train_file_address),
      epochToDateString(row.schedule_end_date),
      epochToTs(row.tp_origin_timestamp),
      epochToTs(row.creation_timestamp),
      nonEmpty(row.tp_origin_stanox),
      epochToTs(row.origin_dep_timestamp),
      nonEmpty(row.train_service_code),
      nonEmpty(row.toc_id),
      nonEmpty(row.d1266_record_number),
      nonEmpty(row.train_call_type),
      nonEmpty(row.train_uid),
      nonEmpty(row.train_call_mode),
      nonEmpty(row.schedule_type),
      nonEmpty(row.sched_origin_stanox),
      nonEmpty(row.schedule_wtt_id),
      epochToDateString(row.schedule_start_date),
    ],
  });

  const movement = await syncTrustTable<TrustMovementRow>(pg, garner, floorEpoch, {
    watermarkName: "garner-trust_movement",
    selectSql: `select created, trust_id, platform, loc_stanox, actual_timestamp, gbtt_timestamp,
                       planned_timestamp, timetable_variation, next_report_stanox,
                       next_report_run_time, flags
                from trust_movement where created >= ? order by created asc limit 100000`,
    table: "trust_movement",
    cols: [
      "trust_id",
      "created",
      "platform",
      "loc_stanox",
      "actual_timestamp",
      "gbtt_timestamp",
      "planned_timestamp",
      "timetable_variation",
      "next_report_stanox",
      "next_report_run_time",
      "flags",
    ],
    conflictTail: "on conflict (trust_id, created, loc_stanox, actual_timestamp) do nothing",
    map: (row) => [
      row.trust_id,
      epochToTs(row.created),
      nonEmpty(row.platform),
      nonEmpty(row.loc_stanox),
      epochToTs(row.actual_timestamp),
      epochToTs(row.gbtt_timestamp),
      epochToTs(row.planned_timestamp),
      row.timetable_variation ?? null,
      nonEmpty(row.next_report_stanox),
      row.next_report_run_time ?? null,
      row.flags ?? null,
    ],
  });

  const cancellation = await syncTrustTable<TrustCancellationRow>(pg, garner, floorEpoch, {
    watermarkName: "garner-trust_cancellation",
    selectSql: `select created, trust_id, reason, type, loc_stanox, reinstate
                from trust_cancellation where created >= ? order by created asc limit 50000`,
    table: "trust_cancellation",
    cols: ["trust_id", "created", "reason", "type", "loc_stanox", "reinstate"],
    conflictTail: "on conflict (trust_id, created) do nothing",
    map: (row) => [
      row.trust_id,
      epochToTs(row.created),
      nonEmpty(row.reason),
      nonEmpty(row.type),
      nonEmpty(row.loc_stanox),
      row.reinstate ?? 0,
    ],
  });

  const changeOrigin = await syncTrustTable<TrustChangeOriginRow>(pg, garner, floorEpoch, {
    watermarkName: "garner-trust_changeorigin",
    selectSql: `select created, trust_id, reason, loc_stanox
                from trust_changeorigin where created >= ? order by created asc limit 50000`,
    table: "trust_changeorigin",
    cols: ["trust_id", "created", "reason", "loc_stanox"],
    conflictTail: "on conflict (trust_id, created) do nothing",
    map: (row) => [
      row.trust_id,
      epochToTs(row.created),
      nonEmpty(row.reason),
      nonEmpty(row.loc_stanox),
    ],
  });

  const changeId = await syncTrustTable<TrustChangeIdRow>(pg, garner, floorEpoch, {
    watermarkName: "garner-trust_changeid",
    selectSql: `select created, trust_id, new_trust_id
                from trust_changeid where created >= ? order by created asc limit 50000`,
    table: "trust_changeid",
    cols: ["trust_id", "created", "new_trust_id"],
    conflictTail: "on conflict (trust_id, created) do nothing",
    map: (row) => [row.trust_id, epochToTs(row.created), row.new_trust_id ?? ""],
  });

  const changeLocation = await syncTrustTable<TrustChangeLocationRow>(pg, garner, floorEpoch, {
    watermarkName: "garner-trust_changelocation",
    selectSql: `select created, trust_id, original_stanox, stanox
                from trust_changelocation where created >= ? order by created asc limit 50000`,
    table: "trust_changelocation",
    cols: ["trust_id", "created", "original_stanox", "stanox"],
    conflictTail: "on conflict (trust_id, created) do nothing",
    map: (row) => [
      row.trust_id,
      epochToTs(row.created),
      nonEmpty(row.original_stanox),
      nonEmpty(row.stanox),
    ],
  });

  return {
    activation,
    activationExtra,
    movement,
    cancellation,
    changeOrigin,
    changeId,
    changeLocation,
  };
}

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

export interface GarnerReferenceSyncSummary {
  corpusUpserted: number;
  smartUpserted: number;
}

export async function runGarnerReferenceSync(
  garner: MysqlPool,
  pg: PgPool,
): Promise<GarnerReferenceSyncSummary> {
  const corpusUpserted = await syncCorpus(garner, pg);
  const smartUpserted = await syncSmart(garner, pg);
  return { corpusUpserted, smartUpserted };
}

export interface GarnerScheduleSyncSummary {
  schedulesUpserted: number;
  scheduleLocationsUpserted: number;
}

function floorEpoch(backfillDays: number): number {
  return Math.floor(Date.now() / 1000) - Math.max(0, backfillDays) * 86400;
}

export async function runGarnerScheduleSync(
  garner: MysqlPool,
  pg: PgPool,
  backfillDays: number,
): Promise<GarnerScheduleSyncSummary> {
  // The `id` watermark is *not* seeded forward — every currently-valid schedule must be mirrored
  // regardless of how long ago it entered the CIF extract. Only the `deleted` watermark
  // (withdrawal history nobody queries) gets the backfill floor.
  const { upserted, touchedIds } = await syncCifSchedules(garner, pg, floorEpoch(backfillDays));
  const scheduleLocationsUpserted = await syncCifScheduleLocations(garner, pg, touchedIds);
  return { schedulesUpserted: upserted, scheduleLocationsUpserted };
}

export async function runGarnerTrustSync(
  garner: MysqlPool,
  pg: PgPool,
  backfillDays: number,
): Promise<Record<string, number>> {
  return syncTrustAll(garner, pg, floorEpoch(backfillDays));
}
