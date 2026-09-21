import { createHash } from "node:crypto";
import type { Pool } from "pg";
import {
  getOrCreateProjectionDefinition,
  ensureCheckpoint,
  getCheckpoint,
  advanceCheckpoint,
} from "@railway/database";
import {
  TD_PROJECTION_VERSION,
  TD_S_STATE_PROJECTION_VERSION,
  decodeSClassPayload,
  inferredBarrierState,
  detectReceiveSilences,
  barrierActiveMeansAsSignal,
  barrierStateFromSignalState,
  signalStateForBit,
  type BarrierDisplayState,
  type ReceivedRow,
  type SignalDisplayState,
} from "@railway/domain";
import type {
  CrossingUpdatedMessage,
  ResyncRequiredMessage,
  SignalUpdatedMessage,
} from "@railway/protocol";
import {
  berthChangesForEvent,
  buildDeltaMessages,
  type MapBinding,
} from "../mapProjector/deltaBuilder.js";
import { computeCombinedOverrides } from "../mapProjector/combinedBerthOverrides.js";
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

/** A `td_berth` map binding plus its `mapVersionId` — needed (not just `mapSlug`/`elementId`) so
 * `computeCombinedOverrides` can look up an element's other combined-berth members within the
 * same, exact map version. */
export type CachedMapBinding = MapBinding & { mapVersionId: string };

/** A `td_s_bit` map binding (Milestone 36b), keyed in the cache by `"<tdArea> <address>"`. */
export interface CachedSignalBinding {
  mapSlug: string;
  elementId: string;
  bit: number;
  /** Null for a binding published before `active_means` was recorded — renders blank. */
  activeMeans: "on" | "off" | null;
}

/** A `td_s_bit_barrier` map binding (Milestone 55 / ADR 0014), keyed the same way. Its
 * `activeMeans` speaks the barrier's own vocabulary; the delta builder converts it. */
export interface CachedBarrierBinding {
  mapSlug: string;
  elementId: string;
  bit: number;
  activeMeans: "up" | "down" | null;
}

/** Milestone 59 / ADR 0015: one input signal of an inferred crossing (a
 * `td_s_bit_barrier_input` row). `elementId` is the crossing; `activeMeans` is in the signal's
 * vocabulary. A crossing's full input list is every row sharing its `mapSlug` + `elementId`. */
export interface CachedInferredInput {
  mapSlug: string;
  elementId: string;
  tdArea: string;
  address: string;
  bit: number;
  activeMeans: "on" | "off" | null;
}

/** In-process cache of `td_berth` and `td_s_bit` map bindings (they change only on map
 * publish). */
export class BindingsCache {
  private byKey = new Map<string, CachedMapBinding[]>();
  private signalsByKey = new Map<string, CachedSignalBinding[]>();
  private barriersByKey = new Map<string, CachedBarrierBinding[]>();
  private inputsByKey = new Map<string, CachedInferredInput[]>();
  private inputsByCrossing = new Map<string, CachedInferredInput[]>();
  /** Each inferred input byte's value from `td_s_current_state` at the last reload — the fallback
   * for an input this process hasn't yet seen live, so a restart doesn't leave a crossing unknown
   * until its signals' bytes are next restated (areas refresh only every ~2 hours). */
  private seededInputBytes = new Map<string, number>();
  private signalSlugs: string[] = [];
  private loadedAt = 0;

  constructor(
    private readonly pool: Pool,
    private readonly ttlMs = BINDINGS_TTL_MS,
  ) {}

  async get(tdArea: string, berth: string): Promise<CachedMapBinding[]> {
    if (Date.now() - this.loadedAt > this.ttlMs) {
      await this.reload();
    }
    return this.byKey.get(`${tdArea} ${berth}`) ?? [];
  }

  /** Signal bindings on the S-Class byte `(tdArea, address)` across every open map version. */
  async getSignals(tdArea: string, address: string): Promise<CachedSignalBinding[]> {
    if (Date.now() - this.loadedAt > this.ttlMs) {
      await this.reload();
    }
    return this.signalsByKey.get(`${tdArea} ${address}`) ?? [];
  }

