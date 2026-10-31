/**
 * Merge mode for `recover-td-from-openrail-log` (2026-10-31): recovery for a window where RLM holds
 * part of the TD stream and the rest is recovered from openrail-eps, interleaved (31 Oct
 * 06:43–06:54, when ingest fell behind and the broker dropped ~40% of frames). The gap mode in
 * recoverTdFromOpenrailLog.ts assumes RLM holds nothing inside the window; this one replays each
 * affected berth's and S-Class byte's whole window, held and recovered events together in
 * openrail-eps's arrival order (td/recovery/mergePlan.ts), and updates RLM's existing rows in
 * place rather than replacing them.
 *
 * Same two phases and safety rules as the gap mode: planning reads in one `read only`
 * transaction and writes nothing; `--execute` archives the excerpt and applies everything in one
 * short write transaction (`lock_timeout` 3 s, `statement_timeout` 30 s). Planning refuses when
 * RLM's own events, replayed alone, don't reproduce what the database holds, so a wrong order or
 * a wrong match can never be written.
 */
import { basename } from "node:path";
import type { PoolClient } from "pg";
import {
  trackRefreshSweep,
  TD_INGEST_LAG_LOSS_REASON,
  TD_PROJECTION_VERSION,
  TD_S_STATE_PROJECTION_VERSION,
  sBits,
} from "@railway/domain";
import type { Config } from "../config.js";
import { nrIdentity, type RecoveredTdMessage } from "../td/recovery/openrailTddbLog.js";
import {
  planBerthMerge,
  planByteMerge,
  type BerthMergePlan,
  type ByteMergePlan,
  type BytePreState,
  type ExistingOccupancy,
  type MergeBerthEvent,
  type MergeByteEvent,
} from "../td/recovery/mergePlan.js";
import type { BerthEventRef, SByteEventRef } from "../td/recovery/repairPlan.js";
import { insertRecoveredRows } from "./recoverTdFromOpenrailLog.js";

export interface MergeArgs {
  file: string;
  from: Date;
  to: Date;
  /** How far after the window to look for each berth's / byte's first event. */
  postWindowHours: number;
  sPostWindowHours: number;
  /** Berths to print in full, e.g. `PX:0286`. */
  showBerths: string[];
  /** When given, the outage to record (`td_ingest_lag_loss`) alongside the recovery. */
  outage: { from: Date; to: Date } | null;
  refreshesSkipped: number;
}

type Payload = Record<string, string>;
const payloadOf = (m: RecoveredTdMessage): Payload => Object.values(m.rawEventJson)[0]!;
const REC = "rec:";
/** Rows per statement for the big transition writes: one 171k-row insert passed the 30 s statement
 * limit on cold reads (31 Oct, rolled back cleanly). */
const CHUNK = 20_000;

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}
const S_PRE_LOOKBACK_HOURS = 6;

export interface MergePlan {
  /** Messages to insert (recovered), in excerpt order; their index is their `rec:` id. */
  messages: RecoveredTdMessage[];
  held: number;
  /** Held rows openrail-eps has no line for, by event type (SG/SH refreshes expected). */
  unmatched: Record<string, number>;
  maxWindowSeq: string;
  berths: BerthMergePlan[];
  bytes: ByteMergePlan[];
  anomaliesToRemove: number;
  transitionsToRemove: number;
  bytesWithUnknownPreValue: number;
  /** The last instant any replaced row can have (anomaly / transition deletes are bounded by it). */
  replaceUntil: Date;
}

interface Original {
  id: string;
  normalizedAt: Date;
  seq: string;
  eventType: string;
  json: Record<string, Payload>;
}

