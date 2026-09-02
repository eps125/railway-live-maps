import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  getOrCreateProjectionDefinition,
  ensureCheckpoint,
  getCheckpoint,
  advanceCheckpoint,
} from "@railway/database";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import {
  berthChangesForEvent,
  buildDeltaMessages,
  type MapBinding,
} from "../mapProjector/deltaBuilder.js";
import type { DeltaPublisher } from "./deltaPublisher.js";

export type { DeltaPublisher } from "./deltaPublisher.js";

/**
 * The hot path (ADR 0003). Reads `raw_feed_event` (TD, C-Class, CA/CB/CC only) in tiny batches,
 * folds each batch to the final `description` per berth, writes `berth_current_state` in one bulk
 * upsert, and publishes the Redis deltas itself. Nothing else — no `td_berth_event`, no
 * `berth_occupancy`, no anomalies, no S-Class; those stay on the slower `project-td-daemon`.
 *
 * `berth_current_state` is written by both this projector and `project-td-daemon`, so every
 * upsert here carries the same monotonic guard (`excluded.source_ingestion_sequence >=
 * berth_current_state.source_ingestion_sequence`) and the rows are sorted by `(td_area,
 * berth_code)` for a deterministic lock order.
 */
export const TD_LIVE_PROJECTION_NAME = "td-live-berth-state";
export const TD_LIVE_PROJECTION_VERSION = 1;

const DEFAULT_BATCH_SIZE = 100;
const BINDINGS_TTL_MS = 10_000;

export interface RunProjectTdLiveOptions {
  batchSize?: number;
  /** Stop after this many batches even if more events wait (so the daemon ticks again promptly
   * rather than blocking on a large catch-up). Unset = drain fully. */
  maxBatches?: number;
  /** The binding cache to use. The daemon creates one and passes it every tick; omitting it
   * falls back to a module-level singleton. Tests pass a fresh one (`ttlMs: 0`) so the shared
   * singleton's TTL doesn't hide a just-published map. */
  bindings?: BindingsCache;
  /** Override the one-shot baseline fill run on a fresh checkpoint (defaults to
   * `seedFromHistory`). Tests inject a throwing stub to prove a failing fill can't wedge the
   * checkpoint. */
  seedBaseline?: (pool: Pool) => Promise<void>;
}

export interface ProjectTdLiveSummary {
  batches: number;
  processedEvents: number;
  berthsUpdated: number;
  deltasPublished: number;
  seeded: boolean;
}

/** One `raw_feed_event` C-Class row this projector consumes. */
export interface RawCClassRow {
  id: string;
  normalized_event_at_utc: Date;
  ingestion_sequence: string;
  event_type: "CA" | "CB" | "CC";
  td_area: string;
  raw_event_json: Record<string, unknown>;
}

/** The final state to write for one berth after folding a batch. */
export interface BerthStateWrite {
  tdArea: string;
  berth: string;
  description: string | null;
  eventAt: string;
  sourceEventId: string;
  sourceNormalizedAt: Date;
  sourceSeq: string;
}

function payload(row: RawCClassRow): { from?: unknown; to?: unknown; descr?: unknown } {
  const wrapped = row.raw_event_json[`${row.event_type}_MSG`];
  return typeof wrapped === "object" && wrapped !== null
    ? (wrapped as Record<string, unknown>)
    : {};
}

function berthStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Pure: fold a batch of CA/CB/CC rows (already in `ingestion_sequence` order) to the final
 * `description` per berth. Multiple changes to the same berth collapse to the last one — exactly
 * what `berth_current_state` should end up holding for that batch.
 */
