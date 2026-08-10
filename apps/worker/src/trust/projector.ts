import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  getOrCreateProjectionDefinition,
  ensureCheckpoint,
  getCheckpoint,
  advanceCheckpoint,
  resetCheckpoint,
} from "@railway/database";
import {
  applyActivation,
  applyMovement,
  applyCancellation,
  applyReinstatement,
  applyChangeOfOrigin,
  applyChangeOfLocation,
  applyChangeOfIdentity,
  applyUnidentified,
  computeServiceDate,
  selectEffectiveSchedule,
  TRUST_NORMALIZATION_VERSION,
  TRUST_PROJECTION_NAME,
  TRUST_PROJECTION_VERSION,
  type TrainRunSnapshot,
  type TrustRunEffect,
  type ScheduleCandidate,
} from "@railway/domain";

export { TRUST_PROJECTION_NAME, TRUST_PROJECTION_VERSION };

const DEFAULT_BATCH_SIZE = 500;

export interface ProjectTrustOptions {
  batchSize?: number;
  /** Clears this projection version's train_run/train_run_event/run_schedule_link rows and
   * reprocesses from ingestion_sequence 0. */
  rebuild?: boolean;
}

export interface ProjectTrustSummary {
  batches: number;
  processedEvents: number;
  runsCreated: number;
  runsUpdated: number;
  eventsAttached: number;
  skippedNoMatchingRun: number;
  activationsLinked: number;
  deferredLinksResolved: number;
}

interface RawTrustRow {
  id: string;
  normalized_event_at_utc: Date;
  ingestion_sequence: string;
  event_type: string;
  raw_event_json: { header?: unknown; body?: unknown };
  parse_status: string;
}

function computeConfigHash(): string {
  return createHash("sha256")
    .update(`trust-projection-v${TRUST_PROJECTION_VERSION}-norm-v${TRUST_NORMALIZATION_VERSION}`)
    .digest("hex");
}

async function clearProjectionRows(pool: Pool): Promise<void> {
  await pool.query("delete from run_schedule_link");
  await pool.query("delete from train_run_event");
  await pool.query("delete from train_run");
}

async function findRunByIdentity(
  client: PoolClient,
  trustTrainId: string,
  serviceDate: string,
): Promise<TrainRunSnapshot | null> {
  const result = await client.query<{
    id: string;
    lifecycle_state: TrainRunSnapshot["lifecycleState"];
  }>(`select id, lifecycle_state from train_run where trust_train_id = $1 and service_date = $2`, [
    trustTrainId,
    serviceDate,
  ]);
  const row = result.rows[0];
  return row ? { id: row.id, lifecycleState: row.lifecycle_state } : null;
}

interface OldIdentityRow {
  id: string;
  lifecycle_state: TrainRunSnapshot["lifecycleState"];
  signalling_id: string | null;
  operator_code: string | null;
  service_code: string | null;
}

