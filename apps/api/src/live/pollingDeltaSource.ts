import type { Pool } from "pg";
import {
  TD_PROJECTION_VERSION,
  VIRTUAL_BERTH_PROJECTION_VERSION,
  joinCombinedBerthState,
} from "@railway/domain";
import type { LiveDeltaMessage } from "@railway/protocol";
import type { LiveDeltaSource } from "./deltaSource.js";

interface BoundBerthStateRow {
  element_id: string;
  td_area: string;
  berth: string;
  combined_order: number | null;
  description: string | null;
  occupancy_entered_at: Date | null;
  source_ingestion_sequence: string | null;
}

interface ElementState {
  description: string | null;
  enteredAt: string | null;
}

/** Groups raw per-binding rows by element (more than one row per element only for a combined
 * berth — docs/MAP_EDITOR_SPEC.md's berth section, owner request 2026-09-17) and joins each
 * group's currently-occupied members into that element's single displayed state. Also returns,
 * per element, a representative row (its lowest `combined_order`, i.e. member 1) to source the
 * `tdArea`/`berth` informational fields on an outgoing delta message from — those fields are
 * cosmetic/debug metadata for a combined berth (never rendered — MapRenderer/EditorCanvas only
 * read `description`/`enteredAt`), since a delta message names exactly one physical berth. */
function groupByElement(
  rows: BoundBerthStateRow[],
): Map<string, { state: ElementState; representative: BoundBerthStateRow }> {
  const byElement = new Map<string, BoundBerthStateRow[]>();
  for (const row of rows) {
    const list = byElement.get(row.element_id) ?? [];
    list.push(row);
    byElement.set(row.element_id, list);
  }
  const result = new Map<string, { state: ElementState; representative: BoundBerthStateRow }>();
  for (const [elementId, members] of byElement) {
    const state = joinCombinedBerthState(
      members.map((m) => ({
        tdArea: m.td_area,
        berth: m.berth,
        order: m.combined_order ?? 1,
        description: m.description,
        enteredAt: m.occupancy_entered_at ? m.occupancy_entered_at.toISOString() : null,
      })),
    );
    const representative = [...members].sort(
      (a, b) => (a.combined_order ?? 1) - (b.combined_order ?? 1),
    )[0]!;
    result.set(elementId, { state, representative });
  }
  return result;
}

interface PollEntry {
  listeners: Set<(message: LiveDeltaMessage) => void>;
  timer: ReturnType<typeof setInterval> | undefined;
  lastByElement: Map<string, ElementState>;
  lastSequence: number;
}

