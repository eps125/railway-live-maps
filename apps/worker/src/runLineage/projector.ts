import type { Pool, PoolClient } from "pg";
import {
  getOrCreateProjectionDefinition,
  ensureCheckpoint,
  getCheckpoint,
  advanceCheckpoint,
} from "@railway/database";
import { evaluateStepChain, evaluateBoundaryCorroboration } from "@railway/domain";

/**
 * Milestone 39 (docs/adr/0007): threads an already-`resolved` run identity forward along
 * `td_berth_event` `CA` (berth step) chains, and across TD-area boundaries via owner-curated
 * `td_area_boundary` reference data. Never establishes a run itself — that's `currentRun.ts`'s
 * job on a click (`link_basis = 'resolved'`); this projector only ever inherits from an
 * already-linked occupancy (`link_basis = 'step_chain'` / `'boundary_correlated'`).
 *
 * Reads `td_berth_event` (not `raw_feed_event`) directly — it's already the normalized CA/CB/CC
 * mirror `project-td` maintains, so there's nothing left to parse here. Uses its own checkpoint
 * (`run-lineage`), independent of `project-td`'s, keyed on `td_berth_event.ingestion_sequence`.
 *
 * Deliberately does not take `project-td`'s advisory lock or bulk-`unnest` batching: this isn't a
 * hot-path table (docs/adr/0007 explicitly scopes this as a background enrichment, not a latency-
 * sensitive one), and every write here is `on conflict do nothing`/idempotent, so a redundant
 * concurrent run wastes work rather than corrupting state. Only one instance of this daemon is
 * ever deployed (`deploy/docker-compose.portainer.yml`), so that risk is theoretical.
 *
 * No new index on `berth_occupancy`: the from/to occupancy lookups below reuse the existing
 * `(td_area, berth_code, entered_at desc)` index, which narrows to one berth's own rows before
 * the remaining exact-match filter runs in memory — see each query's own comment.
 */
export const RUN_LINEAGE_PROJECTION_NAME = "run-lineage";
export const RUN_LINEAGE_PROJECTION_VERSION = 1;

const DEFAULT_BATCH_SIZE = 200;

/** How far past a boundary-berth exit a fresh interpose on the paired berth is even considered a
 * candidate at all — generous, since inter-area transit time varies a lot by route. Corroboration
 * (schedule timing / TRUST movement continuity), not this window, is what actually decides
 * `matched` vs `none`/`ambiguous` (docs/adr/0007) — this is only the candidate-discovery net. */
const BOUNDARY_CANDIDATE_WINDOW_MINUTES = 30;

/** Within this much tighter window, a candidate's own timing is taken as corroborating on its
 * own (a near-immediate reappearance on the paired berth is itself informative) — outside it,
 * `scheduleTimingPlausible` falls back to false and TRUST movement continuity is required
 * instead. Deliberately conservative; can be widened later against real crossing-time data. */
const BOUNDARY_TIGHT_WINDOW_MINUTES = 5;

interface TdStepEventRow {
  raw_event_id: string;
  raw_event_normalized_at_utc: Date;
  td_area: string;
  message_type: "CA" | "CB";
  from_berth: string;
  to_berth: string | null;
  ingestion_sequence: string;
}

interface CaStepRow {
  raw_event_normalized_at_utc: Date;
  td_area: string;
  from_berth: string;
  to_berth: string;
}

interface CbCancelRow {
  raw_event_normalized_at_utc: Date;
  td_area: string;
  from_berth: string;
}

interface OccupancyRef {
  id: string;
  entered_at: Date;
}

export interface RunLineageSummary {
  batches: number;
  processedEvents: number;
  stepChainLinks: number;
  boundaryLinks: number;
  boundaryAmbiguous: number;
}

const EMPTY_SUMMARY: RunLineageSummary = {
  batches: 0,
  processedEvents: 0,
  stepChainLinks: 0,
  boundaryLinks: 0,
  boundaryAmbiguous: 0,
};

