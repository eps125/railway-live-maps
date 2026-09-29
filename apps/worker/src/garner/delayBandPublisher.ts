import type { Pool } from "pg";
import {
  findOpenBerthsForTrustIds,
  projectTrustDelayBands,
  type BerthDelayRow,
} from "@railway/database";
import type { DelayUpdatedMessage } from "@railway/protocol";

/** What `ingest-garner` needs from Redis to push a band: a plain PUBLISH. Band messages are
 * absolute state, so unlike berth deltas they need no dedupe script. */
export interface DelayPublishTarget {
  publish(channel: string, message: string): Promise<unknown>;
}

/** Batches of new TRUST reports processed per `ingest-garner` tick. The bridge itself mirrors at
 * most one `TRUST_BATCH` (5,000) of movements a tick, so two keeps up with live traffic and lets
 * the first 24 h after deploy catch up in reasonable time. */
const MAX_BATCHES_PER_TICK = 2;

/** Map bindings barely change, so the current published maps are re-read at most this often. */
const MAP_CACHE_MS = 60_000;

interface MapBindings {
  slug: string;
  berthBindingIndex: Record<string, string>;
}

/** The currently published maps' berth bindings — only the binding index, never the whole
 * compiled bundle. */
export class MapBindingsCache {
  private maps: MapBindings[] = [];
  private loadedAt = 0;

  constructor(private readonly pool: Pool) {}

  async current(): Promise<MapBindings[]> {
    if (Date.now() - this.loadedAt < MAP_CACHE_MS) return this.maps;
    const result = await this.pool.query<{
      slug: string;
      berth_binding_index: Record<string, string> | null;
    }>(
      `select m.slug, mv.compiled_runtime_bundle->'berthBindingIndex' as berth_binding_index
       from map_version mv
       join map m on m.id = mv.map_id
       where mv.effective_from <= now() and (mv.effective_to is null or mv.effective_to > now())`,
    );
    this.maps = result.rows.map((row) => ({
      slug: row.slug,
      berthBindingIndex: row.berth_binding_index ?? {},
    }));
    this.loadedAt = Date.now();
    return this.maps;
  }
}

/** Every berth bound on any of `maps`, once each. */
export function mappedBerths(
  maps: ReadonlyArray<MapBindings>,
): Array<{ tdArea: string; berth: string }> {
  const keys = new Set<string>();
  for (const map of maps) for (const key of Object.keys(map.berthBindingIndex)) keys.add(key);
  return [...keys].map((key) => {
    const [tdArea, berth] = key.split("|");
    return { tdArea: tdArea ?? "", berth: berth ?? "" };
  });
}
/** One `delay.updated` per (map, berth) that currently holds a touched run. Pure, so the
 * map-matching can be tested without Redis or a database. */
export function delayMessagesFor(
  rows: ReadonlyArray<BerthDelayRow>,
  maps: ReadonlyArray<MapBindings>,
  eventAt: Date,
): Array<{ slug: string; message: DelayUpdatedMessage }> {
  const out: Array<{ slug: string; message: DelayUpdatedMessage }> = [];
  for (const map of maps) {
    for (const row of rows) {
      const elementId = map.berthBindingIndex[`${row.tdArea}|${row.berth}`];
      if (!elementId) continue;
      out.push({
        slug: map.slug,
        message: {
          type: "delay.updated",
          eventAt: eventAt.toISOString(),
          runKey: row.runKey,
          elementId,
          description: row.description,
          band: row.band,
          matchConfidence: row.matchConfidence,
        },
      });
    }
  }
  return out;
}

export interface DelayBandTickSummary {
  movementsRead: number;
  changesRecorded: number;
  published: number;
}

/**
 * Milestone 82, run by `ingest-garner` straight after it mirrors TRUST: record band changes for
 * the reports just mirrored, then — for every train that got a new report — re-state its band
 * on each map where it is currently in a berth. Nothing here runs per berth step: it runs once
 * per garner sync tick and only touches trains openrail-eps actually reported on.
 *
 * A new report re-publishes even when the band is unchanged: a train may have been linked to its
 * berth since its band last changed, and this is how it gets coloured without anyone polling.
 * Publishing is best-effort — a Redis failure never stops the projection (the next report, or a
 * reconnect's snapshot, puts it right).
 */
export async function projectAndPublishDelayBands(
  pool: Pool,
  redis: DelayPublishTarget | null,
  maps: MapBindingsCache,
): Promise<DelayBandTickSummary> {
  const summary: DelayBandTickSummary = { movementsRead: 0, changesRecorded: 0, published: 0 };
  const touched = new Set<string>();
  for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
    const result = await projectTrustDelayBands(pool);
    summary.movementsRead += result.movementsRead;
    summary.changesRecorded += result.changesRecorded;
    for (const train of result.touched) touched.add(train.trustId);
    if (result.movementsRead === 0) break;
  }

  if (!redis || touched.size === 0) return summary;
  try {
    const current = await maps.current();
    const rows = await findOpenBerthsForTrustIds(pool, [...touched], mappedBerths(current));
    if (rows.length === 0) return summary;
    const messages = delayMessagesFor(rows, current, new Date());
    for (const { slug, message } of messages) {
      await redis.publish(`railway:live:${slug}`, JSON.stringify(message));
      summary.published += 1;
    }
  } catch (error) {
    console.error("ingest-garner: delay band publish failed (projection kept):", error);
  }
  return summary;
}
