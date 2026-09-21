import type { Pool as PgPool, PoolClient } from "pg";
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

/** Per-tick row caps. Kept small so a single batch is a light unit of work — the initial
 * backfill grinds through in more, cheaper steps rather than a few disk-saturating ones that
 * starve the live projector (production incident, 2026-09-01). `ingest-garner` also skips the
 * whole schedule/reference sync entirely while `projector-td` is lagging — see
 * `apps/worker/src/commands/ingestGarner.ts`. */
const SCHEDULE_BATCH = 2000;
const TRUST_BATCH = 5000;

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

/** A pool or a checked-out client (for work that must share one transaction). */
type PgQueryable = PgPool | PoolClient;

/** Insert `rows` into `table` (columns `cols`) in chunks, with an `on conflict` tail. Each row is
 * a positional value array matching `cols`. */
async function chunkedInsert(
  pg: PgQueryable,
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

/**
 * Collapse rows sharing an RLM conflict key to one (the last), so a single `on conflict do update`
 * statement never meets the same key twice — Postgres rejects that outright ("cannot affect row
 * a second time"), which failed every garner reference sync: CORPUS stopped updating on
 * 2026-09-08 and SMART had never synced from garner at all (found 2026-09-21). Last-wins matches
 * what the old multi-statement file import already did. Duplicates that *disagree* (e.g. SMART
 * steps differing only in STANOX, which RLM's natural key cannot hold both of) are logged, never
 * silently dropped. Exported for tests.
 */
export function dedupeByKey<T>(label: string, rows: T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  let conflicting = 0;
  for (const row of rows) {
    const k = key(row);
    const prior = byKey.get(k);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(row)) conflicting += 1;
    byKey.set(k, row);
  }
  if (conflicting > 0) {
    console.warn(
      `garner ${label}: ${conflicting} source rows collide on RLM's key with different values; kept the last of each`,
    );
  }
  return [...byKey.values()];
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

  const tuples = dedupeByKey("corpus", rows, (row) => row.tiploc.trim()).map((row) => [
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

  // Same normalisation as the `smart_berth_step_natural_key_idx` expression index.
  const tuples = dedupeByKey("smart", rows, (row) =>
    [
      row.td.trim(),
      nonEmpty(row.fromberth) ?? "",
      nonEmpty(row.toberth) ?? "",
      nonEmpty(row.event) ?? "",
    ].join("|"),
  ).map((row) => [
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
     where id > ? order by id asc limit ${SCHEDULE_BATCH}`,
    [sinceId],
  );
  const [deletedRows] = await garner.query<CifScheduleRow[]>(
    `select ${CIF_SCHEDULE_SELECT_COLS} from cif_schedules
     where deleted > ? and deleted < ${GARNER_NOT_DELETED} order by deleted asc limit ${SCHEDULE_BATCH}`,
    [sinceDeleted],
  );
  // A schedule created *and* withdrawn since the two watermarks appears in both result sets —
  // passing it twice to one `insert ... on conflict do update` is a hard Postgres error ("cannot
  // affect row a second time", production 2026-09-21), which failed the tick and re-failed it
  // every cycle until one watermark happened to move past the row.
  const rows = dedupeScheduleRowsById([...newRows, ...deletedRows]);
  if (rows.length === 0) return { upserted: 0, touchedIds: [] };

  const upserted = await upsertScheduleRows(pg, rows);

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

/** Collapse garner schedule rows to one per `id`, keeping the last occurrence. Both copies come
 * from the same garner table moments apart, so the later one is at least as current. Exported
 * for tests. */
export function dedupeScheduleRowsById<T extends { id: number }>(rows: T[]): T[] {
  const byId = new Map<number, T>();
  for (const row of rows) byId.set(row.id, row);
  return [...byId.values()];
}

async function upsertScheduleRows(pg: PgQueryable, rows: CifScheduleRow[]): Promise<number> {
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

  return chunkedInsert(pg, "cif_schedules", CIF_SCHEDULE_COLS, tuples, CIF_SCHEDULE_CONFLICT);
}

/** Pure ordering step for `syncCifScheduleLocations` below (kept separate and exported so the
 * overnight-crossing bug it fixes is fixture-testable, per this project's "keep feed parsers
 * pure and fixture-driven" rule — the DB-touching function around it isn't).
 *
 * garner has no ordering column on `cif_schedule_locations`; `sort_time` is only a *within-day*
 * ordering key — it resets to a small value just after midnight, so a schedule that runs past
 * midnight needs `next_day` rows ordered after every same-day row, or the post-midnight calling
 * points (low `sort_time`) sort before the pre-midnight ones (high `sort_time`) and `seq_no`
 * comes out with the tail of the journey first (reproduced 2026-09-14 against a real overnight
 * Glasgow-Euston working, headcode 9M63/UID W33240: Northampton/Courteenhall/Euston, all
 * `next_day`, were sequencing ahead of Glasgow/Motherwell/Carlisle). Sorted in JS rather than
 * trusted to the SQL `ORDER BY` so this ordering is independent of driver/collation behaviour and
 * can be verified directly against fixture rows. */
export function sequenceScheduleLocations<
  T extends { cif_schedule_id: number; sort_time: number; next_day: number },
>(rows: T[]): (T & { seqNo: number })[] {
  const sorted = [...rows].sort((a, b) => {
    if (a.cif_schedule_id !== b.cif_schedule_id) return a.cif_schedule_id - b.cif_schedule_id;
    const aNextDay = bool(a.next_day) ? 1 : 0;
    const bNextDay = bool(b.next_day) ? 1 : 0;
    if (aNextDay !== bNextDay) return aNextDay - bNextDay;
    return (a.sort_time ?? 0) - (b.sort_time ?? 0);
  });
  const seqByScheduleId = new Map<number, number>();
  return sorted.map((row) => {
    const seq = (seqByScheduleId.get(row.cif_schedule_id) ?? 0) + 1;
    seqByScheduleId.set(row.cif_schedule_id, seq);
    return { ...row, seqNo: seq };
  });
}

/** For each schedule touched this cycle, delete the RLM copy of its `cif_schedule_locations` and
 * re-insert in `sequenceScheduleLocations` order so `seq_no` is a stable calling-order index. */
async function syncCifScheduleLocations(
  garner: MysqlPool,
  pg: PgPool,
  scheduleIds: number[],
): Promise<number> {
  if (scheduleIds.length === 0) return 0;

  const [rawRows] = await garner.query<CifScheduleLocationRow[]>(
    `select cif_schedule_id, update_id, location_type, record_identity, tiploc_code,
            tiploc_instance, arrival, departure, \`pass\`, public_arrival, public_departure,
            sort_time, next_day, platform, line, path, engineering_allowance, pathing_allowance,
            performance_allowance
     from cif_schedule_locations
     where cif_schedule_id in (?)`,
    [scheduleIds],
  );

  const rows = sequenceScheduleLocations(rawRows);
  const tuples = rows.map((row) => {
    return [
      row.cif_schedule_id,
      row.seqNo,
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

  // Delete + re-insert in one transaction: a failure between the two must not leave a schedule
  // with no calling points (it would then be invisible to every position-scoped resolution).
  const client = await pg.connect();
  try {
    await client.query("begin");
    await client.query(
      `delete from cif_schedule_locations where cif_schedule_id = any($1::bigint[])`,
      [scheduleIds],
    );
    const written = await insertScheduleLocationTuples(client, tuples);
    await client.query("commit");
    return written;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function insertScheduleLocationTuples(pg: PgQueryable, tuples: unknown[][]): Promise<number> {
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
// CIF schedule reconciliation (2026-09-21 incident)
// ---------------------------------------------------------------------------

/** How many garner `cif_schedules.id` values one reconcile window covers. */
export const RECONCILE_WINDOW_IDS = 20_000;
/** The daemon re-checks this many of the *newest* ids every reconcile cycle — wide enough to
 * cover a whole CIF load (~35k rows) committing late behind rows the id cursor already passed. */
const RECONCILE_TAIL_IDS = 60_000;
/** Max schedules re-fetched / location-resynced per statement batch. */
const RECONCILE_FETCH_BATCH = 2000;

export interface ScheduleFingerprint {
  id: number;
  updateId: number;
  /** Withdrawal epoch-seconds, or `null` for a live schedule — already normalised through
   * `garnerDeletedToTs` on the garner side so both sides compare like-for-like. */
  deletedEpoch: number | null;
}

export interface ScheduleWindowDiff {
  /** Missing from RLM, or present with a different `update_id`/`deleted` — re-fetch the header
   * *and* its locations. */
  scheduleIds: number[];
  /** Header matches but the calling-point count differs — re-sync locations only. */
  locationOnlyIds: number[];
}

/**
 * Pure comparison of one id window of garner vs RLM. Why this exists at all (production,
 * 2026-09-21): the incremental sync's `id > watermark` cursor is only safe if ids become visible
 * in order, and garner's CIF load is one long transaction — rows stamped `created` 05:30:02 on
 * 2026-09-05 (32,913 of them) and 2026-09-18 (1,266) committed *after* later, higher-id rows the
 * bridge had already read, so the cursor jumped the whole block and never looked back. The same
 * race one level down left 2,797 schedules with zero calling points (header read before its
 * locations committed). No cursor design closes every such race against a source we don't
 * control, so the mirror is periodically diffed against garner and repaired instead.
 *
 * RLM rows garner no longer has are *not* reported — the mirror never deletes history.
 */
export function diffScheduleWindow(
  garnerRows: ScheduleFingerprint[],
  rlmRows: ScheduleFingerprint[],
  garnerLocationCounts: Map<number, number>,
  rlmLocationCounts: Map<number, number>,
): ScheduleWindowDiff {
  const rlmById = new Map(rlmRows.map((row) => [row.id, row]));
  const scheduleIds: number[] = [];
  const locationOnlyIds: number[] = [];
  for (const g of garnerRows) {
    const r = rlmById.get(g.id);
    if (!r || r.updateId !== g.updateId || r.deletedEpoch !== g.deletedEpoch) {
      scheduleIds.push(g.id);
    } else if ((garnerLocationCounts.get(g.id) ?? 0) !== (rlmLocationCounts.get(g.id) ?? 0)) {
      locationOnlyIds.push(g.id);
    }
  }
  return { scheduleIds, locationOnlyIds };
}

export interface ScheduleReconcileSummary {
  fromId: number;
  toId: number;
  schedulesRepaired: number;
  locationSetsRepaired: number;
}

/** Reconcile garner `cif_schedules` ids in `[fromId, toId)` into RLM: diff, then re-fetch and
 * upsert every missing/changed header and re-sync every mismatched location set. Idempotent. */
export async function reconcileCifScheduleWindow(
  garner: MysqlPool,
  pg: PgPool,
  fromId: number,
  toId: number,
): Promise<ScheduleReconcileSummary> {
  const [garnerHeaders] = await garner.query<RowDataPacket[]>(
    `select id, update_id, deleted from cif_schedules where id >= ? and id < ?`,
    [fromId, toId],
  );
  const [garnerLocs] = await garner.query<RowDataPacket[]>(
    `select cif_schedule_id, count(*) as n from cif_schedule_locations
     where cif_schedule_id >= ? and cif_schedule_id < ? group by cif_schedule_id`,
    [fromId, toId],
  );
  const rlmHeaders = await pg.query<{
    id: string;
    update_id: number;
    deleted_epoch: string | null;
  }>(
    `select id, update_id, extract(epoch from deleted)::bigint as deleted_epoch
     from cif_schedules where id >= $1 and id < $2`,
    [fromId, toId],
  );
  const rlmLocs = await pg.query<{ cif_schedule_id: string; n: number }>(
    `select cif_schedule_id, count(*)::int as n from cif_schedule_locations
     where cif_schedule_id >= $1 and cif_schedule_id < $2 group by cif_schedule_id`,
    [fromId, toId],
  );

  const diff = diffScheduleWindow(
    garnerHeaders.map((row) => ({
      id: Number(row.id),
      updateId: Number(row.update_id),
      deletedEpoch: garnerDeletedToTs(Number(row.deleted)) ? Number(row.deleted) : null,
    })),
    rlmHeaders.rows.map((row) => ({
      id: Number(row.id),
      updateId: Number(row.update_id),
      deletedEpoch: row.deleted_epoch === null ? null : Number(row.deleted_epoch),
    })),
    new Map(garnerLocs.map((row) => [Number(row.cif_schedule_id), Number(row.n)])),
    new Map(rlmLocs.rows.map((row) => [Number(row.cif_schedule_id), row.n])),
  );

  for (let i = 0; i < diff.scheduleIds.length; i += RECONCILE_FETCH_BATCH) {
    const ids = diff.scheduleIds.slice(i, i + RECONCILE_FETCH_BATCH);
    const [rows] = await garner.query<CifScheduleRow[]>(
      `select ${CIF_SCHEDULE_SELECT_COLS} from cif_schedules where id in (?)`,
      [ids],
    );
    await upsertScheduleRows(pg, dedupeScheduleRowsById(rows));
    await syncCifScheduleLocations(garner, pg, ids);
  }
  for (let i = 0; i < diff.locationOnlyIds.length; i += RECONCILE_FETCH_BATCH) {
    await syncCifScheduleLocations(
      garner,
      pg,
      diff.locationOnlyIds.slice(i, i + RECONCILE_FETCH_BATCH),
    );
  }

  return {
    fromId,
    toId,
    schedulesRepaired: diff.scheduleIds.length,
    locationSetsRepaired: diff.locationOnlyIds.length,
  };
}

async function garnerMaxScheduleId(garner: MysqlPool): Promise<number> {
  const [rows] = await garner.query<RowDataPacket[]>(`select max(id) as max_id from cif_schedules`);
  return Number(rows[0]?.max_id ?? 0);
}

/**
 * Continuous self-healing, run by `ingest-garner` on its reference cadence: always the newest
 * `RECONCILE_TAIL_IDS` ids (where late-committing loads land, so a repeat of the 2026-09-05/18
 * gap heals within one cycle), plus one rolling window that walks the whole id space and wraps —
 * so any older divergence, whatever its cause, is found within a full lap
 * (~45 windows at today's table size).
 */
export async function runGarnerScheduleReconcile(
  garner: MysqlPool,
  pg: PgPool,
): Promise<{ schedulesRepaired: number; locationSetsRepaired: number }> {
  const maxId = await garnerMaxScheduleId(garner);
  if (maxId === 0) return { schedulesRepaired: 0, locationSetsRepaired: 0 };

  let schedulesRepaired = 0;
  let locationSetsRepaired = 0;
  const tailFrom = Math.max(0, maxId + 1 - RECONCILE_TAIL_IDS);
  for (let from = tailFrom; from <= maxId; from += RECONCILE_WINDOW_IDS) {
    const r = await reconcileCifScheduleWindow(garner, pg, from, from + RECONCILE_WINDOW_IDS);
    schedulesRepaired += r.schedulesRepaired;
    locationSetsRepaired += r.locationSetsRepaired;
  }

  const cursorDefId = await watermarkDefId(pg, "garner-cif_schedules-reconcile-cursor");
  const cursor = await readWatermark(pg, cursorDefId);
  const from = cursor > maxId ? 0 : cursor;
  const r = await reconcileCifScheduleWindow(garner, pg, from, from + RECONCILE_WINDOW_IDS);
  schedulesRepaired += r.schedulesRepaired;
  locationSetsRepaired += r.locationSetsRepaired;
  const next = from + RECONCILE_WINDOW_IDS > maxId ? 0 : from + RECONCILE_WINDOW_IDS;
  // `advanceCheckpoint` is monotonic (`greatest`), so a wrap back to 0 is written directly.
  await pg.query(
    `update projection_checkpoint set last_ingestion_sequence = $2, last_completed_at = now(),
       updated_at = now() where projection_definition_id = $1`,
    [cursorDefId, String(next)],
  );

  return { schedulesRepaired, locationSetsRepaired };
}

/** One full pass over every garner schedule id — the historical backfill for the 2026-09-21
 * incident, and the tool to reach for if the mirror is ever suspected incomplete again. */
export async function runGarnerScheduleFullReconcile(
  garner: MysqlPool,
  pg: PgPool,
  onWindow: (summary: ScheduleReconcileSummary) => void,
): Promise<{ schedulesRepaired: number; locationSetsRepaired: number }> {
  const maxId = await garnerMaxScheduleId(garner);
  let schedulesRepaired = 0;
  let locationSetsRepaired = 0;
  for (let from = 0; from <= maxId; from += RECONCILE_WINDOW_IDS) {
    const r = await reconcileCifScheduleWindow(garner, pg, from, from + RECONCILE_WINDOW_IDS);
    schedulesRepaired += r.schedulesRepaired;
    locationSetsRepaired += r.locationSetsRepaired;
    onWindow(r);
  }
  return { schedulesRepaired, locationSetsRepaired };
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
                where created >= ? order by created asc limit ${TRUST_BATCH}`,
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
                from trust_activation_extra where created >= ? order by created asc limit ${TRUST_BATCH}`,
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
                from trust_movement where created >= ? order by created asc limit ${TRUST_BATCH}`,
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
                from trust_cancellation where created >= ? order by created asc limit ${TRUST_BATCH}`,
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
                from trust_changeorigin where created >= ? order by created asc limit ${TRUST_BATCH}`,
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
                from trust_changeid where created >= ? order by created asc limit ${TRUST_BATCH}`,
    table: "trust_changeid",
    cols: ["trust_id", "created", "new_trust_id"],
    conflictTail: "on conflict (trust_id, created) do nothing",
    map: (row) => [row.trust_id, epochToTs(row.created), row.new_trust_id ?? ""],
  });

  const changeLocation = await syncTrustTable<TrustChangeLocationRow>(pg, garner, floorEpoch, {
    watermarkName: "garner-trust_changelocation",
    selectSql: `select created, trust_id, original_stanox, stanox
                from trust_changelocation where created >= ? order by created asc limit ${TRUST_BATCH}`,
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
// train_allocation (owner request 2026-09-13, alongside Milestone 35's popup role-gating)
// ---------------------------------------------------------------------------

/** Unlike the tables above, garner stores this table's timestamps as real DATE/DATETIME columns
 * (mysql2 already returns JS `Date`s for them) rather than epoch INTs — no `epochToTs` needed. */
interface TrainAllocationRow extends RowDataPacket {
  id: number;
  cif_train_uid: string;
  headcode: string;
  schedule_start_date: Date;
  origin_tiploc: string;
  origin_dep: Date | null;
  dest_tiploc: string;
  dest_arr: Date | null;
  unit_no: string;
  position: number;
  fleet_id: string;
  vehicles: string;
  reported: Date | null;
  message_id: string;
}

const TRAIN_ALLOCATION_COLS = [
  "id",
  "cif_train_uid",
  "headcode",
  "schedule_start_date",
  "origin_tiploc",
  "origin_dep",
  "dest_tiploc",
  "dest_arr",
  "unit_no",
  "position",
  "fleet_id",
  "vehicles",
  "reported",
  "message_id",
];

const TRAIN_ALLOCATION_CONFLICT = `on conflict (id) do update set
  cif_train_uid = excluded.cif_train_uid, headcode = excluded.headcode,
  schedule_start_date = excluded.schedule_start_date, origin_tiploc = excluded.origin_tiploc,
  origin_dep = excluded.origin_dep, dest_tiploc = excluded.dest_tiploc,
  dest_arr = excluded.dest_arr, unit_no = excluded.unit_no, "position" = excluded."position",
  fleet_id = excluded.fleet_id, vehicles = excluded.vehicles, reported = excluded.reported,
  message_id = excluded.message_id, synced_at = now()`;

/** Mirrors garner `train_allocation`, watermarked by its own auto-increment `id` — like
 * `cif_schedules`, simpler and just as sufficient as a `created`/`reported` watermark would be,
 * with no clustering risk to guard against. */
async function syncTrainAllocation(
  garner: MysqlPool,
  pg: PgPool,
  floorId: number,
): Promise<number> {
  const defId = await watermarkDefId(pg, "garner-train_allocation");
  // Seeded by row-id proxy, not epoch — a fresh watermark starts from `floorId` (an id near the
  // backfill-days cutoff, resolved by the caller) rather than 0.
  const cp = await getCheckpoint(pg, defId);
  if (cp && cp.lastIngestionSequence === "0" && cp.lastCompletedAt === null) {
    await advanceCheckpoint(pg, defId, String(Math.max(0, floorId)));
  }
  const since = await readWatermark(pg, defId);

  const [rows] = await garner.query<TrainAllocationRow[]>(
    `select id, cif_train_uid, headcode, schedule_start_date, origin_tiploc, origin_dep,
            dest_tiploc, dest_arr, unit_no, \`position\`, fleet_id, vehicles, reported, message_id
     from train_allocation where id > ? order by id asc limit ${TRUST_BATCH}`,
    [since],
  );
  if (rows.length === 0) return 0;

  const tuples = rows.map((row) => [
    row.id,
    row.cif_train_uid,
    row.headcode,
    row.schedule_start_date,
    row.origin_tiploc,
    row.origin_dep,
    row.dest_tiploc,
    row.dest_arr,
    row.unit_no,
    row.position ?? 0,
    row.fleet_id,
    row.vehicles,
    row.reported,
    row.message_id,
  ]);

  const written = await chunkedInsert(
    pg,
    "train_allocation",
    TRAIN_ALLOCATION_COLS,
    tuples,
    TRAIN_ALLOCATION_CONFLICT,
  );
  const hi = rows.reduce((max, row) => Math.max(max, row.id), since);
  await advanceCheckpoint(pg, defId, String(hi));
  return written;
}

export async function runGarnerTrainAllocationSync(
  garner: MysqlPool,
  pg: PgPool,
  backfillDays: number,
): Promise<number> {
  // `train_allocation`'s PK is a plain auto-increment with no epoch relationship to real time, so
  // the usual `floorEpoch` can't seed it — a near-enough id is found directly instead: the
  // smallest id whose `reported` is within the backfill window (0 when nothing qualifies, i.e.
  // mirror everything garner still has).
  const cutoff = new Date(Date.now() - Math.max(0, backfillDays) * 86_400_000);
  const [rows] = await garner.query<RowDataPacket[]>(
    `select coalesce(min(id), 0) as floor_id from train_allocation where reported >= ?`,
    [cutoff],
  );
  const floorId = Number((rows[0] as { floor_id: number } | undefined)?.floor_id ?? 0);
  return syncTrainAllocation(garner, pg, floorId);
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