export function foldLiveBerthState(rows: RawCClassRow[]): BerthStateWrite[] {
  const byBerth = new Map<string, BerthStateWrite>();
  for (const row of rows) {
    const p = payload(row);
    const changes = berthChangesForEvent({
      messageType: row.event_type,
      tdArea: row.td_area,
      fromBerth: row.event_type !== "CC" ? berthStr(p.from) : null,
      toBerth: row.event_type !== "CB" ? berthStr(p.to) : null,
      description: typeof p.descr === "string" ? p.descr : "",
      eventAt: row.normalized_event_at_utc.toISOString(),
    });
    for (const change of changes) {
      byBerth.set(`${change.tdArea} ${change.berth}`, {
        tdArea: change.tdArea,
        berth: change.berth,
        description: change.description,
        eventAt: change.eventAt,
        sourceEventId: row.id,
        sourceNormalizedAt: row.normalized_event_at_utc,
        sourceSeq: row.ingestion_sequence,
      });
    }
  }
  return [...byBerth.values()].sort((a, b) =>
    a.tdArea === b.tdArea ? a.berth.localeCompare(b.berth) : a.tdArea.localeCompare(b.tdArea),
  );
}

/** In-process cache of `td_berth` map bindings (they change only on map publish). */
export class BindingsCache {
  private byKey = new Map<string, MapBinding[]>();
  private loadedAt = 0;

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs = BINDINGS_TTL_MS,
  ) {}

  async get(tdArea: string, berth: string): Promise<MapBinding[]> {
    if (Date.now() - this.loadedAt > this.ttlMs) {
      await this.reload();
    }
    return this.byKey.get(`${tdArea} ${berth}`) ?? [];
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<{
      td_area: string;
      berth: string;
      mapSlug: string;
      elementId: string;
    }>(
      `select mbi.td_area, mbi.berth, m.slug as "mapSlug", mbi.element_id as "elementId"
       from map_binding_index mbi
       join map_version mv on mv.id = mbi.map_version_id
       join map m on m.id = mv.map_id
       where mbi.binding_type = 'td_berth' and mv.effective_to is null`,
    );
    const next = new Map<string, MapBinding[]>();
    for (const row of rows) {
      const key = `${row.td_area} ${row.berth}`;
      const list = next.get(key) ?? [];
      list.push({ mapSlug: row.mapSlug, elementId: row.elementId });
      next.set(key, list);
    }
    this.byKey = next;
    this.loadedAt = Date.now();
  }
}

let sharedBindings: BindingsCache | null = null;

async function seedFromHistory(pool: Pool): Promise<void> {
  // berth_current_state for a berth == its currently-open berth_occupancy row (or absent). The
  // history projector keeps berth_occupancy complete from raw_feed_event, so this is a safe
  // one-shot fill on a fresh live checkpoint. source_ingestion_sequence = 0 so the first real
  // event always wins the monotonic guard. `order by (td_area, berth_code)` matches the lock
  // order of both berth_current_state writers (bulkUpsertCurrentState here, applyEffects in
  // project-td) so this concurrent INSERT can't deadlock against them.
  await pool.query(
    `insert into berth_current_state (
       projection_version, td_area, berth_code, description, occupancy_id, occupancy_entered_at,
       event_at, source_event_id, source_event_normalized_at_utc, source_ingestion_sequence
     )
     select $1, o.td_area, o.berth_code, o.description, o.id, o.entered_at,
            o.entered_at, o.entry_event_id, o.entry_event_normalized_at_utc, 0
     from berth_occupancy o
     where o.projection_version = $1 and o.left_at is null
     order by o.td_area, o.berth_code
     on conflict (projection_version, td_area, berth_code) do nothing`,
    [TD_PROJECTION_VERSION],
  );
}