async function findOccupancyLink(
  client: PoolClient,
  occupancy: OccupancyRef,
): Promise<{ trainRunId: string } | null> {
  const { rows } = await client.query<{ train_run_id: string }>(
    `select train_run_id from berth_occupancy_run_link
     where berth_occupancy_id = $1 and occupancy_entered_at = $2`,
    [occupancy.id, occupancy.entered_at],
  );
  return rows[0] ? { trainRunId: rows[0].train_run_id } : null;
}

async function duringFeedGap(client: PoolClient, tdArea: string, at: Date): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `select exists(
       select 1 from feed_gap
       where feed_name = 'TD' and (td_area is null or td_area = $1)
         and coalesce(affected_time_start, detected_start) <= $2
         and (coalesce(affected_time_end, detected_end) is null
              or coalesce(affected_time_end, detected_end) >= $2)
     ) as exists`,
    [tdArea, at],
  );
  return rows[0]?.exists ?? false;
}

async function insertLink(
  client: PoolClient,
  occupancy: OccupancyRef,
  trainRunId: string,
  linkBasis: "step_chain" | "boundary_correlated",
): Promise<boolean> {
  const result = await client.query(
    `insert into berth_occupancy_run_link (berth_occupancy_id, occupancy_entered_at, train_run_id, link_basis)
     values ($1, $2, $3, $4)
     on conflict (berth_occupancy_id, occupancy_entered_at) do nothing`,
    [occupancy.id, occupancy.entered_at, trainRunId, linkBasis],
  );
  return (result.rowCount ?? 0) > 0;
}

/** The occupancy a `CA` step's own `from_berth` closed — narrowed by the existing
 * `(td_area, berth_code, entered_at desc)` index (`td_area`/`berth_code` first), then an exact
 * `left_at` match against the CA event's own timestamp (both effects share it — see
 * `apps/worker/src/td/projector.ts`'s `processCClassBatch`). */
async function findClosedByStep(
  client: PoolClient,
  tdArea: string,
  berth: string,
  at: Date,
): Promise<OccupancyRef | null> {
  const { rows } = await client.query<OccupancyRef>(
    `select id, entered_at from berth_occupancy
     where td_area = $1 and berth_code = $2 and left_at = $3 and exit_reason = 'stepped_out'
     order by entered_at desc limit 1`,
    [tdArea, berth, at],
  );
  return rows[0] ?? null;
}

/** The occupancy a `CA` step opened at `to_berth` — same index, exact `entered_at` match. Absent
 * when the step carried `NULL_DESCRIPTION` (the berth was cleared, nothing opened). */
async function findOpenedByStep(
  client: PoolClient,
  tdArea: string,
  berth: string,
  at: Date,
): Promise<OccupancyRef | null> {
  const { rows } = await client.query<OccupancyRef>(
    `select id, entered_at from berth_occupancy
     where td_area = $1 and berth_code = $2 and entered_at = $3 and entry_reason = 'ca_step'`,
    [tdArea, berth, at],
  );
  return rows[0] ?? null;
}

async function processStepChainBatch(
  client: PoolClient,
  rows: CaStepRow[],
  summary: RunLineageSummary,
): Promise<void> {
  for (const row of rows) {
    const toOccupancy = await findOpenedByStep(
      client,
      row.td_area,
      row.to_berth,
      row.raw_event_normalized_at_utc,
    );
    if (!toOccupancy) continue; // NULL_DESCRIPTION step — nothing opened, nothing to link.

    const fromOccupancy = await findClosedByStep(
      client,
      row.td_area,
      row.from_berth,
      row.raw_event_normalized_at_utc,
    );
    const sourceLink = fromOccupancy ? await findOccupancyLink(client, fromOccupancy) : null;
    const gapped = await duringFeedGap(client, row.td_area, row.raw_event_normalized_at_utc);

    const verdict = evaluateStepChain({
      sourceHasLink: sourceLink !== null,
      isCleanStep: true,
      duringFeedGap: gapped,
    });
    if (!verdict.propagate || !sourceLink) continue;

    const inserted = await insertLink(client, toOccupancy, sourceLink.trainRunId, "step_chain");
    if (inserted) summary.stepChainLinks += 1;
  }
}

interface BoundaryPair {
  pairedArea: string;
  pairedBerth: string;
}