async function findOldIdentityRow(
  client: PoolClient,
  trustTrainId: string,
  serviceDate: string,
): Promise<OldIdentityRow | null> {
  const result = await client.query<OldIdentityRow>(
    `select id, lifecycle_state, signalling_id, operator_code, service_code
     from train_run where trust_train_id = $1 and service_date = $2`,
    [trustTrainId, serviceDate],
  );
  return result.rows[0] ?? null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Applies the reducer's effects, returning the id of the run this message is ultimately
 * associated with (for the train_run_event FK), or null if nothing was created/found. */
async function applyEffects(
  client: PoolClient,
  effects: TrustRunEffect[],
  summary: ProjectTrustSummary,
): Promise<string | null> {
  let associatedRunId: string | null = null;

  for (const effect of effects) {
    if (effect.kind === "createRun") {
      const inserted = await client.query<{ id: string }>(
        `insert into train_run (
           trust_train_id, service_date, signalling_id, activated_at, origin_departure_at,
           call_type, call_mode, operator_code, service_code, lifecycle_state, last_event_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning id`,
        [
          effect.trustTrainId,
          effect.serviceDate,
          effect.signallingId,
          effect.activatedAt,
          effect.originDepartureAt,
          effect.callType,
          effect.callMode,
          effect.operatorCode,
          effect.serviceCode,
          effect.lifecycleState,
          effect.lastEventAt,
        ],
      );
      const id = inserted.rows[0]?.id;
      if (!id) throw new Error("Expected train_run insert to return an id");
      associatedRunId = id;
      summary.runsCreated += 1;
    } else if (effect.kind === "setLifecycleState") {
      await client.query(
        `update train_run set lifecycle_state = $2, last_event_at = $3, updated_at = now()
         where id = $1`,
        [effect.runId, effect.lifecycleState, effect.lastEventAt],
      );
      associatedRunId = effect.runId;
      summary.runsUpdated += 1;
    } else if (effect.kind === "touchLastEventAt") {
      await client.query(
        `update train_run set last_event_at = $2, updated_at = now() where id = $1`,
        [effect.runId, effect.lastEventAt],
      );
      associatedRunId = effect.runId;
      summary.runsUpdated += 1;
    } else {
      // supersedeWithNewIdentity
      const inserted = await client.query<{ id: string }>(
        `insert into train_run (
           trust_train_id, service_date, signalling_id, operator_code, service_code,
           lifecycle_state, last_event_at
         ) values ($1,$2,$3,$4,$5,'activated',$6)
         returning id`,
        [
          effect.newTrustTrainId,
          effect.serviceDate,
          effect.signallingId,
          effect.operatorCode,
          effect.serviceCode,
          effect.lastEventAt,
        ],
      );
      const newRunId = inserted.rows[0]?.id;
      if (!newRunId) throw new Error("Expected train_run insert to return an id");
      await client.query(
        `update train_run
         set lifecycle_state = 'superseded', superseded_by_train_run_id = $2,
             last_event_at = $3, updated_at = now()
         where id = $1`,
        [effect.oldRunId, newRunId, effect.lastEventAt],
      );
      associatedRunId = newRunId;
      summary.runsCreated += 1;
      summary.runsUpdated += 1;
    }
  }

  return associatedRunId;
}

interface ResolvedSchedule {
  scheduleId: string | null;
  matchOutcome: "matched" | "ambiguous" | "unmatched";
}

async function resolveScheduleForTrainUid(
  client: Pick<PoolClient, "query">,
  trainUid: string | null,
  serviceDate: string,
): Promise<ResolvedSchedule> {
  if (!trainUid) {
    return { scheduleId: null, matchOutcome: "unmatched" };
  }

  const rows = await client.query<{
    id: string;
    stp_indicator: ScheduleCandidate["stpIndicator"];
    schedule_start_date: string;
    schedule_end_date: string;
    days_runs_bitmask: string | null;
  }>(
    `select id, stp_indicator, schedule_start_date::text as schedule_start_date,
            schedule_end_date::text as schedule_end_date, days_runs_bitmask
     from schedule where train_uid = $1`,
    [trainUid],
  );
  const candidates = rows.rows.map((row) => ({
    stpIndicator: row.stp_indicator,
    scheduleStartDate: row.schedule_start_date,
    scheduleEndDate: row.schedule_end_date,
    daysRunsBitmask: row.days_runs_bitmask,
    id: row.id,
  }));
  const outcome = selectEffectiveSchedule(candidates, serviceDate);
  if (outcome.outcome === "matched") {
    return { scheduleId: outcome.selected.id, matchOutcome: "matched" };
  }
  if (outcome.outcome === "ambiguous") {
    return { scheduleId: null, matchOutcome: "ambiguous" };
  }
  return { scheduleId: null, matchOutcome: "unmatched" };
}

/** Resolves and inserts the activation's `run_schedule_link` row — deliberately not a reducer
 * effect, since it needs a DB round trip against `schedule` (STP precedence resolution). */
async function linkActivationToSchedule(
  client: PoolClient,
  runId: string,
  trainUid: string | null,
  serviceDate: string,
  activationAt: string,
  signallingId: string | null,
  operatorCode: string | null,
  serviceCode: string | null,
): Promise<void> {
  const { scheduleId, matchOutcome } = await resolveScheduleForTrainUid(
    client,
    trainUid,
    serviceDate,
  );

  await client.query(
    `insert into run_schedule_link (
       train_run_id, activation_train_uid, activation_signalling_id, activation_operator_code,
       activation_service_code, activation_at, schedule_id, match_outcome
     ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      runId,
      trainUid,
      signallingId,
      operatorCode,
      serviceCode,
      activationAt,
      scheduleId,
      matchOutcome,
    ],
  );

  if (scheduleId) {
    await client.query(`update train_run set schedule_id = $2 where id = $1`, [runId, scheduleId]);
  }
}

/** Caps how much of the deferred-relink backlog one project-trust invocation retries. Without
 * this, a large backlog (confirmed 2026-08-10: ~23,000+ rows after the first real SCHEDULE
 * import) makes this single query+loop take minutes — and since the Portainer `projector`
 * service's loop runs project-td/vstp/trust/resolver strictly sequentially, that blocked
 * project-td from running at all, stalling the live map for 8+ minutes. Same fix shape as
 * project-resolver's own MAX_BATCHES_PER_RUN cap (apps/worker/src/resolver/projector.ts).
 * `order by random()` rather than a fixed order (e.g. id) so a row that can never resolve
 * (no matching schedule exists) doesn't permanently starve the rest of the backlog from ever
 * being retried — every row gets a roughly fair chance across many rapid cycles instead. */
const MAX_DEFERRED_LINKS_PER_RUN = 300;

/** Re-attempts resolution for a bounded slice of `run_schedule_link` rows that aren't `matched`
 * yet — a later SCHEDULE/VSTP import may resolve a schedule that was missing at activation
 * time. Updates the existing row in place, never re-inserts (docs/DATA_MODEL.md §7). */
async function resolveDeferredLinks(pool: Pool, summary: ProjectTrustSummary): Promise<void> {
  const outstanding = await pool.query<{
    id: string;
    train_run_id: string;
    activation_train_uid: string | null;
    service_date: string;
  }>(
    `select rsl.id, rsl.train_run_id, rsl.activation_train_uid, tr.service_date::text as service_date
     from run_schedule_link rsl
     join train_run tr on tr.id = rsl.train_run_id
     where rsl.match_outcome != 'matched'
     order by random()
     limit ${MAX_DEFERRED_LINKS_PER_RUN}`,
  );

  for (const link of outstanding.rows) {
    const { scheduleId, matchOutcome } = await resolveScheduleForTrainUid(
      pool,
      link.activation_train_uid,
      link.service_date,
    );
    if (matchOutcome !== "matched") {
      continue;
    }

    await pool.query(
      `update run_schedule_link set schedule_id = $2, match_outcome = 'matched', resolved_at = now()
       where id = $1`,
      [link.id, scheduleId],
    );
    await pool.query(`update train_run set schedule_id = $2 where id = $1`, [
      link.train_run_id,
      scheduleId,
    ]);
    summary.deferredLinksResolved += 1;
  }
}

interface ExtractedIdentity {
  trustTrainId: string | null;
  oldTrustTrainId?: string | null;
  newTrustTrainId?: string | null;
  trainUid?: string | null;
  signallingId?: string | null;
  callType?: string | null;
  callMode?: string | null;
  operatorCode?: string | null;
  serviceCode?: string | null;
}

/**
 * Fixed in production (2026-08-09): `signallingId` was read from the activation body's
 * `schedule_wtt_id` field, which this project's own fixture assumed was a plain 4-character TD
 * headcode (packages/feed-parsers/fixtures/trust/activation.json's wire shape was "constructed
 * from public documentation, not a captured real message" — exactly the gap that caveat warns
 * about). The real field turned out to be 5 characters with an unconfirmed trailing character,
 * so `train_run.signalling_id` never matched a real `berth_occupancy.description` (always
 * exactly 4 characters) — every resolver candidate lookup silently found nothing.
 *
 * Per Network Rail's documented `train_id` format — `AABBBBCDEE`: `AA` = first two digits of the
 * origin STANOX, `BBBB` = the signalling ID/headcode used across the data feeds, `C` = TSPEED,
 * `D` = Call Code, `EE` = day of month originated — `train_id` (always exactly 10 characters,
 * already the authoritative identity field used everywhere else) is a reliable, documented
 * source for the headcode. Deriving it from there instead removes the dependency on
 * `schedule_wtt_id`'s unconfirmed exact shape entirely.
 *
 * Every `train_run.signalling_id` stored before this fix is wrong; run `project-trust --rebuild`
 * after deploying this, then `project-resolver --rebuild` to re-attempt matching.
 */
function headcodeFromTrainId(trainId: string | null): string | null {
  return trainId && trainId.length === 10 ? trainId.slice(2, 6) : null;
}

function extractIdentity(eventType: string, body: Record<string, unknown>): ExtractedIdentity {
  switch (eventType) {
    case "activation": {
      const trustTrainId = str(body.train_id);
      return {
        trustTrainId,
        trainUid: str(body.train_uid),
        signallingId: headcodeFromTrainId(trustTrainId),
        callType: str(body.train_call_type),
        callMode: str(body.train_call_mode),
        operatorCode: str(body.toc_id),
        serviceCode: str(body.train_service_code),
      };
    }
    case "movement":
      return { trustTrainId: str(body.train_id) ?? str(body.current_train_id) };
    case "unidentified":
      return { trustTrainId: str(body.train_id) };
    case "change_of_identity": {
      const trainInfo = (body.train_info as Record<string, unknown> | undefined) ?? {};
      return {
        trustTrainId: null,
        oldTrustTrainId: str(trainInfo.train_id) ?? str(body.current_train_id),
        newTrustTrainId: str(body.revised_train_id),
      };
    }
    default: {
      // cancellation / reinstatement / change_of_origin / change_of_location all carry the
      // identity under a nested train_info object.
      const trainInfo = (body.train_info as Record<string, unknown> | undefined) ?? {};
      return { trustTrainId: str(trainInfo.train_id) };
    }
  }
}

async function projectRow(
  client: PoolClient,
  row: RawTrustRow,
  summary: ProjectTrustSummary,
): Promise<void> {
  const alreadyProcessed = await client.query<{ id: string }>(
    `select id from train_run_event where raw_event_id = $1 and raw_event_normalized_at_utc = $2`,
    [row.id, row.normalized_event_at_utc],
  );
  if (alreadyProcessed.rows.length > 0) {
    return;
  }

  const body = (row.raw_event_json.body as Record<string, unknown> | undefined) ?? {};
  const eventAt = row.normalized_event_at_utc.toISOString();
  const identity = extractIdentity(row.event_type, body);

  let effects: TrustRunEffect[] = [];
  let activationContext: {
    trainUid: string | null;
    signallingId: string | null;
    operatorCode: string | null;
    serviceCode: string | null;
  } | null = null;

  if (row.event_type === "activation") {
    if (!identity.trustTrainId) return;
    const serviceDate = computeServiceDate(eventAt);
    const existingRun = await findRunByIdentity(client, identity.trustTrainId, serviceDate);
    effects = applyActivation({
      trustTrainId: identity.trustTrainId,
      serviceDate,
      signallingId: identity.signallingId ?? null,
      activatedAt: eventAt,
      originDepartureAt: null,
      callType: identity.callType ?? null,
      callMode: identity.callMode ?? null,
      operatorCode: identity.operatorCode ?? null,
      serviceCode: identity.serviceCode ?? null,
      existingRun,
    }).effects;
    if (!existingRun) {
      activationContext = {
        trainUid: identity.trainUid ?? null,
        signallingId: identity.signallingId ?? null,
        operatorCode: identity.operatorCode ?? null,
        serviceCode: identity.serviceCode ?? null,
      };
    }
  } else if (row.event_type === "movement") {
    if (!identity.trustTrainId) return;
    const serviceDate = computeServiceDate(eventAt);
    const run = await findRunByIdentity(client, identity.trustTrainId, serviceDate);
    effects = applyMovement({ run, eventAt }).effects;
    if (!run) summary.skippedNoMatchingRun += 1;
  } else if (row.event_type === "cancellation") {
    if (!identity.trustTrainId) return;
    const serviceDate = computeServiceDate(eventAt);
    const run = await findRunByIdentity(client, identity.trustTrainId, serviceDate);
    effects = applyCancellation({ run, eventAt }).effects;
    if (!run) summary.skippedNoMatchingRun += 1;
  } else if (row.event_type === "reinstatement") {
    if (!identity.trustTrainId) return;
    const serviceDate = computeServiceDate(eventAt);
    const run = await findRunByIdentity(client, identity.trustTrainId, serviceDate);
    effects = applyReinstatement({ run, eventAt }).effects;
    if (!run) summary.skippedNoMatchingRun += 1;
  } else if (row.event_type === "change_of_origin") {
    if (!identity.trustTrainId) return;
    const serviceDate = computeServiceDate(eventAt);
    const run = await findRunByIdentity(client, identity.trustTrainId, serviceDate);
    effects = applyChangeOfOrigin({ run, eventAt }).effects;
    if (!run) summary.skippedNoMatchingRun += 1;
  } else if (row.event_type === "change_of_location") {
    if (!identity.trustTrainId) return;
    const serviceDate = computeServiceDate(eventAt);
    const run = await findRunByIdentity(client, identity.trustTrainId, serviceDate);
    effects = applyChangeOfLocation({ run, eventAt }).effects;
    if (!run) summary.skippedNoMatchingRun += 1;
  } else if (row.event_type === "change_of_identity") {
    if (!identity.oldTrustTrainId || !identity.newTrustTrainId) return;
    const serviceDate = computeServiceDate(eventAt);
    const oldRow = await findOldIdentityRow(client, identity.oldTrustTrainId, serviceDate);
    effects = applyChangeOfIdentity({
      oldRun: oldRow ? { id: oldRow.id, lifecycleState: oldRow.lifecycle_state } : null,
      newTrustTrainId: identity.newTrustTrainId,
      serviceDate,
      signallingId: oldRow?.signalling_id ?? null,
      operatorCode: oldRow?.operator_code ?? null,
      serviceCode: oldRow?.service_code ?? null,
      eventAt,
    }).effects;
    if (!oldRow) summary.skippedNoMatchingRun += 1;
  } else if (row.event_type === "unidentified") {
    if (!identity.trustTrainId) return;
    const serviceDate = computeServiceDate(eventAt);
    const existingRun = await findRunByIdentity(client, identity.trustTrainId, serviceDate);
    effects = applyUnidentified({
      trustTrainId: identity.trustTrainId,
      serviceDate,
      existingRun,
      eventAt,
    }).effects;
  } else {
    // unsupported msg_type — nothing to project; already durably retained in raw_feed_event.
    return;
  }

  const associatedRunId = await applyEffects(client, effects, summary);
  if (!associatedRunId) {
    return;
  }

  await client.query(
    `insert into train_run_event (
       train_run_id, raw_event_id, raw_event_normalized_at_utc, trust_message_type, event_at,
       ingestion_sequence, normalization_version, raw_event_json
     ) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      associatedRunId,
      row.id,
      row.normalized_event_at_utc,
      row.event_type,
      row.normalized_event_at_utc,
      row.ingestion_sequence,
      TRUST_NORMALIZATION_VERSION,
      JSON.stringify(row.raw_event_json),
    ],
  );
  summary.eventsAttached += 1;

  if (activationContext) {
    await linkActivationToSchedule(
      client,
      associatedRunId,
      activationContext.trainUid,
      computeServiceDate(eventAt),
      eventAt,
      activationContext.signallingId,
      activationContext.operatorCode,
      activationContext.serviceCode,
    );
    summary.activationsLinked += 1;
  }
}