export async function buildMergePlan(
  db: PoolClient,
  args: MergeArgs,
  inWindow: RecoveredTdMessage[],
): Promise<MergePlan> {
  // ---- 1. Match every openrail line to a held row, or mark it recovered ----
  const { rows: originals } = await db.query<{
    id: string;
    normalized_event_at_utc: Date;
    seq: string;
    event_type: string;
    raw_event_json: Record<string, Payload>;
  }>(
    `select id::text, normalized_event_at_utc, ingestion_sequence::text as seq, event_type, raw_event_json
       from raw_feed_event
      where feed_name = 'TD' and recovery_source is null
        and normalized_event_at_utc >= $1 and normalized_event_at_utc <= $2`,
    [args.from, args.to],
  );
  const byIdentity = new Map<string, Original[]>();
  let maxWindowSeq = 0n;
  for (const r of originals) {
    const k = nrIdentity(r.raw_event_json);
    const list = byIdentity.get(k) ?? [];
    list.push({
      id: r.id,
      normalizedAt: r.normalized_event_at_utc,
      seq: r.seq,
      eventType: r.event_type,
      json: r.raw_event_json,
    });
    byIdentity.set(k, list);
    if (BigInt(r.seq) > maxWindowSeq) maxWindowSeq = BigInt(r.seq);
  }
  for (const list of byIdentity.values())
    list.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));

  const messages: RecoveredTdMessage[] = [];
  /** Per excerpt line (inWindow order): the held row it is, or its recovered index. */
  const resolved: ({ held: Original } | { rec: number })[] = [];
  for (const m of inWindow) {
    const list = byIdentity.get(nrIdentity(m.rawEventJson));
    const held = list?.shift();
    if (held) resolved.push({ held });
    else {
      resolved.push({ rec: messages.length });
      messages.push(m);
    }
  }
  if (messages.length === 0) throw new Error("Nothing to recover.");
  const unmatched: Record<string, number> = {};
  const unmatchedC: Original[] = [];
  for (const list of byIdentity.values()) {
    for (const o of list) {
      unmatched[o.eventType] = (unmatched[o.eventType] ?? 0) + 1;
      if (["CA", "CB", "CC"].includes(o.eventType)) unmatchedC.push(o);
    }
  }

  const refOf = (
    i: number,
  ): {
    rawEventId: string;
    rawEventNormalizedAt: Date;
    ingestionSequence: string;
    recovered: boolean;
  } => {
    const r = resolved[i]!;
    const m = inWindow[i]!;
    return "held" in r
      ? {
          rawEventId: r.held.id,
          rawEventNormalizedAt: r.held.normalizedAt,
          ingestionSequence: r.held.seq,
          recovered: false,
        }
      : {
          rawEventId: `${REC}${r.rec}`,
          rawEventNormalizedAt: m.eventAt,
          ingestionSequence: `${REC}${r.rec}`,
          recovered: true,
        };
  };

  // ---- 2. Berths: every berth a recovered C-Class message touches ----
  const affected = new Set<string>();
  for (const m of messages) {
    if (m.type !== "CA" && m.type !== "CB" && m.type !== "CC") continue;
    const p = payloadOf(m);
    if (p.from) affected.add(`${m.tdArea}|${p.from}`);
    if (p.to) affected.add(`${m.tdArea}|${p.to}`);
  }
  // A held step openrail-eps never logged has no place in the arrival order: refuse if it touches
  // a berth being replayed; elsewhere it is untouched and only listed.
  const touchesAffected = (o: Original): boolean => {
    const p = Object.values(o.json)[0]!;
    const area = p.area_id!;
    return [p.from, p.to].some((b) => b && affected.has(`${area}|${b}`));
  };
  for (const o of unmatchedC) {
    console.error(`[plan] held ${o.eventType} with no openrail line: ${JSON.stringify(o.json)}`);
  }
  const blocking = unmatchedC.filter(touchesAffected);
  if (blocking.length > 0) {
    throw new Error(
      `Refusing: ${blocking.length} held C-Class row(s) on replayed berths have no openrail-eps line, so their order is unknown.`,
    );
  }
  const events = new Map<string, MergeBerthEvent[]>([...affected].map((k) => [k, []]));
  inWindow.forEach((m, i) => {
    if (m.type !== "CA" && m.type !== "CB" && m.type !== "CC") return;
    const p = payloadOf(m);
    for (const [berth, role] of [
      [p.from, "from"],
      [p.to, "to"],
    ] as const) {
      if (!berth) continue;
      const list = events.get(`${m.tdArea}|${berth}`);
      if (!list) continue;
      list.push({ ...refOf(i), eventAt: m.eventAt, type: m.type, description: p.descr!, role });
    }
  });

  const keys = [...affected];
  const areas = keys.map((k) => k.split("|")[0]!);
  const berthCodes = keys.map((k) => k.split("|")[1]!);

  const { rows: preRows } = await db.query<{
    a: string;
    b: string;
    id: string;
    description: string;
    entered_at: Date;
    left_at: Date | null;
    exit_event_id: string | null;
  }>(
    `select w.a, w.b, bo.id::text, bo.description, bo.entered_at, bo.left_at, bo.exit_event_id::text
       from unnest($2::text[], $3::text[]) w(a, b)
       cross join lateral (
         select id, description, entered_at, left_at, exit_event_id from berth_occupancy
          where projection_version = $1 and td_area = w.a and berth_code = w.b and entered_at < $4
          order by entered_at desc limit 1
       ) bo
      where bo.left_at is null or bo.left_at >= $4`,
    [TD_PROJECTION_VERSION, areas, berthCodes, args.from],
  );
  const pre = new Map<string, ExistingOccupancy>(
    preRows.map((r) => [
      `${r.a}|${r.b}`,
      {
        occupancyId: r.id,
        entryEventId: null,
        description: r.description,
        enteredAt: r.entered_at,
        leftAt: r.left_at,
        exitEventId: r.exit_event_id,
      },
    ]),
  );

  const { rows: inRows } = await db.query<{
    a: string;
    b: string;
    id: string;
    entry_event_id: string;
    description: string;
    entered_at: Date;
    left_at: Date | null;
    exit_event_id: string | null;
  }>(
    `select w.a, w.b, bo.id::text, bo.entry_event_id::text, bo.description, bo.entered_at, bo.left_at,
            bo.exit_event_id::text
       from unnest($2::text[], $3::text[]) w(a, b)
       cross join lateral (
         select id, entry_event_id, description, entered_at, left_at, exit_event_id from berth_occupancy
          where projection_version = $1 and td_area = w.a and berth_code = w.b
            and entered_at >= $4 and entered_at <= $5
       ) bo`,
    [TD_PROJECTION_VERSION, areas, berthCodes, args.from, args.to],
  );
  const existing = new Map<string, ExistingOccupancy[]>();
  for (const r of inRows) {
    const k = `${r.a}|${r.b}`;
    existing.set(k, [
      ...(existing.get(k) ?? []),
      {
        occupancyId: r.id,
        entryEventId: r.entry_event_id,
        description: r.description,
        enteredAt: r.entered_at,
        leftAt: r.left_at,
        exitEventId: r.exit_event_id,
      },
    ]);
  }

  // First held event per berth after the window. Each berth's next occupancy change (cheap, by
  // index) bounds how far its area's events need reading; then one bounded read per area.
  const { rows: nextRows } = await db.query<{ a: string; b: string; t: Date | null }>(
    `select w.a, w.b, least(
         (select min(entered_at) from berth_occupancy
           where projection_version = $1 and td_area = w.a and berth_code = w.b and entered_at > $4),
         (select case when left_at > $4 then left_at end from berth_occupancy
           where projection_version = $1 and td_area = w.a and berth_code = w.b and entered_at <= $4
           order by entered_at desc limit 1)
       ) as t
       from unnest($2::text[], $3::text[]) w(a, b)`,
    [TD_PROJECTION_VERSION, areas, berthCodes, args.to],
  );
  const cap = new Date(args.to.getTime() + args.postWindowHours * 3_600_000);
  const untilByArea = new Map<string, Date>();
  for (const r of nextRows) {
    const t = r.t && r.t < cap ? r.t : cap;
    const cur = untilByArea.get(r.a);
    if (!cur || t > cur) untilByArea.set(r.a, t);
  }
  const { rows: post } = await db.query<{
    raw_event_id: string;
    raw_event_normalized_at_utc: Date;
    td_area: string;
    message_type: "CA" | "CB" | "CC";
    from_berth: string | null;
    to_berth: string | null;
    description: string | null;
    event_at: Date;
    ingestion_sequence: string;
  }>(
    `with a as (select * from unnest($1::text[], $2::timestamptz[]) a(area, until)),
     w as materialized (
       select e.raw_event_id, e.raw_event_normalized_at_utc, e.td_area, e.message_type, e.from_berth,
              e.to_berth, e.description, e.event_at, e.ingestion_sequence
         from a join td_berth_event e on e.td_area = a.area and e.event_at > $3 and e.event_at <= a.until
        where e.message_type in ('CA', 'CB', 'CC') and not e.recovered
     )
     select raw_event_id::text, raw_event_normalized_at_utc, td_area, message_type, from_berth, to_berth,
            description, event_at, ingestion_sequence::text
       from w order by ingestion_sequence`,
    [[...untilByArea.keys()], [...untilByArea.values()], args.to],
  );
  const firstPost = new Map<string, BerthEventRef>();
  for (const e of post) {
    for (const [berth, role] of [
      [e.from_berth, "from"],
      [e.to_berth, "to"],
    ] as const) {
      if (!berth) continue;
      const k = `${e.td_area}|${berth}`;
      if (!affected.has(k) || firstPost.has(k)) continue;
      firstPost.set(k, {
        rawEventId: e.raw_event_id,
        rawEventNormalizedAt: e.raw_event_normalized_at_utc,
        eventAt: e.event_at,
        ingestionSequence: e.ingestion_sequence,
        type: e.message_type,
        description: e.description ?? "",
        role,
      });
    }
  }
  const idle = keys.filter((k) => !firstPost.has(k));
  if (idle.length > 0) {
    const { rows } = await db.query<{ seq: string }>(
      `select source_ingestion_sequence::text as seq from berth_current_state
         join unnest($2::text[], $3::text[]) w(a, b) on td_area = w.a and berth_code = w.b
        where projection_version = $1`,
      [TD_PROJECTION_VERSION, idle.map((k) => k.split("|")[0]), idle.map((k) => k.split("|")[1])],
    );
    if (rows.some((r) => BigInt(r.seq) > maxWindowSeq)) {
      throw new Error(
        `Refusing: some berths have events after the ${args.postWindowHours} h post window; raise --post-window-hours.`,
      );
    }
  }

  const berths = keys.map((k) => {
    const [tdArea, berth] = k.split("|") as [string, string];
    return planBerthMerge({
      tdArea,
      berth,
      pre: pre.get(k) ?? null,
      events: events.get(k)!,
      firstPost: firstPost.get(k) ?? null,
      existing: existing.get(k) ?? [],
    });
  });

  // ---- 3. S-Class bytes every recovered SF states ----
  const lineOfHeld = new Map<string, number>();
  inWindow.forEach((m, i) => {
    const r = resolved[i]!;
    if ("held" in r) lineOfHeld.set(r.held.id, m.lineNumber);
  });
  const recoveredSf = new Map<string, MergeByteEvent[]>();
  messages.forEach((m, index) => {
    if (m.type !== "SF") return;
    const p = payloadOf(m);
    const k = `${m.tdArea}|${p.address}`;
    recoveredSf.set(k, [
      ...(recoveredSf.get(k) ?? []),
      {
        rawEventId: `${REC}${index}`,
        rawEventNormalizedAt: m.eventAt,
        eventAt: m.eventAt,
        ingestionSequence: `${REC}${index}`,
        value: Number.parseInt(p.data!, 16),
        sourceKind: "update",
        recovered: true,
        line: m.lineNumber,
      } as MergeByteEvent & { line: number },
    ]);
  });
  const byteKeys = [...recoveredSf.keys()];
  const pairs = new Set<string>();
  for (const k of byteKeys) {
    const [area, address] = k.split("|") as [string, string];
    const start = Number.parseInt(address, 16);
    for (let d = 0; d < 4 && start - d >= 0; d += 1) {
      pairs.add(`${area}|${(start - d).toString(16).toUpperCase().padStart(2, "0")}`);
    }
  }
  const pairList = [...pairs].map((p) => p.split("|") as [string, string]);
  const { rows: sRows } =
    byteKeys.length === 0
      ? { rows: [] }
      : await db.query<{
          raw_event_id: string;
          raw_event_normalized_at_utc: Date;
          td_area: string;
          message_type: string;
          decoded_bitset: { bytes: Record<string, number> } | null;
          event_at: Date;
          ingestion_sequence: string;
        }>(
          `with p as (select distinct * from unnest($4::text[], $5::text[]) as p(area, addr)),
           w as materialized (
             select e.raw_event_id, e.raw_event_normalized_at_utc, e.td_area, e.message_type, e.decoded_bitset,
                    e.event_at, e.ingestion_sequence
               from td_s_event e join p on e.td_area = p.area and e.address = p.addr
              where e.td_area = any(array(select distinct area from p)) and e.decode_status = 'decoded'
                and e.event_at >= $1::timestamptz - make_interval(hours => $3)
                and e.event_at <= $2::timestamptz + make_interval(hours => $6)
           )
           select raw_event_id::text, raw_event_normalized_at_utc, td_area, message_type, decoded_bitset, event_at,
                  ingestion_sequence::text
             from w order by ingestion_sequence`,
          [
            args.from,
            args.to,
            S_PRE_LOOKBACK_HOURS,
            pairList.map((p) => p[0]),
            pairList.map((p) => p[1]),
            args.sPostWindowHours,
          ],
        );
  const preValue = new Map<string, number>();
  const preState = new Map<string, BytePreState>();
  const heldS = new Map<string, (MergeByteEvent & { line: number })[]>();
  // A held refresh has no openrail line (refresh lines are left out). Its arrival position is
  // just after the latest matched held message before it in ingestion order, since sequences
  // follow arrival order.
  const matchedBySeq = inWindow
    .flatMap((m, i) => {
      const r = resolved[i]!;
      return "held" in r ? [{ seq: BigInt(r.held.seq), line: m.lineNumber }] : [];
    })
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  const lineBefore = (seq: bigint): number => {
    let lo = 0;
    let hi = matchedBySeq.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (matchedBySeq[mid]!.seq < seq) {
        found = matchedBySeq[mid]!.line;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found + 0.5;
  };
  const sFirstPost = new Map<string, SByteEventRef>();
  for (const e of sRows) {
    for (const [address, value] of Object.entries(e.decoded_bitset?.bytes ?? {})) {
      const k = `${e.td_area}|${address}`;
      if (!recoveredSf.has(k)) continue;
      const ref = {
        rawEventId: e.raw_event_id,
        rawEventNormalizedAt: e.raw_event_normalized_at_utc,
        eventAt: e.event_at,
        ingestionSequence: e.ingestion_sequence,
        value,
        sourceKind: (e.message_type === "SF_MSG" ? "update" : "refresh") as "update" | "refresh",
      };
      if (e.event_at < args.from) {
        preValue.set(k, value);
        preState.set(k, { value, sourceKind: ref.sourceKind, statedAt: e.event_at });
      } else if (e.event_at <= args.to) {
        const line = lineOfHeld.get(e.raw_event_id) ?? lineBefore(BigInt(e.ingestion_sequence));
        heldS.set(k, [...(heldS.get(k) ?? []), { ...ref, recovered: false, line }]);
      } else if (!sFirstPost.has(k)) sFirstPost.set(k, ref);
    }
  }
  // A byte not stated in the lookback still has a known value from earlier. Its events can't be
  // searched by address (td_s_event is indexed by area and time only; 7 days of three quiet areas
  // timed out), but its bit transitions can: each bit's latest transition before the window is its
  // value going in (every known bit has one, from when it first became known). 31 Oct: 4 bytes,
  // e.g. MH:33, whose replay otherwise starts from unknown bits.
  const olderBits = new Map<string, (boolean | null)[]>();
  const noPre = byteKeys.filter((k) => !preValue.has(k));
  if (noPre.length > 0) {
    const probes = noPre.flatMap((k) => {
      const [area, address] = k.split("|") as [string, string];
      return [0, 1, 2, 3, 4, 5, 6, 7].map((bit) => [area, address, bit] as const);
    });
    const { rows: lastBits } = await db.query<{
      a: string;
      ad: string;
      bit: number;
      new_value: boolean;
      event_at: Date;
      source_kind: string;
    }>(
      `select w.a, w.ad, w.bit, t.new_value, t.event_at, t.source_kind
         from unnest($2::text[], $3::text[], $4::int[]) w(a, ad, bit)
         cross join lateral (
           select new_value, event_at, source_kind from td_s_bit_transition
            where projection_version = $1 and td_area = w.a and address = w.ad and bit_index = w.bit
              and event_at < $5
            order by event_at desc limit 1
         ) t`,
      [
        TD_S_STATE_PROJECTION_VERSION,
        probes.map((p) => p[0]),
        probes.map((p) => p[1]),
        probes.map((p) => p[2]),
        args.from,
      ],
    );
    for (const k of noPre) {
      const [area, address] = k.split("|") as [string, string];
      const mine = lastBits.filter((r) => r.a === area && r.ad === address);
      if (mine.length === 0) continue;
      const bits = Array<boolean | null>(8).fill(null);
      for (const r of mine) bits[r.bit] = r.new_value;
      olderBits.set(k, bits);
      const latest = mine.sort((x, y) => y.event_at.getTime() - x.event_at.getTime())[0]!;
      if (bits.every((b) => b !== null)) {
        const value = bits.reduce((v, on, i) => (on ? v | (1 << i) : v), 0);
        preState.set(k, {
          value,
          sourceKind: latest.source_kind === "update" ? "update" : "refresh",
          statedAt: latest.event_at,
        });
      }
    }
  }
  const sIdle = byteKeys.filter((k) => !sFirstPost.has(k));
  if (sIdle.length > 0) {
    const { rows: cur } = await db.query<{ seq: string }>(
      `select source_ingestion_sequence::text as seq from td_s_current_state
         join unnest($2::text[], $3::text[]) w(a, ad) on td_area = w.a and address = w.ad
        where projection_version = $1`,
      [
        TD_S_STATE_PROJECTION_VERSION,
        sIdle.map((k) => k.split("|")[0]),
        sIdle.map((k) => k.split("|")[1]),
      ],
    );
    if (cur.some((r) => BigInt(r.seq) > maxWindowSeq)) {
      throw new Error(
        `Refusing: some S-Class bytes have events after the ${args.sPostWindowHours} h post window; raise --s-post-window-hours.`,
      );
    }
  }
  // Existing transitions from the events whose transitions get replaced, per byte: one exact
  // (area, address, event time, source event) probe each, never a time-range scan.
  const trQuads = byteKeys.flatMap((k) => {
    const [area, address] = k.split("|") as [string, string];
    const refs = [...(heldS.get(k) ?? []), ...(sFirstPost.has(k) ? [sFirstPost.get(k)!] : [])];
    return refs.map((e) => ({ area, address, id: e.rawEventId, at: e.eventAt }));
  });
  const sUntil = new Date(
    Math.max(args.to.getTime(), ...[...sFirstPost.values()].map((e) => e.eventAt.getTime())),
  );
  const { rows: trRows } =
    trQuads.length === 0
      ? { rows: [] }
      : await db.query<{ a: string; ad: string; n: number }>(
          `select t.td_area as a, t.address as ad, count(*)::int as n
             from unnest($2::text[], $3::text[], $4::bigint[], $5::timestamptz[]) w(a, ad, id, at)
             join td_s_bit_transition t
               on t.projection_version = $1 and t.td_area = w.a and t.address = w.ad
              and t.event_at = w.at and t.source_event_id = w.id
            group by 1, 2`,
          [
            TD_S_STATE_PROJECTION_VERSION,
            trQuads.map((q) => q.area),
            trQuads.map((q) => q.address),
            trQuads.map((q) => q.id),
            trQuads.map((q) => q.at),
          ],
        );
  const trCount = new Map(trRows.map((r) => [`${r.a}|${r.ad}`, r.n]));

  // When each refresh chunk's sweep began, tracked per area exactly as the projector does
  // (trackRefreshSweep): a chunk at 00, or any chunk while none is open, opens a sweep; SH closes
  // it. Read for the affected areas from a little before the window, so a sweep open at its
  // start is known, to the last first-post statement.
  const sAreas = [...new Set(byteKeys.map((k) => k.split("|")[0]!))];
  const { rows: refreshRows } =
    sAreas.length === 0
      ? { rows: [] }
      : await db.query<{
          raw_event_id: string;
          td_area: string;
          message_type: string;
          address: string;
          raw_event_normalized_at_utc: Date;
        }>(
          `with w as materialized (
             select raw_event_id, td_area, message_type, address, raw_event_normalized_at_utc, ingestion_sequence
               from td_s_event
              where td_area = any($1::text[]) and message_type in ('SG_MSG', 'SH_MSG')
                and event_at >= $2::timestamptz - interval '10 minutes' and event_at <= $3
           )
           select raw_event_id::text, td_area, message_type, address, raw_event_normalized_at_utc
             from w order by ingestion_sequence`,
          [sAreas, args.from, sUntil],
        );
  const sweepOf = new Map<string, Date>();
  const openSweeps = new Map<string, Date>();
  for (const r of refreshRows) {
    const at = trackRefreshSweep(openSweeps, {
      tdArea: r.td_area,
      sourceKind: "refresh",
      messageType: r.message_type === "SH_MSG" ? "SH" : "SG",
      bytes: [{ address: r.address, value: 0 }],
      eventNormalizedAt: r.raw_event_normalized_at_utc,
    });
    if (at) sweepOf.set(r.raw_event_id, at);
  }
  const withSweep = <T extends SByteEventRef>(e: T): T & { sweepStartedAt: Date | null } => ({
    ...e,
    sweepStartedAt: e.sourceKind === "refresh" ? (sweepOf.get(e.rawEventId) ?? null) : null,
  });
  let unknownPre = 0;
  const bytes = byteKeys.map((k) => {
    const [tdArea, address] = k.split("|") as [string, string];
    const v = preValue.get(k);
    if (v === undefined && !olderBits.has(k)) unknownPre += 1;
    const ordered = [
      ...(heldS.get(k) ?? []).map(withSweep),
      ...(recoveredSf.get(k) as (MergeByteEvent & { line: number })[]),
    ].sort((a, b) => a.line - b.line);
    return planByteMerge({
      tdArea,
      address,
      preBits:
        v !== undefined ? sBits(v) : (olderBits.get(k) ?? Array<boolean | null>(8).fill(null)),
      pre: preState.get(k) ?? null,
      events: ordered,
      firstPost: sFirstPost.has(k) ? withSweep(sFirstPost.get(k)!) : null,
      existingTransitions: trCount.get(k) ?? 0,
    });
  });

  // ---- 4. Anomalies the berth plans replace: exact probes, as for transitions ----
  const anQuads = berths.flatMap((b) =>
    b.replaceAnomaliesOf.map((e) => ({
      area: b.tdArea,
      berth: b.berth,
      id: e.rawEventId,
      at: e.eventAt,
    })),
  );
  const replaceUntil = new Date(
    Math.max(
      args.to.getTime(),
      sUntil.getTime(),
      ...[...firstPost.values()].map((e) => e.eventAt.getTime()),
    ),
  );
  const { rows: an } =
    anQuads.length === 0
      ? { rows: [{ n: 0 }] }
      : await db.query<{ n: number }>(
          `select count(*)::int as n
             from unnest($2::text[], $3::text[], $4::bigint[], $5::timestamptz[]) w(area, berth, id, at)
             join td_projection_anomaly a
               on a.projection_version = $1 and a.td_area = w.area and a.event_at = w.at
              and a.berth_code = w.berth and a.raw_event_id = w.id`,
          [
            TD_PROJECTION_VERSION,
            anQuads.map((q) => q.area),
            anQuads.map((q) => q.berth),
            anQuads.map((q) => q.id),
            anQuads.map((q) => q.at),
          ],
        );

  return {
    messages,
    held: inWindow.length - messages.length,
    unmatched,
    maxWindowSeq: maxWindowSeq.toString(),
    berths,
    bytes,
    anomaliesToRemove: an[0]?.n ?? 0,
    transitionsToRemove: trRows.reduce((n, r) => n + r.n, 0),
    bytesWithUnknownPreValue: unknownPre,
    replaceUntil,
  };
}