async function findBoundaryPair(
  client: PoolClient,
  tdArea: string,
  berth: string,
): Promise<BoundaryPair | null> {
  const { rows } = await client.query<{ area: string; berth: string }>(
    `select area_b as area, berth_b as berth from td_area_boundary
       where area_a = $1 and berth_a = $2
     union all
     select area_a as area, berth_a as berth from td_area_boundary
       where area_b = $1 and berth_b = $2
     limit 1`,
    [tdArea, berth],
  );
  return rows[0] ? { pairedArea: rows[0].area, pairedBerth: rows[0].berth } : null;
}

interface RunForCorroboration {
  cifScheduleId: string | null;
  cifTrainUid: string;
  trafficDay: string;
}

async function scheduleCallsNearInWindow(
  client: PoolClient,
  cifScheduleId: string,
  pairedBerthTiplocs: string[],
  windowStart: Date,
  windowEnd: Date,
): Promise<boolean> {
  if (pairedBerthTiplocs.length === 0) return false;
  // Loose but safe: only checks that the schedule calls at one of the paired berth's TIPLOCs at
  // all, not the exact minute — CIF times are day-relative strings, not instants, and this
  // corroboration is one of two independent signals (docs/adr/0007), not the sole decider.
  const { rows } = await client.query<{ exists: boolean }>(
    `select exists(
       select 1 from cif_schedule_locations
       where cif_schedule_id = $1 and tiploc_code = any($2::text[])
     ) as exists`,
    [cifScheduleId, pairedBerthTiplocs],
  );
  void windowStart;
  void windowEnd;
  return rows[0]?.exists ?? false;
}

async function trustMovementContinuesPast(
  client: PoolClient,
  cifScheduleId: string,
  trafficDay: string,
  after: Date,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `select exists(
       select 1 from trust_activation a
       join trust_movement m on m.trust_id = a.trust_id
       where a.cif_schedule_id = $1
         and a.created >= ($2::date)::timestamp at time zone 'Europe/London'
         and m.actual_timestamp > $3
     ) as exists`,
    [cifScheduleId, trafficDay, after],
  );
  return rows[0]?.exists ?? false;
}

async function pairedBerthTiplocs(
  client: PoolClient,
  tdArea: string,
  berth: string,
): Promise<string[]> {
  const { rows } = await client.query<{ tiploc: string }>(
    `select distinct l.tiploc from smart_berth_step s
     join location_reference l on l.stanox = s.stanox
     where s.td_area = $1 and (s.from_berth = $2 or s.to_berth = $2) and s.stanox is not null`,
    [tdArea, berth],
  );
  return rows.map((r) => r.tiploc);
}