async function fetchBoundState(pool: Pool, mapVersionId: string): Promise<BoundBerthStateRow[]> {
  const result = await pool.query<BoundBerthStateRow>(
    `select mbi.element_id, mbi.td_area, mbi.berth, mbi.combined_order,
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

/** docs/adr/0012: a virtual berth's live state, joined through the same map_binding_index but
 * keyed by stanox instead of (td_area, berth). Never combines (no `combinedOrder` concept for a
 * virtual berth — validate.ts blocks two virtual bindings sharing a STANOX outright), so each row
 * is already exactly one element's state. */
interface VirtualBoundStateRow {
  element_id: string;
  stanox: string;
  description: string | null; // headcode, aliased to match ElementState's shape
  occupancy_entered_at: Date | null;
}

async function fetchVirtualBoundState(
  pool: Pool,
  mapVersionId: string,
): Promise<VirtualBoundStateRow[]> {
  const result = await pool.query<VirtualBoundStateRow>(
    `select mbi.element_id, mbi.stanox, vbcs.headcode as description, vbcs.occupancy_entered_at
     from map_binding_index mbi
     left join virtual_berth_current_state vbcs
       on vbcs.stanox = mbi.stanox and vbcs.projection_version = $2
     where mbi.map_version_id = $1 and mbi.binding_type = 'virtual_berth'`,
    [mapVersionId, VIRTUAL_BERTH_PROJECTION_VERSION],
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
    for (const [elementId, { state: next, representative }] of groupByElement(rows)) {
      const previous = entry.lastByElement.get(elementId);

      const changed =
        !previous ||
        previous.description !== next.description ||
        previous.enteredAt !== next.enteredAt;
      entry.lastByElement.set(elementId, next);
      if (!changed) continue;

      const observedSequence = representative.source_ingestion_sequence
        ? Number(representative.source_ingestion_sequence)
        : entry.lastSequence + 1;
      entry.lastSequence = Math.max(entry.lastSequence + 1, observedSequence);

      const eventAt = new Date().toISOString();
      const message: LiveDeltaMessage =
        next.description === null
          ? {
              type: "berth.cleared",
              sequence: entry.lastSequence,
              eventAt,
              elementId,
              tdArea: representative.td_area,
              berth: representative.berth,
            }
          : {
              type: "berth.updated",
              sequence: entry.lastSequence,
              eventAt,
              elementId,
              tdArea: representative.td_area,
              berth: representative.berth,
              description: next.description,
              // `enteredAt` should always be set whenever `description` is (the projector sets
              // both together), but the column is nullable in the schema — fall back to "now"
              // rather than emit a message the protocol schema would reject.
              enteredAt: next.enteredAt ?? eventAt,
            };
      entry.listeners.forEach((listener) => listener(message));
    }
  }

  /** docs/adr/0012: same diff-and-emit shape as `diffAndEmit`, but for virtual berths — no
   * combining (each row is already one element), and the outgoing message carries `stanox`
   * instead of `tdArea`/`berth`. Shares `entry`'s `lastByElement`/`lastSequence`/`listeners` with
   * the TD path, since an elementId is never both (validate.ts: exactly one binding per berth
   * element), so there is no key collision risk between the two loops. */
  function diffAndEmitVirtual(entry: PollEntry, rows: VirtualBoundStateRow[]): void {
    for (const row of rows) {
      const next: ElementState = {
        description: row.description,
        enteredAt: row.occupancy_entered_at ? row.occupancy_entered_at.toISOString() : null,
      };
      const previous = entry.lastByElement.get(row.element_id);
      const changed =
        !previous ||
        previous.description !== next.description ||
        previous.enteredAt !== next.enteredAt;
      entry.lastByElement.set(row.element_id, next);
      if (!changed) continue;

      entry.lastSequence += 1;
      const eventAt = new Date().toISOString();
      const message: LiveDeltaMessage =
        next.description === null
          ? {
              type: "berth.cleared",
              sequence: entry.lastSequence,
              eventAt,
              elementId: row.element_id,
              stanox: row.stanox,
            }
          : {
              type: "berth.updated",
              sequence: entry.lastSequence,
              eventAt,
              elementId: row.element_id,
              stanox: row.stanox,
              description: next.description,
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
      fetchVirtualBoundState(pool, mapVersionId)
        .then((rows) => diffAndEmitVirtual(entry, rows))
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
        // spurious delta — the snapshot the WS route sends already carries it. Both TD and
        // virtual (docs/adr/0012) bound state are seeded before polling starts either way.
        Promise.all([
          fetchBoundState(pool, mapVersionId),
          fetchVirtualBoundState(pool, mapVersionId),
        ])
          .then(([rows, virtualRows]) => {
            const stillWanted = entries.get(mapVersionId);
            if (!stillWanted) return; // every subscriber unsubscribed before seeding finished
            for (const [elementId, { state, representative }] of groupByElement(rows)) {
              stillWanted.lastByElement.set(elementId, state);
              if (representative.source_ingestion_sequence) {
                stillWanted.lastSequence = Math.max(
                  stillWanted.lastSequence,
                  Number(representative.source_ingestion_sequence),
                );
              }
            }
            for (const row of virtualRows) {
              stillWanted.lastByElement.set(row.element_id, {
                description: row.description,
                enteredAt: row.occupancy_entered_at ? row.occupancy_entered_at.toISOString() : null,
              });
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