const iso = (d: Date | null | undefined): string => (d ? d.toISOString() : "—");

export function printMergePlan(args: MergeArgs, fileSha: string, plan: MergePlan): void {
  const count = (t: string) => plan.messages.filter((m) => m.type === t).length;
  const b = plan.berths;
  const s = plan.bytes;
  const checkRows = b.reduce((n, p) => n + p.check.rows, 0);
  const checkOk = b.reduce((n, p) => n + p.check.reproduced, 0);
  const sExisting = s.reduce((n, p) => n + p.check.existing, 0);
  const sOwn = s.reduce((n, p) => n + p.check.reproduced, 0);
  console.log(`MERGE MODE  excerpt ${basename(args.file)} sha256=${fileSha}`);
  console.log(
    `window ${iso(args.from)} .. ${iso(args.to)}: ${plan.held + plan.messages.length} openrail lines; ${plan.held} held by RLM, ${plan.messages.length} to recover ` +
      `(CA ${count("CA")}, CB ${count("CB")}, CC ${count("CC")}, CT ${count("CT")}, SF ${count("SF")}); ${args.refreshesSkipped} SG/SH refresh lines left out`,
  );
  console.log(`held rows with no openrail line, by type: ${JSON.stringify(plan.unmatched)}`);
  console.log(
    `berths: ${b.length}; rows re-closed ${b.reduce((n, p) => n + p.updates.length, 0)}; rows inserted ${b.reduce((n, p) => n + p.inserts.length, 0)}; ` +
      `anomalies removed ${plan.anomaliesToRemove} / added ${b.reduce((n, p) => n + p.anomalies.length, 0)}; current state fixed ${b.filter((p) => p.currentState).length}; ` +
      `missing rows ${b.reduce((n, p) => n + p.missingRows, 0)}`,
  );
  console.log(
    `  CHECK: RLM's own events replayed alone reproduce ${checkOk} / ${checkRows} existing rows exactly`,
  );
  console.log(
    `S-Class bytes: ${s.length} (${plan.bytesWithUnknownPreValue} with no value in the ${S_PRE_LOOKBACK_HOURS} h before); ` +
      `transitions removed ${plan.transitionsToRemove} / added ${s.reduce((n, p) => n + p.transitions.length, 0)}; current state fixed ${s.filter((p) => p.currentState).length}`,
  );
  console.log(
    `  CHECK: RLM's own S events replayed alone give ${sOwn} transitions; the database has ${sExisting}`,
  );
  const sOff = s.filter((p) => p.check.reproduced !== p.check.existing);
  if (sOff.length > 0) {
    console.log(`  bytes that differ: ${sOff.length}`);
    for (const p of sOff.slice(0, 15)) {
      console.log(
        `    ${p.tdArea}:${p.address} replay ${p.check.reproduced} / db ${p.check.existing}` +
          `${p.unknownPre ? " (no value before the window)" : ""}`,
      );
    }
  }
  for (const want of args.showBerths) {
    const [area, berth] = want.split(":");
    const p = b.find((x) => x.tdArea === area && x.berth === berth);
    if (!p) {
      console.log(`${want}: not touched by any recovered message`);
      continue;
    }
    console.log(`--- ${want} ---`);
    console.log(`  check ${p.check.reproduced}/${p.check.rows}; missing rows ${p.missingRows}`);
    for (const u of p.updates) {
      console.log(
        `  re-close row ${u.occupancyId}: ${u.close ? `left ${iso(u.close.leftAt)} by ${u.close.exitEventId} (${u.close.exitReason})` : "open"}`,
      );
    }
    for (const i of p.inserts) {
      console.log(
        `  insert ${i.description} entered ${iso(i.enteredAt)} (${i.entryReason}) ${i.close ? `left ${iso(i.close.leftAt)} (${i.close.exitReason})` : "still open"}`,
      );
    }
    for (const a of p.anomalies)
      console.log(`  anomaly ${a.anomalyCode} at ${iso(a.eventAt)} on ${a.rawEventId}`);
    if (p.currentState) {
      console.log(
        `  current state -> ${p.currentState.description ?? "empty"} (from ${p.currentState.source.rawEventId})`,
      );
    }
  }
}