/**
 * Projects nationwide TRUST events into `train_run`/`train_run_event`/`run_schedule_link`
 * (docs/IMPLEMENTATION_PLAN.md Milestone 8). Processes strictly in `ingestion_sequence` order,
 * same checkpointed-batch-transaction shape as `td/projector.ts`/`vstp/projector.ts`.
 */
export async function runProjectTrust(
  pool: Pool,
  options: ProjectTrustOptions = {},
): Promise<ProjectTrustSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const definitionId = await getOrCreateProjectionDefinition(
    pool,
    TRUST_PROJECTION_NAME,
    TRUST_PROJECTION_VERSION,
    computeConfigHash(),
  );
  await ensureCheckpoint(pool, definitionId);

  if (options.rebuild) {
    await clearProjectionRows(pool);
    await resetCheckpoint(pool, definitionId);
  }

  const summary: ProjectTrustSummary = {
    batches: 0,
    processedEvents: 0,
    runsCreated: 0,
    runsUpdated: 0,
    eventsAttached: 0,
    skippedNoMatchingRun: 0,
    activationsLinked: 0,
    deferredLinksResolved: 0,
  };

  for (;;) {
    const checkpoint = await getCheckpoint(pool, definitionId);
    const lastSequence = checkpoint?.lastIngestionSequence ?? "0";

    const batch = await pool.query<RawTrustRow>(
      `select id, normalized_event_at_utc, ingestion_sequence, event_type, raw_event_json, parse_status
       from raw_feed_event
       where feed_name = 'TRUST' and ingestion_sequence > $1
       order by ingestion_sequence
       limit $2`,
      [lastSequence, batchSize],
    );
    if (batch.rows.length === 0) {
      break;
    }
    summary.batches += 1;

    const client = await pool.connect();
    try {
      await client.query("begin");
      let maxSequence = BigInt(lastSequence);

      for (const row of batch.rows) {
        summary.processedEvents += 1;
        const rowSequence = BigInt(row.ingestion_sequence);
        if (rowSequence > maxSequence) {
          maxSequence = rowSequence;
        }

        if (row.parse_status !== "parsed") {
          continue;
        }
        await projectRow(client, row, summary);
      }

      await advanceCheckpoint(client, definitionId, maxSequence.toString());
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  await resolveDeferredLinks(pool, summary);

  return summary;
}