  /** Barrier bindings on the S-Class byte `(tdArea, address)` across every open map version. */
  async getBarriers(tdArea: string, address: string): Promise<CachedBarrierBinding[]> {
    if (Date.now() - this.loadedAt > this.ttlMs) {
      await this.reload();
    }
    return this.barriersByKey.get(`${tdArea} ${address}`) ?? [];
  }

  /** Inferred-crossing inputs on the S-Class byte `(tdArea, address)` across every open map. */
  async getInferredInputs(tdArea: string, address: string): Promise<CachedInferredInput[]> {
    if (Date.now() - this.loadedAt > this.ttlMs) {
      await this.reload();
    }
    return this.inputsByKey.get(`${tdArea} ${address}`) ?? [];
  }

  /** Every input of one inferred crossing (valid after any `getInferredInputs` call). */
  inferredCrossingInputs(mapSlug: string, elementId: string): CachedInferredInput[] {
    return this.inputsByCrossing.get(`${mapSlug}|${elementId}`) ?? [];
  }

  /** An inferred input byte's value as stored at the last reload, if it was known. */
  seededInputByte(tdArea: string, address: string): number | undefined {
    return this.seededInputBytes.get(`${tdArea} ${address}`);
  }

  /** Slugs of every open map version with at least one signal or barrier binding. */
  async signalMapSlugs(): Promise<string[]> {
    if (Date.now() - this.loadedAt > this.ttlMs) {
      await this.reload();
    }
    return this.signalSlugs;
  }

  private async reload(): Promise<void> {
    const { rows } = await this.pool.query<{
      td_area: string;
      berth: string;
      mapSlug: string;
      elementId: string;
      mapVersionId: string;
    }>(
      `select mbi.td_area, mbi.berth, m.slug as "mapSlug", mbi.element_id as "elementId",
              mv.id as "mapVersionId"
       from map_binding_index mbi
       join map_version mv on mv.id = mbi.map_version_id
       join map m on m.id = mv.map_id
       where mbi.binding_type = 'td_berth' and mv.effective_to is null`,
    );
    const next = new Map<string, CachedMapBinding[]>();
    for (const row of rows) {
      const key = `${row.td_area} ${row.berth}`;
      const list = next.get(key) ?? [];
      list.push({ mapSlug: row.mapSlug, elementId: row.elementId, mapVersionId: row.mapVersionId });
      next.set(key, list);
    }
    this.byKey = next;

    const signalRows = await this.pool.query<{
      td_area: string;
      address: string;
      /** `map_binding_index.bit` is a text column (migration 0010) — coerced where it is read. */
      bit: string;
      active_means: "on" | "off" | "up" | "down" | null;
      binding_type: "td_s_bit" | "td_s_bit_barrier" | "td_s_bit_barrier_input";
      mapSlug: string;
      elementId: string;
    }>(
      `select mbi.td_area, mbi.address, mbi.bit, mbi.active_means, mbi.binding_type,
              m.slug as "mapSlug", mbi.element_id as "elementId"
       from map_binding_index mbi
       join map_version mv on mv.id = mbi.map_version_id
       join map m on m.id = mv.map_id
       where mbi.binding_type in ('td_s_bit', 'td_s_bit_barrier', 'td_s_bit_barrier_input')
         and mv.effective_to is null`,
    );
    const nextSignals = new Map<string, CachedSignalBinding[]>();
    const nextBarriers = new Map<string, CachedBarrierBinding[]>();
    const nextInputs = new Map<string, CachedInferredInput[]>();
    const nextInputsByCrossing = new Map<string, CachedInferredInput[]>();
    const slugs = new Set<string>();
    for (const row of signalRows.rows) {
      const key = `${row.td_area} ${row.address}`;
      if (row.binding_type === "td_s_bit_barrier_input") {
        const input: CachedInferredInput = {
          mapSlug: row.mapSlug,
          elementId: row.elementId,
          tdArea: row.td_area,
          address: row.address,
          bit: Number(row.bit),
          activeMeans:
            row.active_means === "on" || row.active_means === "off" ? row.active_means : null,
        };
        nextInputs.set(key, [...(nextInputs.get(key) ?? []), input]);
        const crossingKey = `${row.mapSlug}|${row.elementId}`;
        nextInputsByCrossing.set(crossingKey, [
          ...(nextInputsByCrossing.get(crossingKey) ?? []),
          input,
        ]);
        slugs.add(row.mapSlug);
        continue;
      }
      // One query, two caches: the check constraint in migration 0039 guarantees the
      // active_means vocabulary matches the binding_type, so the split is exact.
      if (row.binding_type === "td_s_bit_barrier") {
        const list = nextBarriers.get(key) ?? [];
        list.push({
          mapSlug: row.mapSlug,
          elementId: row.elementId,
          bit: Number(row.bit),
          activeMeans:
            row.active_means === "up" || row.active_means === "down" ? row.active_means : null,
        });
        nextBarriers.set(key, list);
      } else {
        const list = nextSignals.get(key) ?? [];
        list.push({
          mapSlug: row.mapSlug,
          elementId: row.elementId,
          bit: Number(row.bit),
          activeMeans:
            row.active_means === "on" || row.active_means === "off" ? row.active_means : null,
        });
        nextSignals.set(key, list);
      }
      slugs.add(row.mapSlug);
    }
    this.signalsByKey = nextSignals;
    this.barriersByKey = nextBarriers;
    this.inputsByKey = nextInputs;
    this.inputsByCrossing = nextInputsByCrossing;

    const nextSeeded = new Map<string, number>();
    if (nextInputs.size > 0) {
      const wanted = [...nextInputs.keys()].map((key) => key.split(" "));
      const seeded = await this.pool.query<{
        td_area: string;
        address: string;
        byte_value: number;
      }>(
        `select s.td_area, s.address, s.byte_value
         from td_s_current_state s
         join unnest($2::text[], $3::text[]) as k(td_area, address)
           on s.td_area = k.td_area and s.address = k.address
         where s.projection_version = $1 and s.byte_value is not null`,
        [TD_S_STATE_PROJECTION_VERSION, wanted.map((k) => k[0]), wanted.map((k) => k[1])],
      );
      for (const row of seeded.rows)
        nextSeeded.set(`${row.td_area} ${row.address}`, row.byte_value);
    }
    this.seededInputBytes = nextSeeded;
    this.signalSlugs = [...slugs];
    this.loadedAt = Date.now();
  }
}