export async function applyMergePlan(
  db: PoolClient,
  config: Config,
  args: MergeArgs,
  fileSha: string,
  fileSize: number,
  archiveKey: string,
  plan: MergePlan,
): Promise<void> {
  const { id, seq, addCounts } = await insertRecoveredRows(
    db,
    config,
    args,
    fileSha,
    fileSize,
    archiveKey,
    plan.messages,
    "Rebuilt from openrail-eps tddb-detail.log (merge mode) for TD the broker dropped while ingest-td lagged, 2026-10-31; not an NR broker frame.",
    true,
  );
  const exitId = (ref: string | undefined): string | null => (ref ? id(ref) : null);

  // Berths: existing rows re-closed in place.
  const updates = plan.berths.flatMap((b) => b.updates);
  if (updates.length > 0) {
    const r = await db.query(
      `update berth_occupancy bo
          set left_at = u.left_at, exit_event_id = u.exit_id, exit_event_normalized_at_utc = u.exit_at,
              exit_reason = u.reason
         from unnest($1::bigint[], $2::timestamptz[], $3::bigint[], $4::timestamptz[], $5::text[]) as u(id, left_at, exit_id, exit_at, reason)
        where bo.id = u.id and bo.projection_version = $6`,
      [
        updates.map((u) => u.occupancyId),
        updates.map((u) => u.close?.leftAt ?? null),
        updates.map((u) => exitId(u.close?.exitEventId)),
        updates.map((u) => u.close?.exitEventNormalizedAt ?? null),
        updates.map((u) => u.close?.exitReason ?? null),
        TD_PROJECTION_VERSION,
      ],
    );
    if (r.rowCount !== updates.length) {
      throw new Error(
        `Refusing: ${updates.length} occupancy re-closes planned, ${r.rowCount} matched.`,
      );
    }
  }
  const inserts = plan.berths.flatMap((b) => b.inserts.map((i) => ({ b, i })));
  if (inserts.length > 0) {
    await db.query(
      `insert into berth_occupancy (projection_version, td_area, berth_code, description, entered_at, entry_event_id,
                                    entry_event_normalized_at_utc, entry_reason, left_at, exit_event_id,
                                    exit_event_normalized_at_utc, exit_reason)
       select $1, t.area, t.berth, t.descr, t.entered, t.entry_id, t.entry_at, t.entry_reason, t.left_at, t.exit_id,
              t.exit_at, t.exit_reason
         from unnest($2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::bigint[], $7::timestamptz[], $8::text[],
                     $9::timestamptz[], $10::bigint[], $11::timestamptz[], $12::text[])
           as t(area, berth, descr, entered, entry_id, entry_at, entry_reason, left_at, exit_id, exit_at, exit_reason)`,
      [
        TD_PROJECTION_VERSION,
        inserts.map((x) => x.b.tdArea),
        inserts.map((x) => x.b.berth),
        inserts.map((x) => x.i.description),
        inserts.map((x) => x.i.enteredAt),
        inserts.map((x) => id(x.i.entryEventId)),
        inserts.map((x) => x.i.entryEventNormalizedAt),
        inserts.map((x) => x.i.entryReason),
        inserts.map((x) => x.i.close?.leftAt ?? null),
        inserts.map((x) => exitId(x.i.close?.exitEventId)),
        inserts.map((x) => x.i.close?.exitEventNormalizedAt ?? null),
        inserts.map((x) => x.i.close?.exitReason ?? null),
      ],
    );
  }
  const anDel = plan.berths.flatMap((b) =>
    b.replaceAnomaliesOf.map((e) => ({
      area: b.tdArea,
      berth: b.berth,
      id: e.rawEventId,
      at: e.eventAt,
    })),
  );
  if (anDel.length > 0) {
    await db.query(
      `delete from td_projection_anomaly a
        using unnest($2::text[], $3::text[], $4::bigint[], $5::timestamptz[]) as w(area, berth, id, at)
        where a.projection_version = $1 and a.td_area = w.area and a.event_at = w.at
          and a.berth_code = w.berth and a.raw_event_id = w.id`,
      [
        TD_PROJECTION_VERSION,
        anDel.map((q) => q.area),
        anDel.map((q) => q.berth),
        anDel.map((q) => q.id),
        anDel.map((q) => q.at),
      ],
    );
  }
  const anIns = plan.berths.flatMap((b) => b.anomalies.map((a) => ({ b, a })));
  if (anIns.length > 0) {
    await db.query(
      `insert into td_projection_anomaly (projection_version, td_area, berth_code, raw_event_id, raw_event_normalized_at_utc,
                                          anomaly_code, details, event_at, ingestion_sequence)
       select $1, t.area, t.berth, t.id, t.raw_at, t.code, t.details::jsonb, t.at, t.seq
         from unnest($2::text[], $3::text[], $4::bigint[], $5::timestamptz[], $6::text[], $7::text[], $8::timestamptz[], $9::bigint[])
           as t(area, berth, id, raw_at, code, details, at, seq)`,
      [
        TD_PROJECTION_VERSION,
        anIns.map((x) => x.b.tdArea),
        anIns.map((x) => x.b.berth),
        anIns.map((x) => id(x.a.rawEventId)),
        anIns.map((x) => x.a.rawEventNormalizedAt),
        anIns.map((x) => x.a.anomalyCode),
        anIns.map((x) => JSON.stringify(x.a.details)),
        anIns.map((x) => x.a.eventAt),
        anIns.map((x) => seq(x.a.ingestionSequence)),
      ],
    );
  }
  for (const b of plan.berths) {
    if (!b.currentState) continue;
    const cs = b.currentState;
    await db.query(
      `update berth_current_state set description = $4, occupancy_id = null, occupancy_entered_at = $5, event_at = $6,
              source_event_id = $7, source_event_normalized_at_utc = $8, source_ingestion_sequence = $9, updated_at = now()
        where projection_version = $1 and td_area = $2 and berth_code = $3 and source_ingestion_sequence <= $10`,
      [
        TD_PROJECTION_VERSION,
        b.tdArea,
        b.berth,
        cs.description,
        cs.enteredAt,
        cs.source.eventAt,
        id(cs.source.rawEventId),
        cs.source.rawEventNormalizedAt,
        seq(cs.source.ingestionSequence),
        plan.maxWindowSeq,
      ],
    );
  }

  // S-Class bytes: transitions replaced, idle bytes' current state.
  const trDel = plan.bytes.flatMap((b) =>
    b.replaceTransitionsOf.map((e) => ({
      area: b.tdArea,
      address: b.address,
      id: e.rawEventId,
      at: e.eventAt,
    })),
  );
  for (const part of chunks(trDel)) {
    await db.query(
      `delete from td_s_bit_transition t
        using unnest($2::text[], $3::text[], $4::bigint[], $5::timestamptz[]) as w(a, ad, id, at)
        where t.projection_version = $1 and t.td_area = w.a and t.address = w.ad
          and t.event_at = w.at and t.source_event_id = w.id`,
      [
        TD_S_STATE_PROJECTION_VERSION,
        part.map((q) => q.area),
        part.map((q) => q.address),
        part.map((q) => q.id),
        part.map((q) => q.at),
      ],
    );
  }
  const trIns = plan.bytes.flatMap((b) => b.transitions.map((t) => ({ b, t })));
  for (const part of chunks(trIns)) {
    await db.query(
      `insert into td_s_bit_transition (projection_version, td_area, address, bit_index, previous_value, new_value, event_at,
                                        source_event_id, source_event_normalized_at_utc, source_kind, source_ingestion_sequence)
       select $1, t.area, t.addr, t.bit, t.prev, t.next, t.at, t.id, t.raw_at, t.kind, t.seq
         from unnest($2::text[], $3::text[], $4::int[], $5::boolean[], $6::boolean[], $7::timestamptz[], $8::bigint[],
                     $9::timestamptz[], $10::text[], $11::bigint[])
           as t(area, addr, bit, prev, next, at, id, raw_at, kind, seq)`,
      [
        TD_S_STATE_PROJECTION_VERSION,
        part.map((x) => x.b.tdArea),
        part.map((x) => x.b.address),
        part.map((x) => x.t.bitIndex),
        part.map((x) => x.t.previousValue),
        part.map((x) => x.t.newValue),
        part.map((x) => x.t.event.eventAt),
        part.map((x) => id(x.t.event.rawEventId)),
        part.map((x) => x.t.event.rawEventNormalizedAt),
        part.map((x) => x.t.event.sourceKind),
        part.map((x) => seq(x.t.event.ingestionSequence)),
      ],
    );
  }
  for (const b of plan.bytes) {
    if (!b.currentState) continue;
    const v = b.currentState.value;
    const src = b.currentState.source;
    await db.query(
      `update td_s_current_state set raw_value = $4, byte_value = $5, decoded_bitset = $6::jsonb, event_at = $7,
              source_event_id = $8, source_event_normalized_at_utc = $9, source_ingestion_sequence = $10,
              source_kind = $11, updated_at = now()
        where projection_version = $1 and td_area = $2 and address = $3 and source_ingestion_sequence <= $12`,
      [
        TD_S_STATE_PROJECTION_VERSION,
        b.tdArea,
        b.address,
        v.toString(16).toUpperCase().padStart(2, "0"),
        v,
        JSON.stringify(sBits(v)),
        src.eventAt,
        id(src.rawEventId),
        src.rawEventNormalizedAt,
        seq(src.ingestionSequence),
        src.sourceKind,
        plan.maxWindowSeq,
      ],
    );
  }

  // Last, so today's activity rows are held only for the end of the transaction.
  await addCounts();

  if (args.outage) {
    await db.query(
      `insert into feed_gap (feed_name, td_area, detected_start, detected_end, detection_reason, recoverability,
                             affected_time_start, affected_time_end, operator_note)
       values ('TD', null, $1, $2, $3, 'recoverable', $1, $2, $4)`,
      [
        args.outage.from,
        args.outage.to,
        TD_INGEST_LAG_LOSS_REASON,
        `ingest-td fell up to 301 s behind the broker, which dropped ~40% of TD frames 06:43-06:54; ` +
          `${plan.messages.length} TD messages for ${iso(args.from)}..${iso(args.to)} recovered from openrail-eps ` +
          `(sha256 ${fileSha.slice(0, 12)}…, archive ${archiveKey}, merge mode).`,
      ],
    );
  }
  console.log(
    `applied: ${plan.messages.length} messages; ${updates.length} rows re-closed, ${inserts.length} inserted; ` +
      `${anIns.length} anomalies; ${trIns.length} transitions`,
  );
}
