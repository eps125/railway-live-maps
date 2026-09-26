import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  S_CLASS_DEFINITION_KINDS,
  SIGNAL_STATE_LOOKBACK_MS,
  TD_S_STATE_PROJECTION_VERSION,
  decodeSClassPayload,
  formatSAddress,
  parseSClassDefinitionTable,
  type SClassByteRadix,
  type SClassDefinitionKind,
} from "@railway/domain";
import { fetchLiveSOverlay, fetchSByteFactsAt, type RawSOverlayRow } from "@railway/database";
import { apiError, parseLimit } from "../../lib/queryRange.js";

/**
 * Milestone 36c (docs/IMPLEMENTATION_PLAN.md, docs/adr/0013): the admin S-Class explorer and
 * definitions, for any TD area with S-Class data — the web page lives under the admin "Berths"
 * hub (`/admin/berths/s-class`).
 *
 * Everything here is authoring/diagnostic. The correlation endpoints *suggest* which bit belongs
 * to which berth step (ADR 0013 decision 4, the rule-10 clarification): nothing is ever applied
 * automatically, and nothing here feeds a map's displayed state — that remains only the bound bit.
 */

export interface SClassAdminRoutesDeps {
  pool: Pool;
}

const DEFINITION_SOURCES = ["wiki", "sop", "ecs", "observed", "other"] as const;
type DefinitionSource = (typeof DEFINITION_SOURCES)[number];

/** Correlation window either side of a bit change / berth step. */
const CORRELATION_WINDOW_SECONDS = 10;
const CORRELATION_DEFAULT_HOURS = 24;
/** Milestone 56: `backfill-s-class-bits` fills `td_s_bit_transition` back 14 days, so the
 * explorer's ranges reach that far too. Raising this alone would only widen empty windows — the
 * backfill is what makes the extra days hold anything. */
const CORRELATION_MAX_HOURS = 14 * 24;
/** Milestone 64: how far before a signal clears a route bit may have been set. M9 measured a 46-83 s
 * lead (the crossing's lowering and proving time); 3 minutes leaves room for slower interlockings. */
const ROUTE_LEAD_MAX_SECONDS = 180;
/** How long after the clear to look for the route bit being released. */
const ROUTE_HOLD_MAX_SECONDS = 30 * 60;
/** The mini explorer's change window: default 2 minutes, at most 1 hour either way. */
const SNAPSHOT_DEFAULT_WINDOW_SECONDS = 120;
const SNAPSHOT_MAX_WINDOW_SECONDS = 3600;
/** The newest changes returned in one snapshot. */
const SNAPSHOT_CHANGE_LIMIT = 300;
/** How far back a byte's last statement may be and still count as its value at `at` — the
 * signal state lookback, so the panel and the map agree about what is known. */
const SNAPSHOT_LOOKBACK_MS = SIGNAL_STATE_LOOKBACK_MS;
/** Live snapshots also read raw rows the history projector hasn't reached yet — the same bounds
 * the live map uses for its own overlay. */
const SNAPSHOT_OVERLAY_MAX_ROWS = 5_000;
const SNAPSHOT_OVERLAY_MAX_BACKLOG_ROWS = 20_000;

export interface SnapshotChange {
  address: string;
  bit: number;
  previousValue: boolean;
  newValue: boolean;
  eventAt: string;
}

/**
 * Milestone 65: bring a live snapshot fully up to date. `bytes` are the stored values (up to the
 * history projector's checkpoint); `rows` are the raw S-Class messages after it, oldest first.
 * Each row's bytes replace the values they state, and every bit that differs from a known
 * previous value is a change — the same rule the projector applies when it writes
 * `td_s_bit_transition`, so these join the stored changes seamlessly. A byte first stated here
 * becomes known but yields no change (nothing to compare it with). Rows that don't decode, or are
 * for another area, are skipped. Pure. Returns the changes newest first.
 */
export function applySnapshotOverlay(
  tdArea: string,
  bytes: Map<string, number | null>,
  rows: ReadonlyArray<
    Pick<RawSOverlayRow, "tdArea" | "eventType" | "address" | "data" | "eventAt">
  >,
): SnapshotChange[] {
  const changes: SnapshotChange[] = [];
  for (const row of rows) {
    if (row.tdArea !== tdArea) continue;
    const decoded = decodeSClassPayload(row.eventType, row.address, row.data);
    if (!decoded.ok) continue;
    for (const byte of decoded.bytes) {
      const previous = bytes.get(byte.address);
      bytes.set(byte.address, byte.value);
      if (previous === null || previous === undefined || previous === byte.value) continue;
      for (let bit = 0; bit < 8; bit++) {
        const was = ((previous >> bit) & 1) === 1;
        const now = ((byte.value >> bit) & 1) === 1;
        if (was !== now) {
          changes.push({
            address: byte.address,
            bit,
            previousValue: was,
            newValue: now,
            eventAt: row.eventAt.toISOString(),
          });
        }
      }
    }
  }
  return changes.reverse();
}

/** The bit grid's activity window (`?windowHours=`), bounded by the same retention. */
const GRID_DEFAULT_WINDOW_HOURS = 24;
const GRID_MAX_WINDOW_HOURS = CORRELATION_MAX_HOURS;

/** `windowHours` for the bit grid — a positive number of hours, capped at the retained history. */
export function parseWindowHours(raw: string | undefined): number | null {
  if (raw === undefined) return GRID_DEFAULT_WINDOW_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return Math.min(hours, GRID_MAX_WINDOW_HOURS);
}

interface DefinitionRow {
  td_area: string;
  address: string;
  bit: number;
  kind: SClassDefinitionKind;
  label: string | null;
  destination: string | null;
  source: DefinitionSource;
  notes: string | null;
  updated_by: string;
  updated_at: Date;
}

