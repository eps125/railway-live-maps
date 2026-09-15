import type { Pool, PoolClient } from "pg";
import {
  getOrCreateProjectionDefinition,
  ensureCheckpoint,
  getCheckpoint,
  advanceCheckpoint,
  getMappedTdAreas,
  resolveFreshRunMatch,
  upsertResolvedLink,
  findOccupancyLink,
  londonToday,
  londonMinutesSinceMidnight,
} from "@railway/database";
import {
  evaluateStepChain,
  evaluateBoundaryCorroboration,
  isSameRunIdentity,
} from "@railway/domain";

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
  description: string | null;
  ingestion_sequence: string;
}

interface CaStepRow {
  raw_event_normalized_at_utc: Date;
  td_area: string;
  from_berth: string;
  to_berth: string;
  /** The headcode the step carried into `to_berth` — needed only for a step-chain upgrade
   * attempt (see `UpgradeCandidate`); the inheritance path itself never looks at it. */
  description: string | null;
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
  stepChainUpgrades: number;
  boundaryLinks: number;
  boundaryAmbiguous: number;
  freshResolutionAttempts: number;
  freshResolutionLinks: number;
}

const EMPTY_SUMMARY: RunLineageSummary = {
  batches: 0,
  processedEvents: 0,
  stepChainLinks: 0,
  stepChainUpgrades: 0,
  boundaryLinks: 0,
  boundaryAmbiguous: 0,
  freshResolutionAttempts: 0,
  freshResolutionLinks: 0,
};

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

/** How far back an occupancy could plausibly have been entered before closing "now" and still be
 * found by `findOccupancyClosedAt` — generous enough for any realistic stabling duration (a
 * weekend engineering possession, say), while still bounding the search enough to matter. */
