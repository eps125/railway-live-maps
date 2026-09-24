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
  type OccupancyLink,
  londonToday,
  londonMinutesSinceMidnight,
} from "@railway/database";
import { evaluateStepChain, evaluateBoundaryCrossing, isSameRunIdentity } from "@railway/domain";

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

/** How far apart, either way, a boundary's exit and entry may be and still count as the same
 * crossing. Real crossings overlap by a minute or two, the receiving area usually first
 * (2026-09-24: CL interposed 1S02 at A004 2 min before PX stepped it out of CE04; PX had each
 * southbound train at A304 ~1.5 min before CL stepped it out of 0007). */
const BOUNDARY_WINDOW_MINUTES = 10;

/** How long an unlinked entry-berth occupancy keeps being checked — covers the window above with
 * room to spare; after that it is left to fresh resolution. */
const BOUNDARY_SWEEP_LOOKBACK_MINUTES = 20;

/** How far back an exit-side occupancy may have *entered* its berth. Only bounds the index range
 * scanned (it must also have left within the window): on production, 7 days of PX CE04 rows cost
 * 146 ms cold, 24 h costs 2-12 ms. */
const BOUNDARY_EXIT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Minimum gap between two checks of the same still-undecided entry. */
const BOUNDARY_RECHECK_MS = 5_000;

/** Safety bound on how many already-stepped occupancies one boundary link is carried through. */
const MAX_FORWARD_PROPAGATION_STEPS = 200;

/** In-memory, per-daemon-process throttle for the boundary sweep — same shape and lifetime as
 * `createFreshResolutionCooldown`. */
export function createBoundaryCooldown(): Map<string, number> {
  return new Map();
}