/** One S-Class `raw_feed_event` row the live publishers consume (Milestone 36b). */
export interface RawSClassRow {
  id: string;
  normalized_event_at_utc: Date;
  ingestion_sequence: string;
  event_type: string;
  td_area: string;
  raw_event_json: Record<string, unknown>;
}

/** Last signal state this process published (or saw published) per `"<slug>|<elementId>"` — so
 * a byte restated without its bound bit changing (every refresh, and any SF for a neighbouring
 * bit) doesn't re-send it. Per process; a restart just re-sends each signal's state once, which
 * is harmless (deltas carry absolute state). */
const lastSignalState = new Map<string, SignalDisplayState>();

/** The same per-process de-duplication for barrier positions (Milestone 55 / ADR 0014), shared
 * by direct and inferred crossings — a crossing has one source, so its key never collides. */
const lastBarrierState = new Map<string, BarrierDisplayState>();

/** Milestone 59 / ADR 0015: each inferred input's last state seen live by this process, keyed
 * per crossing and bit. An input missing here falls back to the byte seeded at cache reload. */
const lastInferredInputState = new Map<string, SignalDisplayState>();

function inferredInputKey(input: CachedInferredInput): string {
  return `${input.mapSlug}|${input.elementId}|${input.tdArea}|${input.address}|${input.bit}`;
}

/**
 * Milestone 36b (docs/adr/0013): `signal.updated` for every bound signal whose state an S-Class
 * row changes. The state is only ever the bound bit read through the binding's `activeMeans`
 * (CLAUDE.md rules 9/10). Keyed per bit for `publishDeltaIfNewer`, so the two live publishers
 * never double-send.
 */