const OCCUPANCY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** The occupancy a `from_berth` closed at exactly `at` — narrowed by the existing
 * `(td_area, berth_code, entered_at desc)` index (`td_area`/`berth_code` first), then an exact
 * `left_at` match against the closing event's own timestamp (both sides of one C-class effect
 * share it — see `apps/worker/src/td/projector.ts`'s `processCClassBatch`). Deliberately not
 * filtered by `exit_reason`: a `CA` step closes with `'stepped_out'`, a `CB` cancel with
 * `'cancelled'` (`packages/domain/src/td/berthReducer.ts`) — this is shared by both
 * `processStepChainBatch` (`CA`) and `processBoundaryBatch` (`CB`), so it can't hardcode either
 * one's reason string (bug caught by CI, 2026-09-14: originally hardcoded `'stepped_out'`, which
 * silently found nothing for every `CB` cancel). The exact `(td_area, berth_code, left_at)` match
 * is already precise enough to identify the row on its own — but without a predicate on
 * `entered_at` (`berth_occupancy`'s own partition key), Postgres has no way to prune old month
 * partitions from the plan and must check all of them, including cold, rarely-touched ones with
 * real data (production incident, 2026-09-14: 15.4s for a single lookup that touched one such
 * partition — 6.5ms once its pages were cached — and every *new* live berth this daemon had never
 * looked up yet paid that cost again, since a one-time cache warm doesn't help a different berth's
 * different pages; seeding the checkpoint forward fixed the backlog-replay case but not this one).
 * The `entered_at >= $4` bound below lets the planner prune everything older than
 * `OCCUPANCY_LOOKBACK_MS` from the plan entirely — confirmed via `EXPLAIN` to drop the historical
 * partitions out of the query altogether, not just filter them out after scanning. */
async function findOccupancyClosedAt(
  client: PoolClient,
  tdArea: string,
  berth: string,
  at: Date,
): Promise<OccupancyRef | null> {
  const { rows } = await client.query<OccupancyRef>(
    `select id, entered_at from berth_occupancy
     where td_area = $1 and berth_code = $2 and left_at = $3 and entered_at >= $4
     order by entered_at desc limit 1`,
    [tdArea, berth, at, new Date(at.getTime() - OCCUPANCY_LOOKBACK_MS)],
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

/**
 * docs/adr/0007 addendum (2026-09-15): a step-chain inheritance whose source link is only
 * `weak` (`headcode_only` — established at a berth with no SMART coverage at all) is worth a
 * fresh, position-scoped second look at the berth it just stepped into, once that berth's own
 * transaction has committed. Collected here rather than resolved inline: `resolveFreshRunMatch`/
 * `upsertResolvedLink` need their own connection/transaction (matching how the click path and
 * `sweepFreshResolution` already use them), not the batch's own `client`.
 */
interface UpgradeCandidate {
  occupancy: OccupancyRef;
  tdArea: string;
  berth: string;
  headcode: string;
  source: { cifScheduleId: string | null; cifTrainUid: string; trafficDay: string };
}

async function processStepChainBatch(
  client: PoolClient,
  rows: CaStepRow[],
  summary: RunLineageSummary,
  eligibleAreas: Set<string> | "nationwide" | null,
  upgradeCandidates: UpgradeCandidate[],
): Promise<void> {
  for (const row of rows) {
    const toOccupancy = await findOpenedByStep(
      client,
      row.td_area,
      row.to_berth,
      row.raw_event_normalized_at_utc,
    );
    if (!toOccupancy) continue; // NULL_DESCRIPTION step — nothing opened, nothing to link.

    const fromOccupancy = await findOccupancyClosedAt(
      client,
      row.td_area,
      row.from_berth,
      row.raw_event_normalized_at_utc,
    );
    const sourceLink = fromOccupancy
      ? await findOccupancyLink(client, {
          id: fromOccupancy.id,
          enteredAt: fromOccupancy.entered_at,
        })
      : null;
    const gapped = await duringFeedGap(client, row.td_area, row.raw_event_normalized_at_utc);

    const verdict = evaluateStepChain({
      sourceHasLink: sourceLink !== null,
      isCleanStep: true,
      duringFeedGap: gapped,
    });
    if (!verdict.propagate || !sourceLink) continue;

    const inserted = await insertLink(client, toOccupancy, sourceLink.trainRunId, "step_chain");
    if (!inserted) continue;
    summary.stepChainLinks += 1;

    // A solidly-established identity has nothing to gain from a second look — only a weak one
    // (never because the scoped search at the *source* berth came back empty on its own merits;
    // this berth's own position data might simply be better).
    if (sourceLink.matchConfidence !== "weak" || eligibleAreas === null || !row.description) {
      continue;
    }
    const areaEligible = eligibleAreas === "nationwide" || eligibleAreas.has(row.td_area);
    if (!areaEligible) continue;
    upgradeCandidates.push({
      occupancy: toOccupancy,
      tdArea: row.td_area,
      berth: row.to_berth,
      headcode: row.description,
      source: {
        cifScheduleId: sourceLink.cifScheduleId,
        cifTrainUid: sourceLink.cifTrainUid,
        trafficDay: sourceLink.trafficDay,
      },
    });
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
    const fromOccupancy = await findOccupancyClosedAt(
      client,
      row.td_area,
      row.from_berth,
      row.raw_event_normalized_at_utc,
    );
    if (!fromOccupancy) continue;
    const link = await findOccupancyLink(client, {
      id: fromOccupancy.id,
      enteredAt: fromOccupancy.entered_at,
    });
    if (!link) continue;

    const pair = await findBoundaryPair(client, row.td_area, row.from_berth);
    if (!pair) continue; // No owner-curated boundary here — falls back to fresh resolution.

    // The shared @railway/database findOccupancyLink already joins train_run, so link itself
    // carries cifScheduleId/cifTrainUid/trafficDay — no separate re-query needed (this used to
    // hand-roll one against the worker-private, trainRunId-only findOccupancyLink).
    const run = link;

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
      const existing = await findOccupancyLink(client, {
        id: candidate.id,
        enteredAt: candidate.entered_at,
      });
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

export type FreshResolutionScope = "mapped" | "nationwide";

/** How far back an occupancy could have opened and still be worth a fresh-resolution attempt —
 * bounds the sweep query to currently-relevant occupancies rather than every open one ever
 * (there shouldn't be many older than this still lacking a link, but nothing guarantees it). */
const FRESH_RESOLUTION_LOOKBACK_MINUTES = 15;
/** Minimum gap between two attempts on the *same* occupancy — an unmatched result (e.g. its TRUST
 * activation hasn't landed yet) is worth retrying, but not on every 1s tick. */
const FRESH_RESOLUTION_COOLDOWN_MS = 30_000;
const FRESH_RESOLUTION_BATCH_LIMIT = 200;

interface OpenUnlinkedOccupancyRow {
  id: string;
  entered_at: Date;
  td_area: string;
  berth_code: string;
  description: string;
}

/** In-memory, per-daemon-process — created once by `run-lineage-daemon` and passed into every
 * tick's `sweepFreshResolution` call, so cooldowns actually persist across ticks. Never persisted;
 * a restart just means the next tick's occupancies retry immediately, which is fine (cheap). */
export function createFreshResolutionCooldown(): Map<string, number> {
  return new Map();
}

/**
 * docs/adr/0007 addendum (2026-09-14): proactively resolves any currently-open, still-unlinked
 * occupancy in an eligible TD area, instead of waiting for a click (`currentRun.ts`) or an
 * inheritable step-chain/boundary link (the batch loop above) — the gap that let a real train
 * (5N92/W85506) go completely unidentified all day despite good SMART coverage at several berths
 * it passed through, because nobody happened to click it there. Deliberately separate from the
 * checkpoint-driven CA/CB batch loop above (left untouched — hardened through two real production
 * incidents the same day) rather than folded into it: this also naturally covers occupancies a
 * `CC` interpose opens (a train's very first berth — e.g. its origin — which the CA/CB-only batch
 * loop never reads at all), and boundary crossings with no owner-curated `td_area_boundary` pair
 * (`processBoundaryBatch`'s own `// falls back to fresh resolution` comment, above).
 */
export async function sweepFreshResolution(
  pool: Pool,
  scope: FreshResolutionScope,
  cooldown: Map<string, number>,
  summary: RunLineageSummary,
): Promise<void> {
  const eligibleAreas = scope === "mapped" ? await getMappedTdAreas(pool) : null;
  if (eligibleAreas && eligibleAreas.size === 0) return; // No published map bindings yet.

  const params: unknown[] = [FRESH_RESOLUTION_BATCH_LIMIT];
  let areaFilter = "";
  if (eligibleAreas) {
    params.push([...eligibleAreas]);
    areaFilter = "and bo.td_area = any($2::text[])";
  }

  const { rows } = await pool.query<OpenUnlinkedOccupancyRow>(
    `select bo.id, bo.entered_at, bo.td_area, bo.berth_code, bo.description
       from berth_occupancy bo
      where bo.left_at is null
        and bo.description is not null
        and bo.entered_at >= now() - interval '${FRESH_RESOLUTION_LOOKBACK_MINUTES} minutes'
        and not exists (
          select 1 from berth_occupancy_run_link l
          where l.berth_occupancy_id = bo.id and l.occupancy_entered_at = bo.entered_at
        )
        ${areaFilter}
      limit $1`,
    params,
  );
  if (rows.length === 0) return;

  const now = Date.now();
  const cooldownCutoff = now - FRESH_RESOLUTION_COOLDOWN_MS;
  // Evict cooldown entries older than the lookback window — those occupancies have aged out of
  // the query above regardless, so the entry can never be consulted again.
  const evictBefore = now - FRESH_RESOLUTION_LOOKBACK_MINUTES * 60_000;
  for (const [key, attemptedAt] of cooldown) {
    if (attemptedAt < evictBefore) cooldown.delete(key);
  }

  const nowDate = new Date(now);
  const today = londonToday(nowDate);
  const nowMinutes = londonMinutesSinceMidnight(nowDate);

  for (const row of rows) {
    const key = `${row.id}:${row.entered_at.toISOString()}`;
    const lastAttempt = cooldown.get(key);
    if (lastAttempt !== undefined && lastAttempt > cooldownCutoff) continue;
    cooldown.set(key, now);
    summary.freshResolutionAttempts += 1;

    const fresh = await resolveFreshRunMatch(pool, {
      tdArea: row.td_area,
      berth: row.berth_code,
      headcode: row.description,
      today,
      nowMinutes,
    });
    if (
      fresh.matchStatus !== "matched" ||
      !fresh.effectiveRow ||
      !fresh.matchBasis ||
      !fresh.trafficDay
    ) {
      continue;
    }

    await upsertResolvedLink(
      pool,
      { id: row.id, enteredAt: row.entered_at },
      {
        cifScheduleId: fresh.effectiveRow.id,
        cifTrainUid: fresh.effectiveRow.cif_train_uid,
        // Traffic-day-boundary fix (docs/adr/0008): the traffic day this match actually resolved
        // against — not necessarily `today` for an overnight train (see resolveRunMatch.ts).
        trafficDay: fresh.trafficDay,
        matchBasis: fresh.matchBasis,
        tdArea: row.td_area,
        berth: row.berth_code,
      },
    );
    summary.freshResolutionLinks += 1;
  }
}

/**
 * Called once by `run-lineage-daemon` (`apps/worker/src/commands/runLineageDaemon.ts`) before its
 * first tick — deliberately **not** part of `runProjectRunLineage` itself, so a test calling that
 * directly against fixture rows it just inserted (every case in `projector.integration.test.ts`)
 * is never affected by this.
 *
 * On this projector's very first run only (a genuinely fresh checkpoint — never advanced, same
 * "is it fresh" guard `apps/worker/src/garner/bridge.ts`'s `seedWatermarkIfFresh` uses), skips
 * straight to the current tail of `td_berth_event` instead of starting from `ingestion_sequence
 * 0`. Production incident, 2026-09-14: sticky matching only has value for *live, ongoing* train
 * movements — a step from months ago tells today's ambiguous berth nothing — but a from-scratch
 * checkpoint tried to replay the entire nationwide history regardless, and the per-row occupancy
 * lookups (`findOccupancyClosedAt`/`findOpenedByStep`) hit cold, never-cached pages on old
 * partitions hard enough to blow the daemon's own statement timeout on the very first batch
 * (15.4s observed on one lookup against a historical partition — 6.5ms on the identical query
 * once warmed, confirming it was purely a cold-cache cost, not a design flaw needing more
 * indexing). `max(ingestion_sequence)` is a fast backward index scan once
 * `td_berth_event_ingestion_sequence_idx` exists (migration 0033, also added after this same
 * incident) — cheap even though `td_berth_event` itself is huge.
 */
export async function seedRunLineageCheckpointIfFresh(pool: Pool): Promise<void> {
  const definitionId = await getOrCreateProjectionDefinition(
    pool,
    RUN_LINEAGE_PROJECTION_NAME,
    RUN_LINEAGE_PROJECTION_VERSION,
    "run-lineage-v1",
  );
  await ensureCheckpoint(pool, definitionId);
  const checkpoint = await getCheckpoint(pool, definitionId);
  if (
    !checkpoint ||
    checkpoint.lastIngestionSequence !== "0" ||
    checkpoint.lastCompletedAt !== null
  ) {
    return;
  }
  const { rows } = await pool.query<{ max_seq: string | null }>(
    `select max(ingestion_sequence)::text as max_seq from td_berth_event`,
  );
  const maxSeq = rows[0]?.max_seq;
  if (maxSeq) {
    await advanceCheckpoint(pool, definitionId, maxSeq);
  }
}

/**
 * docs/adr/0007 addendum (2026-09-15): resolves each `UpgradeCandidate` `processStepChainBatch`
 * collected — using `pool` (not the batch's own `client`), matching `sweepFreshResolution`'s own
 * reasoning: a resolution's write should commit or fail on its own, independent of whatever
 * transaction its *candidacy* was discovered inside. Never touches a candidate whose fresh result
 * doesn't independently confirm the exact same train (`isSameRunIdentity`) — a different train
 * sharing the headcode must never overwrite an existing link, upgrade or not.
 */
async function attemptStepChainUpgrades(
  pool: Pool,
  candidates: UpgradeCandidate[],
  summary: RunLineageSummary,
): Promise<void> {
  if (candidates.length === 0) return;
  const now = new Date();
  const today = londonToday(now);
  const nowMinutes = londonMinutesSinceMidnight(now);

  for (const candidate of candidates) {
    const fresh = await resolveFreshRunMatch(pool, {
      tdArea: candidate.tdArea,
      berth: candidate.berth,
      headcode: candidate.headcode,
      today,
      nowMinutes,
    });
    if (
      fresh.matchStatus !== "matched" ||
      !fresh.effectiveRow ||
      !fresh.matchBasis ||
      !fresh.trafficDay ||
      !fresh.isSolidMatch ||
      candidate.source.cifScheduleId === null ||
      !isSameRunIdentity(
        {
          cifScheduleId: fresh.effectiveRow.id,
          cifTrainUid: fresh.effectiveRow.cif_train_uid,
          trafficDay: fresh.trafficDay,
        },
        {
          cifScheduleId: candidate.source.cifScheduleId,
          cifTrainUid: candidate.source.cifTrainUid,
          trafficDay: candidate.source.trafficDay,
        },
      )
    ) {
      continue;
    }

    await upsertResolvedLink(
      pool,
      { id: candidate.occupancy.id, enteredAt: candidate.occupancy.entered_at },
      {
        cifScheduleId: fresh.effectiveRow.id,
        cifTrainUid: fresh.effectiveRow.cif_train_uid,
        // Traffic-day-boundary fix (docs/adr/0008): see sweepFreshResolution's own note above.
        trafficDay: fresh.trafficDay,
        matchBasis: fresh.matchBasis,
        tdArea: candidate.tdArea,
        berth: candidate.berth,
      },
    );
    summary.stepChainUpgrades += 1;
  }
}

export interface RunLineageOptions {
  batchSize?: number;
  /** `null`/omitted disables step-chain-upgrade attempts entirely (same
   * `RUN_LINEAGE_FRESH_RESOLUTION_ENABLED`/`_SCOPE` config `sweepFreshResolution` uses — this is
   * the same category of extra DB work, so it shares the same on/off switch and scope rather than
   * introducing a second one). */
  freshResolutionScope?: FreshResolutionScope | null;
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

  // Resolved once per call (the daemon calls this once per 1s tick) rather than per inner batch
  // iteration below — cheap either way, but there's no reason to re-query it if a backlog needs
  // several batches to drain in one call.
  const eligibleAreas: Set<string> | "nationwide" | null =
    options.freshResolutionScope === "nationwide"
      ? "nationwide"
      : options.freshResolutionScope === "mapped"
        ? await getMappedTdAreas(pool)
        : null;

  const summary: RunLineageSummary = { ...EMPTY_SUMMARY };

  for (;;) {
    const checkpoint = await getCheckpoint(pool, definitionId);
    const lastSequence = checkpoint?.lastIngestionSequence ?? "0";

    const batch = await pool.query<TdStepEventRow>(
      `select raw_event_id, raw_event_normalized_at_utc, td_area, message_type,
              from_berth, to_berth, description, ingestion_sequence
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
        description: r.description,
      }));
    const cbRows: CbCancelRow[] = batch.rows
      .filter((r) => r.message_type === "CB")
      .map((r) => ({
        raw_event_normalized_at_utc: r.raw_event_normalized_at_utc,
        td_area: r.td_area,
        from_berth: r.from_berth,
      }));

    const upgradeCandidates: UpgradeCandidate[] = [];
    const client = await pool.connect();
    try {
      await client.query("begin");
      await processStepChainBatch(client, caRows, summary, eligibleAreas, upgradeCandidates);
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
    await attemptStepChainUpgrades(pool, upgradeCandidates, summary);

    if (batch.rows.length < batchSize) break;
  }

  return summary;
}