function definitionResponse(row: DefinitionRow) {
  return {
    tdArea: row.td_area,
    address: row.address,
    bit: row.bit,
    kind: row.kind,
    label: row.label,
    destination: row.destination,
    source: row.source,
    notes: row.notes,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** `"a"`/`"0A"` → `"0A"`; anything that isn't one or two hex digits → null. */
function canonicalAddress(raw: string): string | null {
  return /^[0-9A-Fa-f]{1,2}$/.test(raw) ? formatSAddress(Number.parseInt(raw, 16)) : null;
}

function parseBit(raw: string): number | null {
  return /^[0-7]$/.test(raw) ? Number(raw) : null;
}

function isTdArea(raw: string): boolean {
  return /^[A-Z0-9]{2}$/.test(raw);
}

/** `from`/`to` (ISO) for the correlation endpoints — default the last 24 h, max 14 days. */
function correlationRange(query: {
  from?: string;
  to?: string;
}): { ok: true; from: Date; to: Date } | { ok: false; message: string } {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - CORRELATION_DEFAULT_HOURS * 3_600_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    return { ok: false, message: "from/to must be valid ISO timestamps with from < to" };
  }
  if (to.getTime() - from.getTime() > CORRELATION_MAX_HOURS * 3_600_000) {
    return { ok: false, message: `The range may be at most ${CORRELATION_MAX_HOURS} hours` };
  }
  return { ok: true, from, to };
}

async function writeRevision(
  client: PoolClient,
  input: {
    tdArea: string;
    address: string;
    bit: number;
    action: "create" | "update" | "delete";
    previous: DefinitionRow | null;
    next: DefinitionRow | null;
    importBatch: string | null;
    changedBy: string;
  },
): Promise<void> {
  const snapshot = (row: DefinitionRow | null) =>
    row
      ? JSON.stringify({
          kind: row.kind,
          label: row.label,
          destination: row.destination,
          source: row.source,
          notes: row.notes,
        })
      : null;
  await client.query(
    `insert into s_class_definition_revision
       (td_area, address, bit, action, previous, next, import_batch, changed_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.tdArea,
      input.address,
      input.bit,
      input.action,
      snapshot(input.previous),
      snapshot(input.next),
      input.importBatch,
      input.changedBy,
    ],
  );
}

interface DefinitionInput {
  kind: SClassDefinitionKind;
  label: string | null;
  destination: string | null;
  source: DefinitionSource;
  notes: string | null;
}

/** Create or update one definition, recording a revision (no-op, no revision, when unchanged). */
async function upsertDefinition(
  client: PoolClient,
  key: { tdArea: string; address: string; bit: number },
  input: DefinitionInput,
  changedBy: string,
  importBatch: string | null,
): Promise<"created" | "updated" | "unchanged"> {
  const existing = await client.query<DefinitionRow>(
    `select * from s_class_definition where td_area = $1 and address = $2 and bit = $3
     for update`,
    [key.tdArea, key.address, key.bit],
  );
  const previous = existing.rows[0] ?? null;
  if (
    previous &&
    previous.kind === input.kind &&
    previous.label === input.label &&
    previous.destination === input.destination &&
    previous.source === input.source &&
    previous.notes === input.notes
  ) {
    return "unchanged";
  }
  const saved = await client.query<DefinitionRow>(
    `insert into s_class_definition
       (td_area, address, bit, kind, label, destination, source, notes, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (td_area, address, bit) do update set
       kind = excluded.kind, label = excluded.label, destination = excluded.destination,
       source = excluded.source, notes = excluded.notes, updated_by = excluded.updated_by,
       updated_at = now()
     returning *`,
    [
      key.tdArea,
      key.address,
      key.bit,
      input.kind,
      input.label,
      input.destination,
      input.source,
      input.notes,
      changedBy,
    ],
  );
  await writeRevision(client, {
    ...key,
    action: previous ? "update" : "create",
    previous,
    next: saved.rows[0] ?? null,
    importBatch,
    changedBy,
  });
  return previous ? "updated" : "created";
}

function parseDefinitionBody(
  body: unknown,
): { ok: true; value: DefinitionInput } | { ok: false; message: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const kind = b.kind;
  if (
    typeof kind !== "string" ||
    !S_CLASS_DEFINITION_KINDS.includes(kind as SClassDefinitionKind)
  ) {
    return { ok: false, message: `kind must be one of ${S_CLASS_DEFINITION_KINDS.join(", ")}` };
  }
  const source = b.source ?? "observed";
  if (typeof source !== "string" || !DEFINITION_SOURCES.includes(source as DefinitionSource)) {
    return { ok: false, message: `source must be one of ${DEFINITION_SOURCES.join(", ")}` };
  }
  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  return {
    ok: true,
    value: {
      kind: kind as SClassDefinitionKind,
      label: text(b.label),
      destination: text(b.destination),
      source: source as DefinitionSource,
      notes: text(b.notes),
    },
  };
}

export async function registerSClassAdminRoutes(
  app: FastifyInstance,
  deps: SClassAdminRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  /** Every area with decoded S-Class state, for the explorer's area picker. */
  app.get("/api/v1/admin/s-class/areas", async () => {
    const result = await pool.query<{
      td_area: string;
      bytes: number;
      last_event_at: Date;
      definitions: number;
    }>(
      `select s.td_area, count(*)::int as bytes, max(s.event_at) as last_event_at,
              coalesce((select count(*)::int from s_class_definition d where d.td_area = s.td_area), 0)
                as definitions
         from td_s_current_state s
        where s.projection_version = $1 and s.byte_value is not null
        group by s.td_area
        order by s.td_area`,
      [TD_S_STATE_PROJECTION_VERSION],
    );
    return {
      areas: result.rows.map((row) => ({
        tdArea: row.td_area,
        bytes: row.bytes,
        lastEventAt: row.last_event_at.toISOString(),
        definitions: row.definitions,
      })),
    };
  });

  /**
   * Milestone 65 (owner request 2026-09-22): the map viewer's admin S-Class mini explorer — one
   * area's bits **as they were at `at`** (default now), and every bit change in the
   * `windowSeconds` before it, newest first. The same endpoint serves live (at = now, polled) and
   * playback (at = the playback clock).
   *
   * A byte's value is its most recent decoded statement at or before `at` within 6 hours
   * (`fetchSByteFactsAt`, the lookup signal state uses), so the panel shows the same facts the map
   * resolves from. Null means nothing decoded in that time, never a guess. Admin-only diagnostics:
   * nothing here feeds a displayed state.
   */
  app.get<{ Params: { tdArea: string }; Querystring: { at?: string; windowSeconds?: string } }>(
    "/api/v1/admin/s-class/areas/:tdArea/snapshot",
    async (request, reply) => {
      const { tdArea } = request.params;
      if (!isTdArea(tdArea)) {
        reply.code(400);
        return apiError("INVALID_TD_AREA", "tdArea must be a two-character TD area code");
      }
      const at = request.query.at ? new Date(request.query.at) : new Date();
      const windowSeconds =
        request.query.windowSeconds === undefined
          ? SNAPSHOT_DEFAULT_WINDOW_SECONDS
          : Number(request.query.windowSeconds);
      if (
        Number.isNaN(at.getTime()) ||
        !Number.isFinite(windowSeconds) ||
        windowSeconds <= 0 ||
        windowSeconds > SNAPSHOT_MAX_WINDOW_SECONDS
      ) {
        reply.code(400);
        return apiError(
          "INVALID_SNAPSHOT",
          `at must be an ISO timestamp and windowSeconds between 1 and ${SNAPSHOT_MAX_WINDOW_SECONDS}`,
        );
      }
      const addresses = await pool.query<{ address: string }>(
        `select address from td_s_current_state
          where projection_version = $1 and td_area = $2
          order by address`,
        [TD_S_STATE_PROJECTION_VERSION, tdArea],
      );
      const facts = await fetchSByteFactsAt(
        pool,
        addresses.rows.map((row) => ({ tdArea, address: row.address })),
        at,
        SNAPSHOT_LOOKBACK_MS,
      );
      // Live (no `at`): the stored facts stop at the history projector's checkpoint, a moment
      // behind the feed. The raw rows after it are folded in, so the panel is as current as the
      // live map rather than trailing it.
      const live = request.query.at === undefined;
      const byteValues = new Map<string, number | null>(
        addresses.rows.map((row) => [
          row.address,
          facts.get(`${tdArea}|${row.address}`)?.value ?? null,
        ]),
      );
      const overlay = live
        ? await fetchLiveSOverlay(
            pool,
            [tdArea],
            SNAPSHOT_OVERLAY_MAX_ROWS,
            SNAPSHOT_OVERLAY_MAX_BACKLOG_ROWS,
          )
        : { rows: [], truncated: false };
      const liveChanges = applySnapshotOverlay(tdArea, byteValues, overlay.rows);
      const from = new Date(at.getTime() - windowSeconds * 1000);
      const changes = await pool.query<{
        address: string;
        bit_index: number;
        previous_value: boolean;
        new_value: boolean;
        event_at: Date;
      }>(
        `select address, bit_index, previous_value, new_value, event_at
           from td_s_bit_transition
          where projection_version = $1 and td_area = $2 and previous_value is not null
            and event_at > $3::timestamptz and event_at <= $4::timestamptz
          order by event_at desc, address, bit_index
          limit $5`,
        [TD_S_STATE_PROJECTION_VERSION, tdArea, from, at, SNAPSHOT_CHANGE_LIMIT],
      );
      const definitions = await pool.query<DefinitionRow>(
        `select * from s_class_definition where td_area = $1 order by address, bit`,
        [tdArea],
      );
      return {
        tdArea,
        at: at.toISOString(),
        windowSeconds,
        bytes: [...byteValues]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([address, value]) => ({ address, value })),
        changes: [
          ...liveChanges,
          ...changes.rows.map((row) => ({
            address: row.address,
            bit: row.bit_index,
            previousValue: row.previous_value,
            newValue: row.new_value,
            eventAt: row.event_at.toISOString(),
          })),
        ].slice(0, SNAPSHOT_CHANGE_LIMIT),
        truncated: changes.rows.length + liveChanges.length >= SNAPSHOT_CHANGE_LIMIT,
        /** Live only: the projector was too far behind to catch up here; the newest changes may
         * be missing until it does. */
        overlayTruncated: overlay.truncated,
        definitions: definitions.rows.map(definitionResponse),
      };
    },
  );

  /** The live bit grid for one area: every byte's current value, and per bit its last change
   * within `?windowHours=` (default 24 h, max the retained 14 days), change count in that window
   * and definition. */
  app.get<{ Params: { tdArea: string }; Querystring: { windowHours?: string } }>(
    "/api/v1/admin/s-class/areas/:tdArea/bits",
    async (request, reply) => {
      const { tdArea } = request.params;
      if (!isTdArea(tdArea)) {
        reply.code(400);
        return apiError("INVALID_TD_AREA", "tdArea must be a two-character TD area code");
      }
      const windowHours = parseWindowHours(request.query.windowHours);
      if (windowHours === null) {
        reply.code(400);
        return apiError("INVALID_TIME_RANGE", "windowHours must be a positive number of hours");
      }
      const [bytes, activity, definitions] = await Promise.all([
        pool.query<{
          address: string;
          byte_value: number;
          event_at: Date;
          source_kind: string | null;
          last_refresh_at: Date | null;
        }>(
          `select address, byte_value, event_at, source_kind, last_refresh_at
             from td_s_current_state
            where projection_version = $1 and td_area = $2 and byte_value is not null
            order by address`,
          [TD_S_STATE_PROJECTION_VERSION, tdArea],
        ),
        // First-sight rows (previous_value null) are not changes — excluded. Bounded to the
        // requested window on the (td_area, address, event_at desc) index.
        pool.query<{ address: string; bit_index: number; last_changed_at: Date; changes: number }>(
          `select address, bit_index, max(event_at) as last_changed_at, count(*)::int as changes
             from td_s_bit_transition
            where projection_version = $1 and td_area = $2
              and event_at > now() - make_interval(hours => $3)
              and previous_value is not null
            group by address, bit_index`,
          [TD_S_STATE_PROJECTION_VERSION, tdArea, windowHours],
        ),
        pool.query<DefinitionRow>(`select * from s_class_definition where td_area = $1`, [tdArea]),
      ]);
      const activityByBit = new Map(
        activity.rows.map((row) => [`${row.address}:${row.bit_index}`, row]),
      );
      const definitionByBit = new Map(
        definitions.rows.map((row) => [`${row.address}:${row.bit}`, row]),
      );
      return {
        tdArea,
        windowHours,
        bytes: bytes.rows.map((row) => ({
          address: row.address,
          value: row.byte_value,
          confirmedAt: row.event_at.toISOString(),
          sourceKind: row.source_kind,
          lastRefreshAt: row.last_refresh_at ? row.last_refresh_at.toISOString() : null,
          bits: Array.from({ length: 8 }, (_, bit) => {
            const act = activityByBit.get(`${row.address}:${bit}`);
            const def = definitionByBit.get(`${row.address}:${bit}`);
            return {
              bit,
              value: ((row.byte_value >> bit) & 1) === 1,
              lastChangedAt: act ? act.last_changed_at.toISOString() : null,
              changes: act?.changes ?? 0,
              definition: def ? definitionResponse(def) : null,
            };
          }),
        })),
      };
    },
  );

  /** One bit's transitions, newest first. */
  app.get<{
    Params: { tdArea: string; address: string; bit: string };
    Querystring: { before?: string; limit?: string };
  }>("/api/v1/admin/s-class/areas/:tdArea/bits/:address/:bit/history", async (request, reply) => {
    const address = canonicalAddress(request.params.address);
    const bit = parseBit(request.params.bit);
    if (!isTdArea(request.params.tdArea) || address === null || bit === null) {
      reply.code(400);
      return apiError("INVALID_BIT", "Expected a TD area, a hex address and a bit 0-7");
    }
    const before = request.query.before ? new Date(request.query.before) : new Date();
    if (Number.isNaN(before.getTime())) {
      reply.code(400);
      return apiError("INVALID_TIME_RANGE", "before must be an ISO timestamp");
    }
    const limit = parseLimit(request.query.limit);
    const result = await pool.query<{
      event_at: Date;
      previous_value: boolean | null;
      new_value: boolean;
      source_kind: string;
    }>(
      `select event_at, previous_value, new_value, source_kind
         from td_s_bit_transition
        where projection_version = $1 and td_area = $2 and address = $3 and bit_index = $4
          and event_at < $5
        order by event_at desc
        limit $6`,
      [TD_S_STATE_PROJECTION_VERSION, request.params.tdArea, address, bit, before, limit],
    );
    const last = result.rows.at(-1);
    return {
      transitions: result.rows.map((row) => ({
        eventAt: row.event_at.toISOString(),
        previousValue: row.previous_value,
        newValue: row.new_value,
        sourceKind: row.source_kind,
      })),
      nextBefore: result.rows.length === limit && last ? last.event_at.toISOString() : null,
    };
  });

  /** Suggestion: for one bit, the CA berth steps that most often happen within ±10 s of its
   * changes (split by the direction of the change). A signal returning to danger as a train
   * passes it lines up with the step into the berth beyond it. */
  app.get<{
    Params: { tdArea: string; address: string; bit: string };
    Querystring: { from?: string; to?: string };
  }>(
    "/api/v1/admin/s-class/areas/:tdArea/bits/:address/:bit/correlated-steps",
    async (request, reply) => {
      const { tdArea } = request.params;
      const address = canonicalAddress(request.params.address);
      const bit = parseBit(request.params.bit);
      if (!isTdArea(tdArea) || address === null || bit === null) {
        reply.code(400);
        return apiError("INVALID_BIT", "Expected a TD area, a hex address and a bit 0-7");
      }
      const range = correlationRange(request.query);
      if (!range.ok) {
        reply.code(400);
        return apiError("INVALID_TIME_RANGE", range.message);
      }
      const totals = await pool.query<{ new_value: boolean; transitions: number }>(
        `select new_value, count(*)::int as transitions
           from td_s_bit_transition
          where projection_version = $1 and td_area = $2 and address = $3 and bit_index = $4
            and previous_value is not null and event_at >= $5 and event_at < $6
          group by new_value`,
        [TD_S_STATE_PROJECTION_VERSION, tdArea, address, bit, range.from, range.to],
      );
      const steps = await pool.query<{
        new_value: boolean;
        from_berth: string | null;
        to_berth: string | null;
        hits: number;
        median_offset_seconds: number;
      }>(
        // 2026-09-22 (owner: "suggest berth steps" hit a 504): the step side had no overall time
        // bound, so it read every M9 berth step in every partition and compared each against every
        // change — 18 s for 24 h on production, and a timeout over 14 days. Now the steps are cut
        // to the window first, and matched on window-sized time buckets (each change tried against
        // its own and both neighbouring buckets), an equality join that hashes; the exact ±window
        // is checked after. Same results; 0.2 s for 24 h, 0.7 s for 14 days.
        `with changes as materialized (
           select event_at, new_value, floor(extract(epoch from event_at) / $7)::bigint as bucket
             from td_s_bit_transition
            where projection_version = $1 and td_area = $2 and address = $3 and bit_index = $4
              and previous_value is not null
              and event_at >= $5::timestamptz and event_at < $6::timestamptz
         ),
         steps as materialized (
           select event_at, from_berth, to_berth,
                  floor(extract(epoch from event_at) / $7)::bigint as bucket
             from td_berth_event
            where td_area = $2 and message_type = 'CA'
              and event_at >= $5::timestamptz - make_interval(secs => $7)
              and event_at < $6::timestamptz + make_interval(secs => $7)
         ),
         near as (
           select c.event_at, c.new_value, c.bucket + o.d as bucket
             from changes c
            cross join (values (-1::bigint), (0::bigint), (1::bigint)) as o(d)
         ),
         matches as (
           select distinct n.event_at, n.new_value, st.from_berth, st.to_berth,
                  extract(epoch from st.event_at - n.event_at) as offset_seconds
             from near n
             join steps st on st.bucket = n.bucket
            where st.event_at between n.event_at - make_interval(secs => $7)
                                  and n.event_at + make_interval(secs => $7)
         )
         select new_value, from_berth, to_berth, count(distinct event_at)::int as hits,
                percentile_cont(0.5) within group (order by offset_seconds) as median_offset_seconds
           from matches
          group by new_value, from_berth, to_berth
          order by hits desc
          limit 20`,
        [
          TD_S_STATE_PROJECTION_VERSION,
          tdArea,
          address,
          bit,
          range.from,
          range.to,
          CORRELATION_WINDOW_SECONDS,
        ],
      );
      const totalByDirection = new Map(totals.rows.map((row) => [row.new_value, row.transitions]));
      return {
        tdArea,
        address,
        bit,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        windowSeconds: CORRELATION_WINDOW_SECONDS,
        transitions: {
          set: totalByDirection.get(true) ?? 0,
          cleared: totalByDirection.get(false) ?? 0,
        },
        steps: steps.rows.map((row) => ({
          direction: row.new_value ? "set" : "cleared",
          fromBerth: row.from_berth,
          toBerth: row.to_berth,
          hits: row.hits,
          ofTransitions: totalByDirection.get(row.new_value) ?? 0,
          medianOffsetSeconds: Number(row.median_offset_seconds),
        })),
      };
    },
  );

  /**
   * Milestone 64 / ADR 0016: suggest the **route bits** for a signal, given the signal's own bit.
   *
   * A route is set before its entry signal clears: M9 measured 46-83 s of lead, the crossing's
   * lowering and proving time. So for every change of every other bit in the area, ask whether this
   * signal cleared within `ROUTE_LEAD_MAX_SECONDS` *while that bit was still in its new state*.
   * A route bit is one whose changes are nearly all followed like that (`hits` close to
   * `ofTransitions`), covering a share of the signal's clears — several routes from one signal
   * split them between them.
   *
   * For each candidate it also reports how long the bit then stays that way after the clear — how
   * the route is released, the measurement ADR 0016 decision 6 asked for. (A "berth step at the
   * release" column was tried and removed on 2026-09-22: in a busy area the step nearest the
   * release is usually another train's, so it was noise, and the query behind it took 45 s.)
   *
   * Authoring aid only (ADR 0013 decision 4): nothing is bound or defined automatically, and it
   * never feeds a displayed route.
   */
  app.get<{
    Params: { tdArea: string; address: string; bit: string };
    Querystring: { from?: string; to?: string; activeMeans?: string };
  }>(
    "/api/v1/admin/s-class/areas/:tdArea/bits/:address/:bit/route-candidates",
    async (request, reply) => {
      const { tdArea } = request.params;
      const address = canonicalAddress(request.params.address);
      const bit = parseBit(request.params.bit);
      if (!isTdArea(tdArea) || address === null || bit === null) {
        reply.code(400);
        return apiError("INVALID_BIT", "Expected a TD area, a hex address and a bit 0-7");
      }
      const activeMeans = request.query.activeMeans ?? "off";
      if (activeMeans !== "on" && activeMeans !== "off") {
        reply.code(400);
        return apiError(
          "INVALID_ACTIVE_MEANS",
          "activeMeans is what a set bit means for the signal: on or off",
        );
      }
      const range = correlationRange(request.query);
      if (!range.ok) {
        reply.code(400);
        return apiError("INVALID_TIME_RANGE", range.message);
      }
      // The signal clears when its bit takes the value that means "off".
      const clearValue = activeMeans === "off";
      const clears = await pool.query<{ clears: number }>(
        `select count(*)::int as clears
           from td_s_bit_transition
          where projection_version = $1 and td_area = $2 and address = $3 and bit_index = $4
            and previous_value is not null and new_value = $5
            and event_at >= $6 and event_at < $7`,
        [TD_S_STATE_PROJECTION_VERSION, tdArea, address, bit, clearValue, range.from, range.to],
      );
      const candidates = await pool.query<{
        address: string;
        bit_index: number;
        new_value: boolean;
        hits: number;
        transitions: number;
        median_lead_seconds: number;
        median_held_seconds: number | null;
      }>(
        `with timeline as materialized (
           -- ($6/$7 are cast where they first appear: "$6 - interval" alone lets Postgres infer $6
           -- as an interval and reject the query.)
           -- Every other bit's changes in the area (from the lead window before the range to the
           -- hold window after it), and this signal's clears, as one time-ordered stream.
           select address, bit_index, new_value, event_at, false as is_clear
             from td_s_bit_transition
            where projection_version = $1 and td_area = $2 and previous_value is not null
              and not (address = $3 and bit_index = $4)
              and event_at >= $6::timestamptz - make_interval(secs => $8)
              and event_at < $7::timestamptz + make_interval(secs => $9)
           union all
           select null, null, null, event_at, true
             from td_s_bit_transition
            where projection_version = $1 and td_area = $2 and address = $3 and bit_index = $4
              and previous_value is not null and new_value = $5
              and event_at >= $6::timestamptz and event_at < $7::timestamptz
         ),
         -- For each change: when that bit next changes back, and the first clear at or after it.
         -- The clear is a running min over the stream read newest-first — a fixed frame start,
         -- so it stays linear; a "following rows" frame would recompute min for every row.
         ordered as (
           select address, bit_index, new_value, event_at, is_clear,
                  lead(event_at) over (
                    partition by is_clear, address, bit_index order by event_at
                  ) as next_change_at,
                  min(case when is_clear then event_at end) over (
                    order by event_at desc, is_clear desc
                    rows between unbounded preceding and current row
                  ) as next_clear_at
             from timeline
         ),
         -- A hit: the bit changed, and the signal cleared within the lead window while the bit
         -- was still in that state.
         judged as (
           select address, bit_index, new_value, event_at, next_change_at, next_clear_at,
                  (next_clear_at is not null
                   and next_clear_at - event_at <= make_interval(secs => $8)
                   and (next_change_at is null or next_change_at > next_clear_at)) as hit
             from ordered
            where not is_clear
         )
         select address, bit_index, new_value,
                count(*) filter (where hit)::int as hits,
                count(*) filter (where event_at >= $6::timestamptz and event_at < $7::timestamptz)::int as transitions,
                percentile_cont(0.5) within group (
                  order by extract(epoch from next_clear_at - event_at)
                ) filter (where hit) as median_lead_seconds,
                percentile_cont(0.5) within group (
                  order by extract(epoch from next_change_at - next_clear_at)
                ) filter (where hit) as median_held_seconds
           from judged
          group by address, bit_index, new_value
         having count(*) filter (where hit) >= 2
          order by count(*) filter (where hit)::float
                     / greatest(count(*) filter (where event_at >= $6::timestamptz and event_at < $7::timestamptz), 1) desc,
                   count(*) filter (where hit) desc
          limit 20`,
        [
          TD_S_STATE_PROJECTION_VERSION,
          tdArea,
          address,
          bit,
          clearValue,
          range.from,
          range.to,
          ROUTE_LEAD_MAX_SECONDS,
          ROUTE_HOLD_MAX_SECONDS,
        ],
      );

      const definitions = await pool.query<DefinitionRow>(
        `select * from s_class_definition where td_area = $1`,
        [tdArea],
      );
      const definitionByBit = new Map(
        definitions.rows.map((row) => [`${row.address}:${row.bit}`, row]),
      );
      const clearCount = clears.rows[0]?.clears ?? 0;
      return {
        tdArea,
        address,
        bit,
        activeMeans,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        leadWindowSeconds: ROUTE_LEAD_MAX_SECONDS,
        clears: clearCount,
        candidates: candidates.rows.map((row) => {
          const def = definitionByBit.get(`${row.address}:${row.bit_index}`);
          return {
            address: row.address,
            bit: row.bit_index,
            // A bit that goes 0 -> 1 before the clear is a route bit whose set bit means "set".
            direction: row.new_value ? "set" : "cleared",
            hits: row.hits,
            ofClears: clearCount,
            ofTransitions: row.transitions,
            medianLeadSeconds: Number(row.median_lead_seconds),
            medianHeldSeconds:
              row.median_held_seconds === null ? null : Number(row.median_held_seconds),
            definition: def ? definitionResponse(def) : null,
          };
        }),
      };
    },
  );

  /** Suggestion, the other way round: for one CA berth step, the bits that most often change
   * within ±10 s of it — "which bit is the signal between these two berths?" */
  app.get<{
    Params: { tdArea: string };
    Querystring: { fromBerth?: string; toBerth?: string; from?: string; to?: string };
  }>("/api/v1/admin/s-class/areas/:tdArea/correlated-bits", async (request, reply) => {
    const { tdArea } = request.params;
    const fromBerth = request.query.fromBerth?.trim().toUpperCase() ?? "";
    const toBerth = request.query.toBerth?.trim().toUpperCase() ?? "";
    if (!isTdArea(tdArea) || fromBerth === "" || toBerth === "") {
      reply.code(400);
      return apiError("INVALID_STEP", "Expected a TD area plus fromBerth and toBerth");
    }
    const range = correlationRange(request.query);
    if (!range.ok) {
      reply.code(400);
      return apiError("INVALID_TIME_RANGE", range.message);
    }
    const stepCount = await pool.query<{ steps: number }>(
      `select count(*)::int as steps
         from td_berth_event
        where td_area = $1 and message_type = 'CA' and from_berth = $2 and to_berth = $3
          and event_at >= $4 and event_at < $5`,
      [tdArea, fromBerth, toBerth, range.from, range.to],
    );
    const bits = await pool.query<{
      address: string;
      bit_index: number;
      new_value: boolean;
      hits: number;
      median_offset_seconds: number;
    }>(
      // Matched on time buckets, like correlated-steps above: a range join between two
      // materialized CTEs can only nested-loop every step against every change of the area.
      `with steps as materialized (
         select event_at, floor(extract(epoch from event_at) / $7)::bigint as bucket
           from td_berth_event
          where td_area = $1 and message_type = 'CA' and from_berth = $2 and to_berth = $3
            and event_at >= $4::timestamptz and event_at < $5::timestamptz
       ),
       -- The area's changes over the window, read once: the transition index is
       -- (td_area, address, event_at), so a per-step time range with no address can't seek it.
       area_changes as materialized (
         select address, bit_index, new_value, event_at,
                floor(extract(epoch from event_at) / $7)::bigint as bucket
           from td_s_bit_transition
          where projection_version = $6 and td_area = $1 and previous_value is not null
            and event_at >= $4::timestamptz - make_interval(secs => $7)
            and event_at < $5::timestamptz + make_interval(secs => $7)
       ),
       near as (
         select st.event_at, st.bucket + o.d as bucket
           from steps st
          cross join (values (-1::bigint), (0::bigint), (1::bigint)) as o(d)
       ),
       matches as (
         select distinct n.event_at as step_at, t.address, t.bit_index, t.new_value,
                extract(epoch from n.event_at - t.event_at) as offset_seconds
           from near n
           join area_changes t on t.bucket = n.bucket
          where t.event_at between n.event_at - make_interval(secs => $7)
                               and n.event_at + make_interval(secs => $7)
       )
       select address, bit_index, new_value, count(distinct step_at)::int as hits,
              percentile_cont(0.5) within group (order by offset_seconds) as median_offset_seconds
         from matches
        group by address, bit_index, new_value
        order by hits desc
        limit 20`,
      [
        tdArea,
        fromBerth,
        toBerth,
        range.from,
        range.to,
        TD_S_STATE_PROJECTION_VERSION,
        CORRELATION_WINDOW_SECONDS,
      ],
    );
    const definitions = await pool.query<DefinitionRow>(
      `select * from s_class_definition where td_area = $1`,
      [tdArea],
    );
    const definitionByBit = new Map(
      definitions.rows.map((row) => [`${row.address}:${row.bit}`, row]),
    );
    const steps = stepCount.rows[0]?.steps ?? 0;
    return {
      tdArea,
      fromBerth,
      toBerth,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      windowSeconds: CORRELATION_WINDOW_SECONDS,
      steps,
      bits: bits.rows.map((row) => {
        const def = definitionByBit.get(`${row.address}:${row.bit_index}`);
        return {
          address: row.address,
          bit: row.bit_index,
          direction: row.new_value ? "set" : "cleared",
          hits: row.hits,
          ofSteps: steps,
          medianOffsetSeconds: Number(row.median_offset_seconds),
          definition: def ? definitionResponse(def) : null,
        };
      }),
    };
  });

  app.get<{ Params: { tdArea: string } }>(
    "/api/v1/admin/s-class/areas/:tdArea/definitions",
    async (request, reply) => {
      if (!isTdArea(request.params.tdArea)) {
        reply.code(400);
        return apiError("INVALID_TD_AREA", "tdArea must be a two-character TD area code");
      }
      const result = await pool.query<DefinitionRow>(
        `select * from s_class_definition where td_area = $1 order by address, bit`,
        [request.params.tdArea],
      );
      return { definitions: result.rows.map(definitionResponse) };
    },
  );

  app.put<{ Params: { tdArea: string; address: string; bit: string }; Body: unknown }>(
    "/api/v1/admin/s-class/areas/:tdArea/definitions/:address/:bit",
    async (request, reply) => {
      const { tdArea } = request.params;
      const address = canonicalAddress(request.params.address);
      const bit = parseBit(request.params.bit);
      if (!isTdArea(tdArea) || address === null || bit === null) {
        reply.code(400);
        return apiError("INVALID_BIT", "Expected a TD area, a hex address and a bit 0-7");
      }
      const parsed = parseDefinitionBody(request.body);
      if (!parsed.ok) {
        reply.code(400);
        return apiError("INVALID_DEFINITION", parsed.message);
      }
      const changedBy = request.authSession?.username ?? "unknown";
      const client = await pool.connect();
      try {
        await client.query("begin");
        const outcome = await upsertDefinition(
          client,
          { tdArea, address, bit },
          parsed.value,
          changedBy,
          null,
        );
        await client.query("commit");
        const saved = await pool.query<DefinitionRow>(
          `select * from s_class_definition where td_area = $1 and address = $2 and bit = $3`,
          [tdArea, address, bit],
        );
        return { outcome, definition: definitionResponse(saved.rows[0]!) };
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete<{ Params: { tdArea: string; address: string; bit: string } }>(
    "/api/v1/admin/s-class/areas/:tdArea/definitions/:address/:bit",
    async (request, reply) => {
      const { tdArea } = request.params;
      const address = canonicalAddress(request.params.address);
      const bit = parseBit(request.params.bit);
      if (!isTdArea(tdArea) || address === null || bit === null) {
        reply.code(400);
        return apiError("INVALID_BIT", "Expected a TD area, a hex address and a bit 0-7");
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const removed = await client.query<DefinitionRow>(
          `delete from s_class_definition where td_area = $1 and address = $2 and bit = $3
           returning *`,
          [tdArea, address, bit],
        );
        const previous = removed.rows[0];
        if (!previous) {
          await client.query("rollback");
          reply.code(404);
          return apiError("DEFINITION_NOT_FOUND", `${tdArea} ${address}:${bit} has no definition`);
        }
        await writeRevision(client, {
          tdArea,
          address,
          bit,
          action: "delete",
          previous,
          next: null,
          importBatch: null,
          changedBy: request.authSession?.username ?? "unknown",
        });
        await client.query("commit");
        reply.code(204);
        return null;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },
  );

  /**
   * Paste-import of a published/community table (ADR 0013 decision 6). `radix` is required —
   * never guessed. `dryRun` (default true) only reports: parse errors/warnings and, per row,
   * whether it is new, unchanged, or conflicts with an existing definition. Committing refuses
   * while there are parse errors, and only overwrites conflicting existing definitions when
   * `overwriteConflicts` is set. Every change is recorded in the revision log under one batch id.
   */
  app.post<{
    Params: { tdArea: string };
    Body: {
      text?: string;
      radix?: string;
      source?: string;
      dryRun?: boolean;
      overwriteConflicts?: boolean;
    };
  }>("/api/v1/admin/s-class/areas/:tdArea/definitions/import", async (request, reply) => {
    const { tdArea } = request.params;
    const body = request.body ?? {};
    if (!isTdArea(tdArea)) {
      reply.code(400);
      return apiError("INVALID_TD_AREA", "tdArea must be a two-character TD area code");
    }
    if (body.radix !== "hex" && body.radix !== "decimal") {
      reply.code(400);
      return apiError(
        "RADIX_REQUIRED",
        'radix must be "hex" or "decimal" — byte numbering differs between published tables and is never guessed',
      );
    }
    const source = body.source ?? "wiki";
    if (!DEFINITION_SOURCES.includes(source as DefinitionSource)) {
      reply.code(400);
      return apiError(
        "INVALID_DEFINITION",
        `source must be one of ${DEFINITION_SOURCES.join(", ")}`,
      );
    }
    if (typeof body.text !== "string" || body.text.trim() === "") {
      reply.code(400);
      return apiError("EMPTY_IMPORT", "text is required");
    }
    const parsed = parseSClassDefinitionTable(body.text, body.radix as SClassByteRadix);
    const existing = await pool.query<DefinitionRow>(
      `select * from s_class_definition where td_area = $1`,
      [tdArea],
    );
    const existingByBit = new Map(existing.rows.map((row) => [`${row.address}:${row.bit}`, row]));
    const rows = parsed.definitions.map((definition) => {
      const current = existingByBit.get(`${definition.address}:${definition.bit}`);
      const status = !current
        ? "new"
        : current.label === definition.label &&
            current.destination === definition.destination &&
            current.kind === definition.kind
          ? "unchanged"
          : "conflict";
      return {
        line: definition.line,
        address: definition.address,
        bit: definition.bit,
        kind: definition.kind,
        label: definition.label,
        destination: definition.destination,
        status,
        existing: current ? definitionResponse(current) : null,
      };
    });
    const report = {
      tdArea,
      radix: body.radix,
      source,
      rows,
      counts: {
        new: rows.filter((r) => r.status === "new").length,
        unchanged: rows.filter((r) => r.status === "unchanged").length,
        conflict: rows.filter((r) => r.status === "conflict").length,
        skippedUnidentified: parsed.skippedUnidentified,
        ignoredLines: parsed.ignoredLines,
      },
      errors: parsed.errors,
      warnings: parsed.warnings,
    };

    if (body.dryRun !== false) return { ...report, committed: false };
    if (parsed.errors.length > 0) {
      reply.code(422);
      return apiError("IMPORT_HAS_ERRORS", "Fix the parse errors before importing", {
        errors: parsed.errors,
      });
    }

    const batch = randomUUID();
    const changedBy = request.authSession?.username ?? "unknown";
    const client = await pool.connect();
    let applied = 0;
    try {
      await client.query("begin");
      for (const row of rows) {
        if (row.status === "unchanged") continue;
        if (row.status === "conflict" && body.overwriteConflicts !== true) continue;
        const outcome = await upsertDefinition(
          client,
          { tdArea, address: row.address, bit: row.bit },
          {
            kind: row.kind,
            label: row.label,
            destination: row.destination,
            source: source as DefinitionSource,
            notes: null,
          },
          changedBy,
          batch,
        );
        if (outcome !== "unchanged") applied += 1;
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    return { ...report, committed: true, applied, importBatch: batch };
  });
}

/**
 * Read-only S-Class lookups for the map editor (any `editor`-role session, not just admins): the
 * areas with decoded S-Class data, and an area's definitions — so a signal can be bound by picking
 * a label like "S3003" instead of typing an address and bit.
 */
export async function registerSClassEditorRoutes(
  app: FastifyInstance,
  deps: SClassAdminRoutesDeps,
): Promise<void> {
  const { pool } = deps;

  app.get("/api/v1/editor/s-class/areas", async () => {
    const result = await pool.query<{ td_area: string }>(
      `select distinct td_area from td_s_current_state
        where projection_version = $1 and byte_value is not null
        order by td_area`,
      [TD_S_STATE_PROJECTION_VERSION],
    );
    return { areas: result.rows.map((row) => row.td_area) };
  });

  app.get<{ Params: { tdArea: string } }>(
    "/api/v1/editor/s-class/areas/:tdArea/definitions",
    async (request, reply) => {
      if (!isTdArea(request.params.tdArea)) {
        reply.code(400);
        return apiError("INVALID_TD_AREA", "tdArea must be a two-character TD area code");
      }
      const result = await pool.query<DefinitionRow>(
        `select * from s_class_definition where td_area = $1 order by address, bit`,
        [request.params.tdArea],
      );
      return { definitions: result.rows.map(definitionResponse) };
    },
  );
}
