import type { Pool as PgPool } from "pg";
import type { Pool as MysqlPool, RowDataPacket } from "mysql2/promise";

/**
 * garner-bridge importers (ADR 0002 / Milestone 15 step "2 new"). Each reads a garner MariaDB
 * table and upserts into the corresponding Railway Live Maps Postgres table, tagged
 * `source = 'GARNER'`. The bridge is a *mirror*, not a queue — CORPUS and SMART are small
 * (~40-60k rows) and change at most daily, so a full re-sync is simpler and more robust than a
 * fragile per-row watermark against garner's own delete-and-reload refresh.
 *
 * Implemented here: CORPUS → location_reference, SMART → smart_berth_step. Still to do (own
 * follow-up, needs a migration to widen `schedule.source`'s CHECK to include 'GARNER' and an STP
 * mapping): cif_schedules/cif_schedule_locations → schedule/schedule_location, and
 * trust_movement/trust_activation_extra/trust_* → train_run/train_run_event via the existing
 * `packages/domain/src/trust/runReducer.ts` reducer.
 */

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

export interface GarnerSyncSummary {
  corpusUpserted: number;
  smartUpserted: number;
}

/** garner stores stanox as an INT; RLM stores it as text (as CIF/CORPUS supply it, zero-padded to
 * 5). `0` means "not supplied" in garner. */
function stanoxText(value: number): string | null {
  return value && value > 0 ? String(value).padStart(5, "0") : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value : null;
}

async function syncCorpus(garner: MysqlPool, pg: PgPool): Promise<number> {
  const [rows] = await garner.query<CorpusRow[]>(
    `select tiploc, stanox, \`3alpha\`, nlc, nlcdesc, nlcdesc16, uic
     from corpus where tiploc <> ''`,
  );
  if (rows.length === 0) return 0;

  const tiplocs: string[] = [];
  const stanoxes: (string | null)[] = [];
  const crs: (string | null)[] = [];
  const nlcs: (string | null)[] = [];
  const uics: (string | null)[] = [];
  const names: (string | null)[] = [];
  const raws: string[] = [];

  for (const row of rows) {
    tiplocs.push(row.tiploc.trim());
    stanoxes.push(stanoxText(row.stanox));
    crs.push(nonEmpty(row["3alpha"]));
    nlcs.push(nonEmpty(row.nlc));
    uics.push(nonEmpty(row.uic));
    names.push(nonEmpty(row.nlcdesc) ?? nonEmpty(row.nlcdesc16));
    raws.push(JSON.stringify(row));
  }

  const result = await pg.query(
    `insert into location_reference (tiploc, stanox, crs, nlc, uic, name, source, raw_source_json)
     select t.tiploc, t.stanox, t.crs, t.nlc, t.uic, t.name, 'GARNER', t.raw::jsonb
     from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
       as t(tiploc, stanox, crs, nlc, uic, name, raw)
     on conflict (tiploc) do update set
       stanox = excluded.stanox, crs = excluded.crs, nlc = excluded.nlc, uic = excluded.uic,
       name = excluded.name, source = 'GARNER', raw_source_json = excluded.raw_source_json,
       imported_at = now()`,
    [tiplocs, stanoxes, crs, nlcs, uics, names, raws],
  );
  return result.rowCount ?? 0;
}

async function syncSmart(garner: MysqlPool, pg: PgPool): Promise<number> {
  const [rows] = await garner.query<SmartRow[]>(
    `select td, fromberth, toberth, stanox, event, steptype, route, platform, berthoffset,
            toline, fromline, stanme, comment
     from smart where td <> ''`,
  );
  if (rows.length === 0) return 0;

  const tdAreas: string[] = [];
  const fromBerths: (string | null)[] = [];
  const toBerths: (string | null)[] = [];
  const stanoxes: (string | null)[] = [];
  const platforms: (string | null)[] = [];
  const eventTypes: (string | null)[] = [];
  const routes: (string | null)[] = [];
  const raws: string[] = [];

  for (const row of rows) {
    tdAreas.push(row.td.trim());
    fromBerths.push(nonEmpty(row.fromberth));
    toBerths.push(nonEmpty(row.toberth));
    stanoxes.push(stanoxText(row.stanox));
    platforms.push(row.platform && row.platform > 0 ? String(row.platform) : null);
    eventTypes.push(nonEmpty(row.event));
    routes.push(row.route ? String(row.route) : null);
    raws.push(JSON.stringify(row));
  }

  const result = await pg.query(
    `insert into smart_berth_step (td_area, from_berth, to_berth, stanox, platform, event_type, route_indicator, source_file_import_id, raw_source_json)
     select t.td_area, t.from_berth, t.to_berth, t.stanox, t.platform, t.event_type, t.route, null, t.raw::jsonb
     from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
       as t(td_area, from_berth, to_berth, stanox, platform, event_type, route, raw)
     on conflict (td_area, coalesce(from_berth, ''), coalesce(to_berth, ''), coalesce(event_type, ''))
     do update set
       stanox = excluded.stanox, platform = excluded.platform,
       route_indicator = excluded.route_indicator, raw_source_json = excluded.raw_source_json,
       imported_at = now()`,
    [tdAreas, fromBerths, toBerths, stanoxes, platforms, eventTypes, routes, raws],
  );
  return result.rowCount ?? 0;
}

export async function runGarnerReferenceSync(
  garner: MysqlPool,
  pg: PgPool,
): Promise<GarnerSyncSummary> {
  const corpusUpserted = await syncCorpus(garner, pg);
  const smartUpserted = await syncSmart(garner, pg);
  return { corpusUpserted, smartUpserted };
}