async function processBoundaryBatch(
  client: PoolClient,
  rows: CbCancelRow[],
  summary: RunLineageSummary,
): Promise<void> {
  for (const row of rows) {
    const fromOccupancy = await findClosedByStep(
      client,
      row.td_area,
      row.from_berth,
      row.raw_event_normalized_at_utc,
    );
    if (!fromOccupancy) continue;
    const link = await findOccupancyLink(client, fromOccupancy);
    if (!link) continue;

    const pair = await findBoundaryPair(client, row.td_area, row.from_berth);
    if (!pair) continue; // No owner-curated boundary here — falls back to fresh resolution.

    const { rows: runRows } = await client.query<{
      cif_schedule_id: string | null;
      cif_train_uid: string;
      traffic_day: string;
    }>(
      `select cif_schedule_id, cif_train_uid, traffic_day::text as traffic_day from train_run where id = $1`,
      [link.trainRunId],
    );
    const run = runRows[0] as RunForCorroboration | undefined;
    if (!run) continue;

    const windowStart = row.raw_event_normalized_at_utc;
    const windowEnd = new Date(windowStart.getTime() + BOUNDARY_CANDIDATE_WINDOW_MINUTES * 60_000);
    const tightEnd = new Date(windowStart.getTime() + BOUNDARY_TIGHT_WINDOW_MINUTES * 60_000);

    const { rows: candidateRows } = await client.query<OccupancyRef>(
      `select id, entered_at from berth_occupancy
       where td_area = $1 and berth_code = $2 and entry_reason = 'cc_interpose'
         and entered_at between $3 and $4
       order by entered_at asc`,
      [pair.pairedArea, pair.pairedBerth, windowStart, windowEnd],
    );
    // Only candidates not already claimed by some other run are real candidates here.
    const unclaimedCandidates: OccupancyRef[] = [];
    for (const candidate of candidateRows) {
      const existing = await findOccupancyLink(client, candidate);
      if (!existing) unclaimedCandidates.push(candidate);
    }
    if (unclaimedCandidates.length === 0) continue;

    const withinTight = unclaimedCandidates.filter((c) => c.entered_at <= tightEnd);
    const scheduleTimingPlausible =
      withinTight.length > 0 && run.cifScheduleId
        ? await scheduleCallsNearInWindow(
            client,
            run.cifScheduleId,
            await pairedBerthTiplocs(client, pair.pairedArea, pair.pairedBerth),
            windowStart,
            windowEnd,
          )
        : false;
    const trustMovementContinuity = run.cifScheduleId
      ? await trustMovementContinuesPast(client, run.cifScheduleId, run.trafficDay, windowStart)
      : false;

    const verdict = evaluateBoundaryCorroboration({
      candidateCount: unclaimedCandidates.length,
      scheduleTimingPlausible,
      trustMovementContinuity,
    });
    if (verdict.status === "ambiguous") {
      summary.boundaryAmbiguous += 1;
      continue;
    }
    if (verdict.status !== "matched") continue;

    const inserted = await insertLink(
      client,
      unclaimedCandidates[0]!,
      link.trainRunId,
      "boundary_correlated",
    );
    if (inserted) summary.boundaryLinks += 1;
  }
}

export interface RunLineageOptions {
  batchSize?: number;
}

export async function runProjectRunLineage(
  pool: Pool,
  options: RunLineageOptions = {},
): Promise<RunLineageSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const definitionId = await getOrCreateProjectionDefinition(
    pool,
    RUN_LINEAGE_PROJECTION_NAME,
    RUN_LINEAGE_PROJECTION_VERSION,
    "run-lineage-v1",
  );
  await ensureCheckpoint(pool, definitionId);

  const summary: RunLineageSummary = { ...EMPTY_SUMMARY };

  for (;;) {
    const checkpoint = await getCheckpoint(pool, definitionId);
    const lastSequence = checkpoint?.lastIngestionSequence ?? "0";

    const batch = await pool.query<TdStepEventRow>(
      `select raw_event_id, raw_event_normalized_at_utc, td_area, message_type,
              from_berth, to_berth, ingestion_sequence
       from td_berth_event
       where ingestion_sequence > $1 and message_type in ('CA', 'CB')
       order by ingestion_sequence
       limit $2`,
      [lastSequence, batchSize],
    );
    if (batch.rows.length === 0) break;
    summary.batches += 1;
    summary.processedEvents += batch.rows.length;

    const caRows: CaStepRow[] = batch.rows
      .filter((r) => r.message_type === "CA" && r.to_berth !== null)
      .map((r) => ({
        raw_event_normalized_at_utc: r.raw_event_normalized_at_utc,
        td_area: r.td_area,
        from_berth: r.from_berth,
        to_berth: r.to_berth as string,
      }));
    const cbRows: CbCancelRow[] = batch.rows
      .filter((r) => r.message_type === "CB")
      .map((r) => ({
        raw_event_normalized_at_utc: r.raw_event_normalized_at_utc,
        td_area: r.td_area,
        from_berth: r.from_berth,
      }));

    const client = await pool.connect();
    try {
      await client.query("begin");
      await processStepChainBatch(client, caRows, summary);
      await processBoundaryBatch(client, cbRows, summary);
      const maxSequence = batch.rows.reduce(
        (max, r) => (BigInt(r.ingestion_sequence) > max ? BigInt(r.ingestion_sequence) : max),
        BigInt(lastSequence),
      );
      await advanceCheckpoint(client, definitionId, maxSequence.toString());
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    if (batch.rows.length < batchSize) break;
  }

  return summary;
}
