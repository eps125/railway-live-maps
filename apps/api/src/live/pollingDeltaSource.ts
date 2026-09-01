import type { Pool } from "pg";
import { TD_PROJECTION_VERSION } from "@railway/domain";
import type { LiveDeltaMessage } from "@railway/protocol";
import type { LiveDeltaSource } from "./deltaSource.js";

interface BoundBerthStateRow {
  element_id: string;
  td_area: string;
  berth: string;
  description: string | null;
  occupancy_entered_at: Date | null;
  source_ingestion_sequence: string | null;
}

interface ElementState {
  description: string | null;
  enteredAt: string | null;
}

interface PollEntry {
  listeners: Set<(message: LiveDeltaMessage) => void>;
  timer: ReturnType<typeof setInterval> | undefined;
  lastByElement: Map<string, ElementState>;
  lastSequence: number;
}

async function fetchBoundState(pool: Pool, mapVersionId: string): Promise<BoundBerthStateRow[]> {
  const result = await pool.query<BoundBerthStateRow>(
    `select mbi.element_id, mbi.td_area, mbi.berth,
            bcs.description, bcs.occupancy_entered_at, bcs.source_ingestion_sequence
     from map_binding_index mbi
     left join berth_current_state bcs
       on bcs.td_area = mbi.td_area and bcs.berth_code = mbi.berth
       and bcs.projection_version = $2
     where mbi.map_version_id = $1 and mbi.binding_type = 'td_berth'`,
    [mapVersionId, TD_PROJECTION_VERSION],
  );
  return result.rows;
}

function logPollError(mapVersionId: string, error: unknown): void {
  console.error(`pollingDeltaSource: poll failed for map_version ${mapVersionId}`, error);
}

/**
 * Default `LiveDeltaSource`: polls `berth_current_state` (joined through `map_binding_index`,
 * so only the elements a map actually binds are ever considered — nationwide projection
 * itself is never filtered, only this map-specific view of it) on a fixed interval, diffs
 * against the last-seen state per element, and forwards only what changed. One poll loop is
 * shared across every socket subscribed to the same `map_version_id`, not one per socket.
 *
 * `sequence` numbers are derived from `berth_current_state.source_ingestion_sequence` where
 * available (ties deltas back to real nationwide event order) and otherwise a local monotonic
 * counter, so they are always non-decreasing for a given map version even though this adapter
 * only samples state periodically rather than replaying every intermediate event — the
 * Redis-backed adapter (`redisDeltaSource.ts`) is the precise, per-event alternative.
 */
export function createPollingDeltaSource(pool: Pool, intervalMs: number): LiveDeltaSource {
  const entries = new Map<string, PollEntry>();

  function diffAndEmit(entry: PollEntry, rows: BoundBerthStateRow[]): void {
    for (const row of rows) {
      const previous = entry.lastByElement.get(row.element_id);
      const enteredAt = row.occupancy_entered_at ? row.occupancy_entered_at.toISOString() : null;
      const next: ElementState = { description: row.description, enteredAt };

      const changed =
        !previous ||
        previous.description !== next.description ||
        previous.enteredAt !== next.enteredAt;
      entry.lastByElement.set(row.element_id, next);
      if (!changed) continue;

      const observedSequence = row.source_ingestion_sequence
        ? Number(row.source_ingestion_sequence)
        : entry.lastSequence + 1;
      entry.lastSequence = Math.max(entry.lastSequence + 1, observedSequence);

      const eventAt = new Date().toISOString();
      const message: LiveDeltaMessage =
        row.description === null
          ? {
              type: "berth.cleared",
              sequence: entry.lastSequence,
              eventAt,
              elementId: row.element_id,
              tdArea: row.td_area,
              berth: row.berth,
            }
          : {
              type: "berth.updated",
              sequence: entry.lastSequence,
              eventAt,
              elementId: row.element_id,
              tdArea: row.td_area,
              berth: row.berth,
              description: row.description,
              // `enteredAt` should always be set whenever `description` is (the projector sets
              // both together), but the column is nullable in the schema — fall back to "now"
              // rather than emit a message the protocol schema would reject.
              enteredAt: next.enteredAt ?? eventAt,
            };
      entry.listeners.forEach((listener) => listener(message));
    }
  }

  function startPolling(mapVersionId: string, entry: PollEntry): void {
    entry.timer = setInterval(() => {
      fetchBoundState(pool, mapVersionId)
        .then((rows) => diffAndEmit(entry, rows))
        .catch((error: unknown) => logPollError(mapVersionId, error));
    }, intervalMs);
  }

  return {
    // mapSlug is unused here — this adapter keys entirely on map_version_id, which is what the
    // underlying berth_current_state/map_binding_index join needs.
    subscribe(mapVersionId, _mapSlug, onDelta) {
      let entry = entries.get(mapVersionId);
      if (!entry) {
        entry = {
          listeners: new Set(),
          lastByElement: new Map(),
          lastSequence: 0,
          timer: undefined,
        };
        entries.set(mapVersionId, entry);

        // Seed lastByElement (and lastSequence) from current state *before* polling starts, so
        // state that already existed prior to the first subscriber never gets reported as a
        // spurious delta — the snapshot the WS route sends already carries it.
        fetchBoundState(pool, mapVersionId)
          .then((rows) => {
            const stillWanted = entries.get(mapVersionId);
            if (!stillWanted) return; // every subscriber unsubscribed before seeding finished
            for (const row of rows) {
              stillWanted.lastByElement.set(row.element_id, {
                description: row.description,
                enteredAt: row.occupancy_entered_at ? row.occupancy_entered_at.toISOString() : null,
              });
              if (row.source_ingestion_sequence) {
                stillWanted.lastSequence = Math.max(
                  stillWanted.lastSequence,
                  Number(row.source_ingestion_sequence),
                );
              }
            }
            startPolling(mapVersionId, stillWanted);
          })
          .catch((error: unknown) => {
            logPollError(mapVersionId, error);
            const stillWanted = entries.get(mapVersionId);
            if (stillWanted) startPolling(mapVersionId, stillWanted);
          });
      }
      entry.listeners.add(onDelta);

      return () => {
        const current = entries.get(mapVersionId);
        if (!current) return;
        current.listeners.delete(onDelta);
        if (current.listeners.size === 0) {
          if (current.timer) clearInterval(current.timer);
          entries.delete(mapVersionId);
        }
      };
    },
  };
}