interface TdStepEventRow {
  raw_event_id: string;
  raw_event_normalized_at_utc: Date;
  td_area: string;
  message_type: "CA";
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
 * `processStepChainBatch` (`CA`) and, originally, a `CB`-triggered boundary check, so it can't hardcode either
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

interface BoundaryEntryRow {
  exit_area: string;
  exit_berth: string;
  entry_area: string;
  entry_berth: string;
  id: string;
  entered_at: Date;
  description: string;
}

interface BoundaryExitRow {
  id: string;
  entered_at: Date;
  left_at: Date | null;
}

interface ForwardOccupancyRow {
  td_area: string;
  description: string;
  left_at: Date | null;
  exit_reason: string | null;
  exit_event_id: string | null;
}

/**
 * Carries a just-written boundary link on through occupancies the train has *already* stepped
 * into on the new side. The entry berth is usually a fringe berth the train leaves before the
 * exit side lets go (1S02, 2026-09-24: CL A004 -> 0005 at 16:25:40, PX CE04 -> COUT at 16:25:48),
 * and `processStepChainBatch` never revisits a step it saw while its source was still unlinked.
 * Follows only clean `stepped_out` exits to the occupancy that same step opened (`entry_event_id`
 * = the step's raw event), under the same `evaluateStepChain` rules, and stops at the first
 * occupancy that already has a link of its own.
 */
async function propagateLinkForward(
  client: PoolClient,
  start: OccupancyRef,
  trainRunId: string,
  summary: RunLineageSummary,
): Promise<void> {
  let current = start;
  for (let step = 0; step < MAX_FORWARD_PROPAGATION_STEPS; step += 1) {
    const row = (
      await client.query<ForwardOccupancyRow>(
        `select td_area, description, left_at, exit_reason, exit_event_id::text as exit_event_id
         from berth_occupancy where id = $1 and entered_at = $2`,
        [current.id, current.entered_at],
      )
    ).rows[0];
    if (!row || row.exit_reason !== "stepped_out" || !row.left_at || !row.exit_event_id) return;

    // `(description, entered_at)` index: a step opens its `to` occupancy with the step's own
    // description at the step's own timestamp, and `entry_event_id` pins it to this exact step.
    const next = (
      await client.query<OccupancyRef>(
        `select id, entered_at from berth_occupancy
         where description = $1 and entered_at = $2 and td_area = $3
           and entry_reason = 'ca_step' and entry_event_id = $4`,
        [row.description, row.left_at, row.td_area, row.exit_event_id],
      )
    ).rows[0];
    if (!next) return;

    const verdict = evaluateStepChain({
      sourceHasLink: true,
      isCleanStep: true,
      duringFeedGap: await duringFeedGap(client, row.td_area, row.left_at),
    });
    if (!verdict.propagate) return;
    if (!(await insertLink(client, next, trainRunId, "step_chain"))) return;
    summary.stepChainLinks += 1;
    current = next;
  }
}

/**
 * Carries an already-matched run across an owner-curated `td_area_boundary` (docs/adr/0007,
 * Milestone 69 addendum). The curated berth pair is the evidence: a linked occupancy leaving the
 * exit berth, and exactly one unclaimed same-headcode occupancy at the paired entry berth within
 * `BOUNDARY_WINDOW_MINUTES` either side of that exit, and the entry inherits the run. No TRUST or
 * schedule check. Pairs are usable in both directions.
 *
 * A sweep over recent entry-berth occupancies rather than a reaction to one event, because real
 * crossings don't arrive in one order (2026-09-24, PX <-> CL): the receiving area usually has the
 * train a minute or two *before* the sending area steps it out, both sides are usually `CA` steps
 * rather than a `CC` interpose or a `CB` cancel, and whichever event lands second must still find
 * the first. An entry whose exit side hasn't left yet is simply re-checked on a later tick.
 */
async function sweepBoundaryCrossings(
  client: PoolClient,
  now: Date,
  cooldown: Map<string, number> | null,
  summary: RunLineageSummary,
): Promise<void> {
  // One `(td_area, berth_code, entered_at)` index probe per boundary berth.
  const { rows: entries } = await client.query<BoundaryEntryRow>(
    `with pairs as (
       select area_a as exit_area, berth_a as exit_berth, area_b as entry_area, berth_b as entry_berth
       from td_area_boundary
       union
       select area_b, berth_b, area_a, berth_a from td_area_boundary
     )
     select p.exit_area, p.exit_berth, p.entry_area, p.entry_berth,
            e.id, e.entered_at, e.description
     from pairs p
     join berth_occupancy e
       on e.td_area = p.entry_area and e.berth_code = p.entry_berth
      and e.entered_at >= $1::timestamptz - make_interval(mins => $2)
      and e.entered_at <= $1::timestamptz
     where not exists (
       select 1 from berth_occupancy_run_link l
       where l.berth_occupancy_id = e.id and l.occupancy_entered_at = e.entered_at
     )
     order by e.entered_at`,
    [now, BOUNDARY_SWEEP_LOOKBACK_MINUTES],
  );

  const nowMs = now.getTime();
  if (cooldown) {
    for (const [key, checkedAt] of cooldown) {
      if (checkedAt < nowMs - BOUNDARY_SWEEP_LOOKBACK_MINUTES * 60_000) cooldown.delete(key);
    }
  }
  const windowMs = BOUNDARY_WINDOW_MINUTES * 60_000;

  for (const entry of entries) {
    // Per-entry work is throttled: an entry whose exit side is never matched stays unlinked for
    // the whole lookback, and shouldn't be re-queried every 1s tick.
    if (cooldown) {
      const key = `${entry.id}:${entry.entered_at.toISOString()}`;
      const lastChecked = cooldown.get(key);
      if (lastChecked !== undefined && nowMs - lastChecked < BOUNDARY_RECHECK_MS) continue;
      cooldown.set(key, nowMs);
    }
    const enteredMs = entry.entered_at.getTime();

    const { rows: exits } = await client.query<BoundaryExitRow>(
      `select id, entered_at, left_at from berth_occupancy
       where td_area = $1 and berth_code = $2 and description = $3
         and entered_at >= $4 and entered_at <= $5
         and (left_at is null or left_at between $6 and $5)`,
      [
        entry.exit_area,
        entry.exit_berth,
        entry.description,
        new Date(enteredMs - BOUNDARY_EXIT_LOOKBACK_MS),
        new Date(enteredMs + windowMs),
        new Date(enteredMs - windowMs),
      ],
    );
    // Still standing at the exit berth — decide once it has actually left.
    if (exits.some((x) => x.left_at === null)) continue;

    const linked: { leftAt: Date; link: OccupancyLink }[] = [];
    for (const exit of exits) {
      const link = await findOccupancyLink(client, { id: exit.id, enteredAt: exit.entered_at });
      if (link && exit.left_at) linked.push({ leftAt: exit.left_at, link });
    }
    if (linked.length === 0) continue; // Not matched on the exit side — nothing to carry.
    if (new Set(linked.map((x) => x.link.trainRunId)).size > 1) {
      summary.boundaryAmbiguous += 1;
      continue;
    }
    const { leftAt, link } = linked.reduce((a, b) => (b.leftAt > a.leftAt ? b : a));

    // Every unclaimed same-headcode arrival at the entry berth around that exit is a candidate.
    const { rows: counted } = await client.query<{ count: string }>(
      `select count(*)::text as count from berth_occupancy e
       where e.td_area = $1 and e.berth_code = $2 and e.description = $3
         and e.entered_at between $4 and $5
         and not exists (
           select 1 from berth_occupancy_run_link l
           where l.berth_occupancy_id = e.id and l.occupancy_entered_at = e.entered_at
         )`,
      [
        entry.entry_area,
        entry.entry_berth,
        entry.description,
        new Date(leftAt.getTime() - windowMs),
        new Date(leftAt.getTime() + windowMs),
      ],
    );
    const verdict = evaluateBoundaryCrossing({ candidateCount: Number(counted[0]?.count ?? 0) });
    if (verdict.status === "ambiguous") {
      summary.boundaryAmbiguous += 1;
      continue;
    }
    if (verdict.status !== "matched") continue;

    const entryRef: OccupancyRef = { id: entry.id, entered_at: entry.entered_at };
    if (!(await insertLink(client, entryRef, link.trainRunId, "boundary_correlated"))) continue;
    summary.boundaryLinks += 1;
    await propagateLinkForward(client, entryRef, link.trainRunId, summary);
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
 * (or where the exit side was never matched, so the boundary sweep has nothing to carry).
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
        matchConfidence: fresh.isSolidMatch ? "solid" : "weak",
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
        // Always "solid" in practice — the `!fresh.isSolidMatch` guard above already continued
        // past anything weak — but computed the same way as every other caller for consistency.
        matchConfidence: fresh.isSolidMatch ? "solid" : "weak",
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
  /** Reference instant for the boundary sweep's windows — tests pin it; the daemon omits it. */
  now?: Date;
  /** Boundary sweep re-check throttle (`createBoundaryCooldown`) — the daemon passes one long-lived
   * map; omitted, every entry is checked on every call. */
  boundaryCooldown?: Map<string, number> | null;
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
       where ingestion_sequence > $1 and message_type = 'CA'
       order by ingestion_sequence
       limit $2`,
      [lastSequence, batchSize],
    );
    if (batch.rows.length === 0) break;
    summary.batches += 1;
    summary.processedEvents += batch.rows.length;

    const caRows: CaStepRow[] = batch.rows
      .filter((r) => r.to_berth !== null)
      .map((r) => ({
        raw_event_normalized_at_utc: r.raw_event_normalized_at_utc,
        td_area: r.td_area,
        from_berth: r.from_berth,
        to_berth: r.to_berth as string,
        description: r.description,
      }));

    const upgradeCandidates: UpgradeCandidate[] = [];
    const client = await pool.connect();
    try {
      await client.query("begin");
      await processStepChainBatch(client, caRows, summary, eligibleAreas, upgradeCandidates);
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

  // After the step batches, so steps already ingested this tick are visible to the forward
  // propagation. Own connection, no transaction: each write is one idempotent insert, and an
  // entry left half-done is simply picked up again on a later tick.
  const boundaryClient = await pool.connect();
  try {
    await sweepBoundaryCrossings(
      boundaryClient,
      options.now ?? new Date(),
      options.boundaryCooldown ?? null,
      summary,
    );
  } finally {
    boundaryClient.release();
  }

  return summary;
}