export async function bulkUpsertCurrentState(pool: Pool, writes: BerthStateWrite[]): Promise<void> {
  if (writes.length === 0) return;
  const params: unknown[] = [];
  const tuples = writes.map((w) => {
    const base = params.length;
    params.push(
      TD_PROJECTION_VERSION,
      w.tdArea,
      w.berth,
      w.description,
      w.description === null ? null : w.eventAt, // occupancy_entered_at
      w.eventAt,
      w.sourceEventId,
      w.sourceNormalizedAt,
      w.sourceSeq,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, null, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
  });
  await pool.query(
    `insert into berth_current_state (
       projection_version, td_area, berth_code, description, occupancy_id, occupancy_entered_at,
       event_at, source_event_id, source_event_normalized_at_utc, source_ingestion_sequence
     ) values ${tuples.join(", ")}
     on conflict (projection_version, td_area, berth_code) do update set
       description = excluded.description,
       occupancy_id = null,
       occupancy_entered_at = excluded.occupancy_entered_at,
       event_at = excluded.event_at,
       source_event_id = excluded.source_event_id,
       source_event_normalized_at_utc = excluded.source_event_normalized_at_utc,
       source_ingestion_sequence = excluded.source_ingestion_sequence,
       updated_at = now()
     where excluded.source_ingestion_sequence >= berth_current_state.source_ingestion_sequence`,
    params,
  );
}

/** Publish the deltas for a folded batch — one `railway:live:<slug>` message per (berth change ×
 * map that binds it), each through `publishDeltaIfNewer` so the two live publishers
 * (`projector-td-live` daemon + `ingest-td` inline path, ADR 0003 Tier 3) never double-send the
 * same berth step. Returns how many were actually published (a suppressed duplicate counts 0). */
export async function publishBerthDeltas(
  redis: DeltaPublisher,
  bindings: BindingsCache,
  writes: BerthStateWrite[],
): Promise<number> {
  let published = 0;
  for (const write of writes) {
    const bound = await bindings.get(write.tdArea, write.berth);
    if (bound.length === 0) continue;
    const sequence = Number(write.sourceSeq);
    const berthKey = `${write.tdArea} ${write.berth}`;
    const messages = buildDeltaMessages(
      {
        tdArea: write.tdArea,
        berth: write.berth,
        description: write.description,
        eventAt: write.eventAt,
      },
      bound,
      sequence,
    );
    for (const { mapSlug, message } of messages) {
      published += await redis.publishDeltaIfNewer(
        mapSlug,
        berthKey,
        sequence,
        JSON.stringify(message),
      );
    }
  }
  return published;
}

/**
 * ADR 0003 Tier 3 (Milestone 17) — the inline live path. `ingest-td` calls this immediately
 * after `recordFrame` has durably inserted a frame's children (so `berth_current_state`'s
 * `source_event_id` FK and the row lineage already resolve), passing those just-inserted rows.
 * It folds the CA/CB/CC rows to the final `description` per berth, writes `berth_current_state`
 * in one guarded bulk upsert, and publishes the Redis deltas — all within the same frame
 * handler, with no projector poll, tick, checkpoint round-trip, or nationwide re-scan in
 * between. `projector-td-live` stays running as the catch-up / `--rebuild` path (it fills any
 * gap from its own checkpoint if `ingest-td` restarts).
 *
 * Never throws for a caller who wraps it — but it does not swallow errors itself; `ingest-td`
 * catches so a live-path failure can't block ingestion or acks.
 */
export async function applyLiveFromEvents(
  pool: Pool,
  redis: DeltaPublisher | null,
  bindings: BindingsCache,
  rows: RawCClassRow[],
): Promise<{ berthsUpdated: number; deltasPublished: number }> {
  const cClass = rows.filter(
    (r) => r.event_type === "CA" || r.event_type === "CB" || r.event_type === "CC",
  );
  if (cClass.length === 0) return { berthsUpdated: 0, deltasPublished: 0 };

  // rows arrive in child order; foldLiveBerthState treats them as ingestion order (same thing
  // within one frame — child_index and ingestion_sequence are both monotonic here).
  const writes = foldLiveBerthState(cClass);
  await bulkUpsertCurrentState(pool, writes);
  const deltasPublished = redis ? await publishBerthDeltas(redis, bindings, writes) : 0;
  return { berthsUpdated: writes.length, deltasPublished };
}

export async function runProjectTdLive(
  pool: Pool,
  redis: DeltaPublisher | null,
  options: RunProjectTdLiveOptions = {},
): Promise<ProjectTdLiveSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const bindings = options.bindings ?? (sharedBindings ??= new BindingsCache(pool));

  const defId = await getOrCreateProjectionDefinition(
    pool,
    TD_LIVE_PROJECTION_NAME,
    TD_LIVE_PROJECTION_VERSION,
    createHash("sha256").update(`td-live-berth-state-v${TD_LIVE_PROJECTION_VERSION}`).digest("hex"),
  );
  await ensureCheckpoint(pool, defId);

  const summary: ProjectTdLiveSummary = {
    batches: 0,
    processedEvents: 0,
    berthsUpdated: 0,
    deltasPublished: 0,
    seeded: false,
  };

  const fresh = await getCheckpoint(pool, defId);
  if (fresh && fresh.lastIngestionSequence === "0" && fresh.lastCompletedAt === null) {
    // Start near HEAD: the live projector is a *second* writer of berth_current_state
    // (project-td-daemon is the other and keeps it complete), so it only needs a sane start
    // position, not a replay of all TD history. Advance the checkpoint FIRST and
    // unconditionally — a slow or failing baseline fill must never be able to pin the
    // checkpoint in its "fresh" state and wedge every subsequent tick (that regression: the
    // berth_occupancy seed had no left_at index and blew the 10s statement_timeout on every
    // tick, so the projector never processed an event or published a delta — migration 0026).
    const hist = await pool.query<{ seq: string | null }>(
      `select pc.last_ingestion_sequence::text as seq
       from projection_checkpoint pc
       join projection_definition pd on pd.id = pc.projection_definition_id
       where pd.name = 'td-berth-and-s-class'`,
    );
    await advanceCheckpoint(pool, defId, hist.rows[0]?.seq ?? "0");
    summary.seeded = true;

    // Best-effort: pre-fill berth_current_state for berths a train is already sitting in so the
    // map looks complete before those berths next step. project-td-daemon also maintains
    // berth_current_state, so the only cost of skipping this is those rows lagging until their
    // next CA/CB/CC. Never let it throw.
    try {
      await (options.seedBaseline ?? seedFromHistory)(pool);
    } catch (error) {
      console.warn(
        "project-td-live: berth_current_state baseline fill skipped (non-fatal) — rows will " +
          "populate as berths step or from project-td-daemon:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  for (;;) {
    const cp = await getCheckpoint(pool, defId);
    const since = cp?.lastIngestionSequence ?? "0";

    const { rows } = await pool.query<RawCClassRow>(
      `select id, normalized_event_at_utc, ingestion_sequence, event_type, td_area, raw_event_json
       from raw_feed_event
       where feed_name = 'TD' and message_class = 'C' and parse_status = 'parsed'
         and event_type in ('CA', 'CB', 'CC') and ingestion_sequence > $1
       order by ingestion_sequence
       limit $2`,
      [since, batchSize],
    );
    if (rows.length === 0) break;
    summary.batches += 1;
    summary.processedEvents += rows.length;

    const writes = foldLiveBerthState(rows);
    const maxSeq = rows.reduce(
      (max, row) => (BigInt(row.ingestion_sequence) > max ? BigInt(row.ingestion_sequence) : max),
      BigInt(since),
    );

    await bulkUpsertCurrentState(pool, writes);
    summary.berthsUpdated += writes.length;

    if (redis) {
      summary.deltasPublished += await publishBerthDeltas(redis, bindings, writes);
    }

    await advanceCheckpoint(pool, defId, maxSeq.toString());
    if (options.maxBatches !== undefined && summary.batches >= options.maxBatches) break;
  }

  return summary;
}