export async function buildSignalDeltas(
  bindings: BindingsCache,
  rows: RawSClassRow[],
): Promise<PendingDelta[]> {
  const pending: PendingDelta[] = [];
  for (const row of rows) {
    const wrapped = row.raw_event_json[row.event_type];
    const payload =
      typeof wrapped === "object" && wrapped !== null ? (wrapped as Record<string, unknown>) : {};
    const decoded = decodeSClassPayload(row.event_type, payload.address, payload.data);
    if (!decoded.ok) continue;
    const sequence = Number(row.ingestion_sequence);
    // Inferred crossings this row touched, with the input that triggered each (Milestone 59).
    const touched = new Map<string, { input: CachedInferredInput; address: string }>();
    for (const byte of decoded.bytes) {
      for (const input of await bindings.getInferredInputs(row.td_area, byte.address)) {
        lastInferredInputState.set(
          inferredInputKey(input),
          signalStateForBit(byte.value, input.bit, input.activeMeans ?? undefined),
        );
        touched.set(`${input.mapSlug}|${input.elementId}`, { input, address: byte.address });
      }

      for (const binding of await bindings.getSignals(row.td_area, byte.address)) {
        const state = signalStateForBit(byte.value, binding.bit, binding.activeMeans ?? undefined);
        const memoryKey = `${binding.mapSlug}|${binding.elementId}`;
        if (lastSignalState.get(memoryKey) === state) continue;
        lastSignalState.set(memoryKey, state);
        const message: SignalUpdatedMessage = {
          type: "signal.updated",
          sequence,
          eventAt: row.normalized_event_at_utc.toISOString(),
          elementId: binding.elementId,
          state,
          tdArea: row.td_area,
          address: byte.address,
          bit: binding.bit,
        };
        pending.push({
          mapSlug: binding.mapSlug,
          key: `S ${row.td_area} ${byte.address} ${binding.bit}`,
          sequence,
          message: JSON.stringify(message),
        });
      }

      // Milestone 55 / ADR 0014: the same bit, read as a barrier position for any level
      // crossing bound to it. Deliberately a separate delta key prefix ("B"), so a crossing and
      // a signal bound to the same byte never collide in `publishDeltaIfNewer`.
      for (const binding of await bindings.getBarriers(row.td_area, byte.address)) {
        const state = barrierStateFromSignalState(
          signalStateForBit(
            byte.value,
            binding.bit,
            binding.activeMeans ? barrierActiveMeansAsSignal(binding.activeMeans) : undefined,
          ),
        );
        const memoryKey = `${binding.mapSlug}|${binding.elementId}`;
        if (lastBarrierState.get(memoryKey) === state) continue;
        lastBarrierState.set(memoryKey, state);
        const message: CrossingUpdatedMessage = {
          type: "crossing.updated",
          sequence,
          eventAt: row.normalized_event_at_utc.toISOString(),
          elementId: binding.elementId,
          state,
          tdArea: row.td_area,
          address: byte.address,
          bit: binding.bit,
        };
        pending.push({
          mapSlug: binding.mapSlug,
          key: `B ${row.td_area} ${byte.address} ${binding.bit}`,
          sequence,
          message: JSON.stringify(message),
        });
      }
    }

    // Milestone 59 / ADR 0015: an inferred crossing's position is the combination of all its
    // inputs (`inferredBarrierState`), so recompute it once per row that restated any of them.
    for (const [crossingKey, { input: trigger, address }] of touched) {
      const states = bindings
        .inferredCrossingInputs(trigger.mapSlug, trigger.elementId)
        .map((input): SignalDisplayState => {
          const live = lastInferredInputState.get(inferredInputKey(input));
          if (live !== undefined) return live;
          const seeded = bindings.seededInputByte(input.tdArea, input.address);
          return seeded === undefined
            ? "blank"
            : signalStateForBit(seeded, input.bit, input.activeMeans ?? undefined);
        });
      const state = inferredBarrierState(states);
      if (lastBarrierState.get(crossingKey) === state) continue;
      lastBarrierState.set(crossingKey, state);
      const message: CrossingUpdatedMessage = {
        type: "crossing.updated",
        sequence,
        eventAt: row.normalized_event_at_utc.toISOString(),
        elementId: trigger.elementId,
        state,
        tdArea: row.td_area,
        address,
        bit: trigger.bit,
      };
      pending.push({
        mapSlug: trigger.mapSlug,
        // Per crossing rather than per bit: its state depends on several bits, and the newer-only
        // guard must order every change to it, whichever input caused it.
        key: `I ${trigger.elementId}`,
        sequence,
        message: JSON.stringify(message),
      });
    }
  }
  return pending;
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

/** One Redis publish waiting to go out — collected per batch so berth and signal deltas can be
 * sent strictly in `sequence` order. */
export interface PendingDelta {
  mapSlug: string;
  /** `publishDeltaIfNewer`'s per-key watermark. */
  key: string;
  sequence: number;
  message: string;
}

/** The berth deltas for a folded batch — one per (berth change × map that binds it). */
export async function buildBerthDeltas(
  pool: Pool,
  bindings: BindingsCache,
  writes: BerthStateWrite[],
): Promise<PendingDelta[]> {
  const pending: PendingDelta[] = [];
  for (const write of writes) {
    const bound = await bindings.get(write.tdArea, write.berth);
    if (bound.length === 0) continue;
    const sequence = Number(write.sourceSeq);
    const berthKey = `${write.tdArea} ${write.berth}`;
    // `berth_current_state` for `write` was already upserted by the caller before this runs, so
    // a combined berth's other members can be read fresh here alongside it.
    const combinedOverrides = await computeCombinedOverrides(pool, bound);
    const messages = buildDeltaMessages(
      {
        tdArea: write.tdArea,
        berth: write.berth,
        description: write.description,
        eventAt: write.eventAt,
      },
      bound,
      sequence,
      combinedOverrides,
    );
    for (const { mapSlug, message } of messages) {
      pending.push({ mapSlug, key: berthKey, sequence, message: JSON.stringify(message) });
    }
  }
  return pending;
}

/**
 * Publishes a batch's deltas in `sequence` order, each through `publishDeltaIfNewer` so the two
 * live publishers (`projector-td-live` daemon + `ingest-td` inline path, ADR 0003 Tier 3) never
 * double-send. Sequence order matters: a client drops its socket on any sequence regression, and
 * `foldLiveBerthState` orders writes by `(td_area, berth)` for lock ordering, not by sequence —
 * publishing in that order used to regress whenever one frame changed several bound berths
 * (Milestone 36b fix). Returns how many were actually published.
 */
export async function publishInSequenceOrder(
  redis: DeltaPublisher,
  pending: PendingDelta[],
): Promise<number> {
  let published = 0;
  const ordered = pending
    .map((delta, index) => ({ delta, index }))
    .sort((a, b) => a.delta.sequence - b.delta.sequence || a.index - b.index);
  for (const { delta } of ordered) {
    published += await redis.publishDeltaIfNewer(
      delta.mapSlug,
      delta.key,
      delta.sequence,
      delta.message,
    );
  }
  return published;
}

/** Publish the berth deltas for a folded batch (see `publishInSequenceOrder`). */
export async function publishBerthDeltas(
  pool: Pool,
  redis: DeltaPublisher,
  bindings: BindingsCache,
  writes: BerthStateWrite[],
): Promise<number> {
  return publishInSequenceOrder(redis, await buildBerthDeltas(pool, bindings, writes));
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
  sClassRows: RawSClassRow[] = [],
): Promise<{ berthsUpdated: number; deltasPublished: number }> {
  const cClass = rows.filter(
    (r) => r.event_type === "CA" || r.event_type === "CB" || r.event_type === "CC",
  );
  if (cClass.length === 0 && sClassRows.length === 0) {
    return { berthsUpdated: 0, deltasPublished: 0 };
  }

  // rows arrive in child order; foldLiveBerthState treats them as ingestion order (same thing
  // within one frame — child_index and ingestion_sequence are both monotonic here).
  const writes = foldLiveBerthState(cClass);
  await bulkUpsertCurrentState(pool, writes);
  if (!redis) return { berthsUpdated: writes.length, deltasPublished: 0 };
  const pending = [
    ...(await buildBerthDeltas(pool, bindings, writes)),
    ...(await buildSignalDeltas(bindings, sClassRows)),
  ];
  const deltasPublished = await publishInSequenceOrder(redis, pending);
  return { berthsUpdated: writes.length, deltasPublished };
}

/** `projector-td-live`'s last row (receive time) — to spot a silence spanning two ticks. Null
 * until the first tick, which looks the checkpoint row up instead. */
let lastLiveReceived: ReceivedRow | null = null;

/**
 * Milestone 36b: a TD receive silence past the signal-trust tolerance means signals clients are
 * still showing may be stale. Tell every map with signal bindings to resync (the snapshot blanks
 * each byte until it is re-confirmed). Through `publishDeltaIfNewer` keyed on the silence, so a
 * repeat detection (another tick, a restart) doesn't resend it.
 */
async function publishFeedGapResyncs(
  redis: DeltaPublisher,
  bindings: BindingsCache,
  endSequence: string,
): Promise<number> {
  const message: ResyncRequiredMessage = { type: "resync.required", reason: "feed_gap" };
  let published = 0;
  for (const slug of await bindings.signalMapSlugs()) {
    published += await redis.publishDeltaIfNewer(
      slug,
      "resync feed_gap",
      Number(endSequence),
      JSON.stringify(message),
    );
  }
  return published;
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

    // CA/CB/CC for berths, plus S-Class for signals (Milestone 36b).
    const { rows } = await pool.query<
      (RawCClassRow | RawSClassRow) & { message_class: "C" | "S"; received_at_utc: Date }
    >(
      `select id, normalized_event_at_utc, ingestion_sequence, event_type, td_area, raw_event_json,
              message_class, received_at_utc
       from raw_feed_event
       where feed_name = 'TD' and parse_status = 'parsed' and ingestion_sequence > $1
         and ((message_class = 'C' and event_type in ('CA', 'CB', 'CC')) or message_class = 'S')
       order by ingestion_sequence
       limit $2`,
      [since, batchSize],
    );
    if (rows.length === 0) break;
    summary.batches += 1;
    summary.processedEvents += rows.length;

    const cRows = rows.filter((row): row is RawCClassRow & typeof row => row.message_class === "C");
    const sRows = rows.filter((row) => row.message_class === "S");
    const writes = foldLiveBerthState(cRows);
    const maxSeq = rows.reduce(
      (max, row) => (BigInt(row.ingestion_sequence) > max ? BigInt(row.ingestion_sequence) : max),
      BigInt(since),
    );

    await bulkUpsertCurrentState(pool, writes);
    summary.berthsUpdated += writes.length;

    if (redis) {
      if (!lastLiveReceived && since !== "0") {
        const prev = await pool.query<{ received_at_utc: Date }>(
          `select received_at_utc from raw_feed_event
           where feed_name = 'TD' and ingestion_sequence = $1 limit 1`,
          [since],
        );
        const row = prev.rows[0];
        lastLiveReceived = row
          ? { receivedAt: row.received_at_utc, ingestionSequence: since }
          : null;
      }
      const silences = detectReceiveSilences(
        lastLiveReceived,
        rows.map((row) => ({
          receivedAt: row.received_at_utc,
          ingestionSequence: row.ingestion_sequence,
        })),
      );
      const pending = [
        ...(await buildBerthDeltas(pool, bindings, writes)),
        ...(await buildSignalDeltas(bindings, sRows)),
      ];
      summary.deltasPublished += await publishInSequenceOrder(redis, pending);
      for (const silence of silences) {
        summary.deltasPublished += await publishFeedGapResyncs(
          redis,
          bindings,
          silence.endSequence,
        );
      }
    }
    const lastRow = rows.at(-1);
    if (lastRow) {
      lastLiveReceived = {
        receivedAt: lastRow.received_at_utc,
        ingestionSequence: lastRow.ingestion_sequence,
      };
    }

    await advanceCheckpoint(pool, defId, maxSeq.toString());
    if (options.maxBatches !== undefined && summary.batches >= options.maxBatches) break;
  }

  return summary;
}
