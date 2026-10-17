/**
 * ADR 0020 (option B): imports TD recovered from an openrail-eps `tddb-detail.log` excerpt for a
 * window RLM missed, with explicit lineage, and repairs the derived history of that window.
 *
 *   recover-td-from-openrail-log --file <excerpt> --from <ISO> --to <ISO> [--post-window-hours 3]
 *                                [--execute]
 *
 * Two phases, after the 2026-10-16 incident where a long-running dry-run transaction held row locks
 * the live projectors needed and froze the live maps for ~3 hours:
 *
 *  1. PLAN: read-only. Runs in a `read only` transaction with a statement timeout, so it can never
 *     hold a row lock or run away. All reading (dedup, gap bounds, pre-gap state, post-gap events)
 *     and all planning happen here, with placeholder ids (`rec:<n>`) for the not-yet-inserted
 *     recovered rows. Without `--execute` the tool prints the plan and stops: it writes nothing.
 *  2. APPLY (`--execute` only): archive upload, then ONE short write transaction
 *     (`lock_timeout` 3 s, `statement_timeout` 30 s) that inserts the lineage rows, maps the
 *     placeholders to the real ids, and applies the plan. If anything waits on a lock it fails
 *     fast and rolls back rather than queue behind (or in front of) live writers.
 *
 * What is written: the archived excerpt (`source_kind='recovered-log'`), one `feed_frame`, one
 * `raw_feed_event` per message with `recovery_source` set (the projectors skip these), their derived
 * rows (td_berth_event `recovered=true`, td_heartbeat, td_s_event, daily activity, area summary),
 * the per-berth / per-byte repairs from td/recovery/repairPlan.ts, guarded current-state fixes for
 * berths and bytes idle since the gap, and an annotation on the TD `feed_gap` row.
 *
 * Every bounded read of td_berth_event / td_s_event filters by area and time inside a
 * `materialized` CTE before any ordering: ordering those tables by ingestion_sequence lets the
 * planner pick the global sequence index and scan nationwide history (the 2026-10-16 stall).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { PoolClient } from "pg";
import { createPool } from "@railway/database";
import { createArchiveClient, computeArchiveObjectKey, putImmutableObject } from "@railway/archive";
import { TD_PARSER_VERSION } from "@railway/feed-parsers";
import {
  decodeSClassPayload,
  sBits,
  TD_NORMALIZATION_VERSION,
  TD_PROJECTION_VERSION,
  TD_S_DECODE_VERSION,
  TD_S_STATE_PROJECTION_VERSION,
} from "@railway/domain";
import type { Config } from "../config.js";
import {
  isRecoveredMessage,
  nrIdentity,
  parseOpenrailTddbLine,
  type RecoveredTdMessage,
} from "../td/recovery/openrailTddbLog.js";
import {
  planBerthRepair,
  planSByteRepair,
  type BerthEventRef,
  type BerthRepairPlan,
  type SByteEventRef,
  type SByteRepairPlan,
} from "../td/recovery/repairPlan.js";

const TOPIC = "recovery:openrail-eps:tddb-detail.log";
const ADR = "0020";
/** Placeholder prefix for recovered rows' ids and sequences until they are inserted. */
const REC = "rec:";
/** How far before the gap to look for each S-Class byte's last known value. */
const S_PRE_LOOKBACK_HOURS = 6;

interface Args {
  file: string;
  from: Date;
  to: Date;
  postWindowHours: number;
  /** S-Class bytes are re-stated by periodic refreshes, so their first post-gap statement is near. */
  sPostWindowHours: number;
  execute: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = get("file");
  const from = get("from");
  const to = get("to");
  if (!file || !from || !to) {
    throw new Error(
      "usage: recover-td-from-openrail-log --file <path> --from <ISO> --to <ISO> [--post-window-hours N] [--s-post-window-hours N] [--execute]",
    );
  }
  return {
    file,
    from: new Date(from),
    to: new Date(to),
    postWindowHours: Number(get("post-window-hours") ?? "3"),
    sPostWindowHours: Number(get("s-post-window-hours") ?? "3"),
    execute: argv.includes("--execute"),
  };
}

type Payload = Record<string, string>;
const payloadOf = (m: RecoveredTdMessage): Payload => Object.values(m.rawEventJson)[0]!;

interface Plan {
  messages: RecoveredTdMessage[];
  gapEnd: Date;
  lastPreSeq: string;
  berthPlans: BerthRepairPlan[];
  bytePlans: SByteRepairPlan[];
  anomaliesToRemove: number;
  transitionsToRemove: number;
  bytesWithUnknownPreValue: number;
}

export async function runRecoverTdFromOpenrailLog(config: Config, argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const fileBytes = await readFile(args.file);
  const fileSha = createHash("sha256").update(fileBytes).digest("hex");
  const inWindow = parseWindow(fileBytes.toString("utf8"), args);

  const pool = createPool({ connectionString: config.DATABASE_URL });
  try {
    // ---------- Phase 1: read-only planning ----------
    const reader = await pool.connect();
    let plan: Plan;
    try {
      await reader.query("begin transaction read only");
      await reader.query("set local statement_timeout = '120s'");
      // Every planning statement is timed on stderr, so a slow plan is visible, not silent.
      const timed = new Proxy(reader, {
        get(target, prop, receiver) {
          if (prop !== "query") return Reflect.get(target, prop, receiver);
          return async (...queryArgs: unknown[]) => {
            const t = Date.now();
            try {
              return await (target.query as (...a: unknown[]) => Promise<unknown>)(...queryArgs);
            } finally {
              const sql = String(queryArgs[0]).replace(/\s+/g, " ").trim().slice(0, 80);
              console.error(`[plan] ${Date.now() - t} ms  ${sql}`);
            }
          };
        },
      });
      plan = await buildPlan(timed, args, fileSha, inWindow);
      await reader.query("commit");
    } catch (error) {
      await reader.query("rollback").catch(() => {});
      throw error;
    } finally {
      reader.release();
    }
    printPlan(args, fileSha, inWindow.length, plan);

    if (!args.execute) {
      console.log("DRY RUN: read-only, nothing was written. Re-run with --execute to apply.");
      return;
    }

    // ---------- Phase 2: archive, then one short write transaction ----------
    const archiveKey = computeArchiveObjectKey({
      namespace: "td-recovered",
      contentSha256: fileSha,
      date: args.from,
    });
    const archiveClient = createArchiveClient({
      endpoint: config.RAW_ARCHIVE_ENDPOINT,
      region: config.RAW_ARCHIVE_REGION,
      accessKeyId: config.RAW_ARCHIVE_ACCESS_KEY,
      secretAccessKey: config.RAW_ARCHIVE_SECRET_KEY,
    });
    await putImmutableObject({
      client: archiveClient,
      bucket: config.RAW_ARCHIVE_BUCKET,
      key: archiveKey,
      body: fileBytes,
      contentType: "text/plain",
    });

    const writer = await pool.connect();
    try {
      await writer.query("begin");
      await writer.query("set local lock_timeout = '3s'");
      await writer.query("set local statement_timeout = '30s'");
      const started = Date.now();
      await applyPlan(writer, config, args, fileSha, fileBytes.length, archiveKey, plan);
      await writer.query("commit");
      console.log(`COMMITTED in ${Date.now() - started} ms.`);
    } catch (error) {
      await writer.query("rollback").catch(() => {});
      throw error;
    } finally {
      writer.release();
    }
  } finally {
    await pool.end();
  }
}

function parseWindow(text: string, args: Args): RecoveredTdMessage[] {
  const inWindow: RecoveredTdMessage[] = [];
  const rejects: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    const parsed = parseOpenrailTddbLine(line, i + 1);
    if (isRecoveredMessage(parsed)) {
      if (parsed.eventAt >= args.from && parsed.eventAt <= args.to) inWindow.push(parsed);
    } else if (!/Timestamp/.test(line) || windowMentioned(line, args)) {
      rejects.push(`${parsed.lineNumber}: ${parsed.reason}`);
    }
  });
  if (rejects.length > 0) {
    throw new Error(
      `Refusing: ${rejects.length} unparseable line(s) in the window:\n${rejects.slice(0, 10).join("\n")}`,
    );
  }
  return inWindow;
}

function windowMentioned(line: string, args: Args): boolean {
  const m = /Timestamp (\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})Z/.exec(line);
  if (!m) return false;
  const at = new Date(
    Date.UTC(
      2000 + Number(m[3]),
      Number(m[2]) - 1,
      Number(m[1]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
    ),
  );
  return at >= args.from && at <= args.to;
}

// ===================== Phase 1 =====================

async function buildPlan(
  db: PoolClient,
  args: Args,
  fileSha: string,
  inWindow: RecoveredTdMessage[],
): Promise<Plan> {
  const already = await db.query(
    "select 1 from feed_frame where feed_name = 'TD' and body_hash = $1",
    [fileSha],
  );
  if (already.rowCount)
    throw new Error(
      "Refusing: this excerpt has already been imported (feed_frame body_hash exists).",
    );

  const { rows: originals } = await db.query<{ raw_event_json: Record<string, Payload> }>(
    `select raw_event_json from raw_feed_event
     where feed_name = 'TD' and recovery_source is null
       and normalized_event_at_utc >= $1 and normalized_event_at_utc <= $2`,
    [args.from, args.to],
  );
  const held = new Set(originals.map((r) => nrIdentity(r.raw_event_json)));
  const messages = inWindow.filter((m) => !held.has(nrIdentity(m.rawEventJson)));
  if (messages.length === 0) throw new Error("Nothing to recover.");

  const { rows: bounds } = await db.query<{ gap_end: Date | null; last_pre_seq: string | null }>(
    `select
       (select min(normalized_event_at_utc) from raw_feed_event
         where feed_name = 'TD' and recovery_source is null
           and normalized_event_at_utc > $1 and normalized_event_at_utc < $1::timestamptz + interval '1 hour') as gap_end,
       (select max(ingestion_sequence)::text from raw_feed_event
         where feed_name = 'TD' and recovery_source is null
           and normalized_event_at_utc >= $2::timestamptz - interval '10 minutes' and normalized_event_at_utc <= $1) as last_pre_seq`,
    [args.to, args.from],
  );
  const gapEnd = bounds[0]?.gap_end;
  const lastPreSeq = bounds[0]?.last_pre_seq;
  if (!gapEnd || !lastPreSeq) throw new Error("Could not determine the gap boundaries.");

  const berthPlans = await planBerths(db, messages, gapEnd, args.postWindowHours, lastPreSeq);
  const { plans: bytePlans, unknownPre } = await planBytes(
    db,
    messages,
    gapEnd,
    args.sPostWindowHours,
    lastPreSeq,
  );

  const anomalyTargets = berthPlans.filter((p) => p.replaceAnomaliesOfEventId);
  const { rows: an } = await db.query<{ n: string }>(
    `select count(*)::text as n from td_projection_anomaly a
     join unnest($2::bigint[], $3::text[], $4::text[], $5::timestamptz[]) w(id, area, berth, at)
       on a.raw_event_id = w.id and a.td_area = w.area and a.berth_code = w.berth and a.event_at = w.at
     where a.projection_version = $1 and a.event_at >= $6 and a.event_at <= $7`,
    [
      TD_PROJECTION_VERSION,
      anomalyTargets.map((p) => p.replaceAnomaliesOfEventId),
      anomalyTargets.map((p) => p.tdArea),
      anomalyTargets.map((p) => p.berth),
      anomalyTargets.map((p) => p.replaceAnomaliesEventAt),
      gapEnd,
      new Date(gapEnd.getTime() + args.postWindowHours * 3_600_000),
    ],
  );
  const transitionTargets = bytePlans.filter((p) => p.replaceTransitionsOfEventId);
  const { rows: tr } = await db.query<{ n: string }>(
    `select count(*)::text as n from unnest($2::bigint[], $3::text[], $4::text[], $5::timestamptz[]) w(id, area, addr, at)
     cross join lateral (
       select 1 from td_s_bit_transition t
       where t.projection_version = $1 and t.td_area = w.area and t.address = w.addr and t.event_at = w.at
         and t.source_event_id = w.id
     ) x`,
    [
      TD_S_STATE_PROJECTION_VERSION,
      transitionTargets.map((p) => p.replaceTransitionsOfEventId),
      transitionTargets.map((p) => p.tdArea),
      transitionTargets.map((p) => p.address),
      transitionTargets.map((p) => p.replaceTransitionsEventAt),
    ],
  );

  return {
    messages,
    gapEnd,
    lastPreSeq,
    berthPlans,
    bytePlans,
    anomaliesToRemove: Number(an[0]?.n ?? 0),
    transitionsToRemove: Number(tr[0]?.n ?? 0),
    bytesWithUnknownPreValue: unknownPre,
  };
}

function refFor(
  m: RecoveredTdMessage,
  index: number,
): { rawEventId: string; rawEventNormalizedAt: Date; eventAt: Date; ingestionSequence: string } {
  return {
    rawEventId: `${REC}${index}`,
    rawEventNormalizedAt: m.eventAt,
    eventAt: m.eventAt,
    ingestionSequence: `${REC}${index}`,
  };
}

/** Recovered messages in event order (same second: openrail's line order = its arrival order). */
function inEventOrder(messages: RecoveredTdMessage[]): { m: RecoveredTdMessage; index: number }[] {
  return messages
    .map((m, index) => ({ m, index }))
    .sort(
      (a, b) => a.m.eventAt.getTime() - b.m.eventAt.getTime() || a.m.lineNumber - b.m.lineNumber,
    );
}

async function planBerths(
  db: PoolClient,
  messages: RecoveredTdMessage[],
  gapEnd: Date,
  postHours: number,
  lastPreSeq: string,
): Promise<BerthRepairPlan[]> {
  const recoveredByBerth = new Map<string, BerthEventRef[]>();
  for (const { m, index } of inEventOrder(messages)) {
    if (m.type !== "CA" && m.type !== "CB" && m.type !== "CC") continue;
    const p = payloadOf(m);
    const base = { ...refFor(m, index), type: m.type, description: p.descr! };
    for (const [berth, role] of [
      [p.from, "from"],
      [p.to, "to"],
    ] as const) {
      if (!berth) continue;
      const k = `${m.tdArea}|${berth}`;
      recoveredByBerth.set(k, [...(recoveredByBerth.get(k) ?? []), { ...base, role }]);
    }
  }
  const keys = [...recoveredByBerth.keys()];
  if (keys.length === 0) return [];
  const areas = keys.map((k) => k.split("|")[0]!);
  const berths = keys.map((k) => k.split("|")[1]!);

  // Pre-gap open row: each berth's LATEST occupancy entered before the gap end (one descending index
  // probe per berth via (td_area, berth_code, entered_at desc)), kept only if it was still open at
  // the gap. Exact because the projector closes a berth's previous occupancy before opening the
  // next, so at most one is ever open. (A filtered distinct-on over all history timed out at 120 s
  // on production, 2026-10-17.)
  const { rows: preRows } = await db.query<{
    td_area: string;
    berth_code: string;
    id: string;
    description: string;
    entered_at: Date;
  }>(
    `select w.a as td_area, w.b as berth_code, bo.id::text, bo.description, bo.entered_at
     from unnest($2::text[], $3::text[]) w(a, b)
     cross join lateral (
       select id, description, entered_at, left_at from berth_occupancy
       where projection_version = $1 and td_area = w.a and berth_code = w.b and entered_at < $4
       order by entered_at desc limit 1
     ) bo
     where bo.left_at is null or bo.left_at >= $4`,
    [TD_PROJECTION_VERSION, areas, berths, gapEnd],
  );
  const pre = new Map(
    preRows.map((r) => [
      `${r.td_area}|${r.berth_code}`,
      { occupancyId: r.id, description: r.description, enteredAt: r.entered_at },
    ]),
  );

  // First original event per berth after the gap. Area + time filter first (materialized), then
  // order by sequence — never let the planner drive this from the global sequence index.
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
    `with w as materialized (
       select raw_event_id, raw_event_normalized_at_utc, td_area, message_type, from_berth, to_berth, description,
              event_at, ingestion_sequence
       from td_berth_event
       where td_area = any($1::text[]) and event_at >= $2 and event_at < $2::timestamptz + make_interval(hours => $3)
         and message_type in ('CA', 'CB', 'CC') and not recovered
     )
     select raw_event_id::text, raw_event_normalized_at_utc, td_area, message_type, from_berth, to_berth, description,
            event_at, ingestion_sequence::text
     from w order by ingestion_sequence`,
    [[...new Set(areas)], gapEnd, postHours],
  );
  const firstPost = new Map<string, BerthEventRef>();
  for (const e of post) {
    for (const [berth, role] of [
      [e.from_berth, "from"],
      [e.to_berth, "to"],
    ] as const) {
      if (!berth) continue;
      const k = `${e.td_area}|${berth}`;
      if (!recoveredByBerth.has(k) || firstPost.has(k)) continue;
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

  // A berth with no event in the post window must be truly idle since the gap.
  const idle = keys.filter((k) => !firstPost.has(k));
  if (idle.length > 0) {
    const { rows } = await db.query<{ seq: string }>(
      `select source_ingestion_sequence::text as seq from berth_current_state
       join unnest($2::text[], $3::text[]) w(a, b) on td_area = w.a and berth_code = w.b
       where projection_version = $1`,
      [TD_PROJECTION_VERSION, idle.map((k) => k.split("|")[0]), idle.map((k) => k.split("|")[1])],
    );
    if (rows.some((r) => BigInt(r.seq) > BigInt(lastPreSeq))) {
      throw new Error(
        `Refusing: some berths have events after the ${postHours} h post window; raise the post window (--post-window-hours / --s-post-window-hours).`,
      );
    }
  }

  return keys.map((k) => {
    const [tdArea, berth] = k.split("|") as [string, string];
    return planBerthRepair({
      tdArea,
      berth,
      pre: pre.get(k) ?? null,
      recovered: recoveredByBerth.get(k)!,
      firstPost: firstPost.get(k) ?? null,
    });
  });
}

async function planBytes(
  db: PoolClient,
  messages: RecoveredTdMessage[],
  gapEnd: Date,
  postHours: number,
  lastPreSeq: string,
): Promise<{ plans: SByteRepairPlan[]; unknownPre: number }> {
  const byByte = new Map<string, SByteEventRef[]>();
  for (const { m, index } of inEventOrder(messages)) {
    if (m.type !== "SF") continue;
    const p = payloadOf(m);
    const k = `${m.tdArea}|${p.address}`;
    byByte.set(k, [
      ...(byByte.get(k) ?? []),
      { ...refFor(m, index), value: Number.parseInt(p.data!, 16), sourceKind: "update" },
    ]);
  }
  const keys = [...byByte.keys()];
  if (keys.length === 0) return { plans: [], unknownPre: 0 };
  const areas = [...new Set(keys.map((k) => k.split("|")[0]!))];

  // Each byte's last stated value before the gap, and its first statement after it — one bounded
  // read of td_s_event around the gap, restricted to the start addresses that can state these
  // bytes: the byte itself (SF) and the three before it (SG/SH refreshes state 4 bytes from their
  // start). Measured on production 2026-10-17: 2.7 s / 361k rows, versus 35 s / 1.49M rows for
  // the whole areas.
  const pairs = new Set<string>();
  for (const k of keys) {
    const [area, address] = k.split("|") as [string, string];
    const start = Number.parseInt(address, 16);
    for (let d = 0; d < 4 && start - d >= 0; d += 1) {
      pairs.add(`${area}|${(start - d).toString(16).toUpperCase().padStart(2, "0")}`);
    }
  }
  const pairList = [...pairs].map((p) => p.split("|") as [string, string]);
  const { rows } = await db.query<{
    raw_event_id: string;
    raw_event_normalized_at_utc: Date;
    td_area: string;
    message_type: string;
    decoded_bitset: { bytes: Record<string, number> } | null;
    event_at: Date;
    ingestion_sequence: string;
  }>(
    `with p as (select distinct * from unnest($5::text[], $6::text[]) as p(area, addr)),
     w as materialized (
       select e.raw_event_id, e.raw_event_normalized_at_utc, e.td_area, e.message_type, e.decoded_bitset, e.event_at,
              e.ingestion_sequence
       from td_s_event e join p on e.td_area = p.area and e.address = p.addr
       where e.td_area = any($1::text[]) and e.decode_status = 'decoded'
         and e.event_at >= $2::timestamptz - make_interval(hours => $4)
         and e.event_at < $2::timestamptz + make_interval(hours => $3)
     )
     select raw_event_id::text, raw_event_normalized_at_utc, td_area, message_type, decoded_bitset, event_at,
            ingestion_sequence::text
     from w order by ingestion_sequence`,
    [
      areas,
      gapEnd,
      postHours,
      S_PRE_LOOKBACK_HOURS,
      pairList.map((p) => p[0]),
      pairList.map((p) => p[1]),
    ],
  );
  const preValue = new Map<string, number>();
  const firstPost = new Map<string, SByteEventRef>();
  for (const e of rows) {
    const before = e.event_at < gapEnd && BigInt(e.ingestion_sequence) <= BigInt(lastPreSeq);
    for (const [address, value] of Object.entries(e.decoded_bitset?.bytes ?? {})) {
      const k = `${e.td_area}|${address}`;
      if (!byByte.has(k)) continue;
      if (before) {
        preValue.set(k, value); // rows are in sequence order, so the last one wins
      } else if (e.event_at >= gapEnd && !firstPost.has(k)) {
        firstPost.set(k, {
          rawEventId: e.raw_event_id,
          rawEventNormalizedAt: e.raw_event_normalized_at_utc,
          eventAt: e.event_at,
          ingestionSequence: e.ingestion_sequence,
          value,
          sourceKind: e.message_type === "SF_MSG" ? "update" : "refresh",
        });
      }
    }
  }

  const idle = keys.filter((k) => !firstPost.has(k));
  if (idle.length > 0) {
    const { rows: cur } = await db.query<{ seq: string }>(
      `select source_ingestion_sequence::text as seq from td_s_current_state
       join unnest($2::text[], $3::text[]) w(a, ad) on td_area = w.a and address = w.ad
       where projection_version = $1`,
      [
        TD_S_STATE_PROJECTION_VERSION,
        idle.map((k) => k.split("|")[0]),
        idle.map((k) => k.split("|")[1]),
      ],
    );
    if (cur.some((r) => BigInt(r.seq) > BigInt(lastPreSeq))) {
      throw new Error(
        `Refusing: some S-Class bytes have events after the ${postHours} h post window; raise the post window (--post-window-hours / --s-post-window-hours).`,
      );
    }
  }

  let unknownPre = 0;
  const plans = keys.map((k) => {
    const [tdArea, address] = k.split("|") as [string, string];
    const v = preValue.get(k);
    if (v === undefined) unknownPre += 1;
    const preBits = v === undefined ? Array<boolean | null>(8).fill(null) : sBits(v);
    return planSByteRepair({
      tdArea,
      address,
      preBits,
      recovered: byByte.get(k)!,
      firstPost: firstPost.get(k) ?? null,
    });
  });
  return { plans, unknownPre };
}

function printPlan(args: Args, fileSha: string, linesInWindow: number, plan: Plan): void {
  const count = (pred: (t: RecoveredTdMessage) => boolean): number =>
    plan.messages.filter(pred).length;
  const bp = plan.berthPlans;
  const sp = plan.bytePlans;
  console.log(`excerpt ${basename(args.file)} sha256=${fileSha}`);
  console.log(
    `window ${args.from.toISOString()} .. ${args.to.toISOString()}: ${linesInWindow} lines, ${linesInWindow - plan.messages.length} already held by RLM, ${plan.messages.length} to recover`,
  );
  console.log(
    `  CA ${count((m) => m.type === "CA")}, CB ${count((m) => m.type === "CB")}, CC ${count((m) => m.type === "CC")}, CT ${count((m) => m.type === "CT")}, SF ${count((m) => m.type === "SF")}`,
  );
  console.log(
    `gap ends at first original event ${plan.gapEnd.toISOString()}; last pre-gap sequence ${plan.lastPreSeq}`,
  );
  console.log(
    `berths: ${bp.length}; pre-gap rows re-closed ${bp.filter((p) => p.preClose).length}; occupancies inserted ${bp.reduce((n, p) => n + p.inserts.length, 0)}; ` +
      `anomalies removed ${plan.anomaliesToRemove} / added ${bp.reduce((n, p) => n + p.anomalies.length, 0)}; idle berths' current state fixed ${bp.filter((p) => p.currentState).length}`,
  );
  console.log(
    `S-Class bytes: ${sp.length} (${plan.bytesWithUnknownPreValue} with no value in the ${S_PRE_LOOKBACK_HOURS} h before the gap); ` +
      `transitions removed ${plan.transitionsToRemove} / added ${sp.reduce((n, p) => n + p.transitions.length, 0)}; idle bytes' current state fixed ${sp.filter((p) => p.currentState).length}`,
  );
}

// ===================== Phase 2 =====================

async function applyPlan(
  db: PoolClient,
  config: Config,
  args: Args,
  fileSha: string,
  fileSize: number,
  archiveKey: string,
  plan: Plan,
): Promise<void> {
  const { messages } = plan;
  const again = await db.query(
    "select 1 from feed_frame where feed_name = 'TD' and body_hash = $1",
    [fileSha],
  );
  if (again.rowCount) throw new Error("Refusing: this excerpt has already been imported.");

  const { rows: archiveRows } = await db.query<{ id: string }>(
    `insert into raw_archive_object (object_key, bucket, content_sha256, compressed_size_bytes, source_kind)
     values ($1, $2, $3, $4, 'recovered-log')
     on conflict (object_key) do update set object_key = excluded.object_key
     returning id`,
    [archiveKey, config.RAW_ARCHIVE_BUCKET, fileSha, fileSize],
  );
  const headers = {
    source: "openrail-eps",
    file: basename(args.file),
    sha256: fileSha,
    adr: ADR,
    window: { from: args.from.toISOString(), to: args.to.toISOString() },
    note: "Rebuilt from openrail-eps tddb-detail.log after RLM's 2026-10-16 cutover gap; not an NR broker frame.",
  };
  const { rows: frameRows } = await db.query<{ id: string }>(
    `insert into feed_frame (feed_name, topic, headers_json, received_at, body_hash, archive_object_id,
                             child_count, parsed_child_count, parse_status, acked_at)
     values ('TD', $1, $2, now(), $3, $4, $5, $5, 'ok', now()) returning id`,
    [TOPIC, JSON.stringify(headers), fileSha, archiveRows[0]!.id, messages.length],
  );

  const { rows: rawRows } = await db.query<{
    id: string;
    ingestion_sequence: string;
    child_index: number;
  }>(
    `insert into raw_feed_event (
       frame_id, child_index, feed_name, event_type, message_class, td_area, raw_event_json,
       raw_source_timestamp_ms, raw_source_timestamp_text, normalized_event_at_utc, received_at_utc,
       semantic_hash, parse_status, parse_version, recovery_source
     )
     select $1, t.child_index, 'TD', t.event_type, t.message_class, t.td_area, t.raw_event_json::jsonb,
            t.ts_ms, t.ts_text, t.event_at, t.received_at, t.semantic_hash, 'parsed', $2, t.recovery_source::jsonb
     from unnest($3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::bigint[], $9::text[],
                 $10::timestamptz[], $11::timestamptz[], $12::text[], $13::text[])
       as t(child_index, event_type, message_class, td_area, raw_event_json, ts_ms, ts_text, event_at,
            received_at, semantic_hash, recovery_source)
     returning id::text, ingestion_sequence::text, child_index`,
    [
      frameRows[0]!.id,
      TD_PARSER_VERSION,
      messages.map((_, i) => i),
      messages.map((m) => (m.type === "SF" ? "SF_MSG" : m.type)),
      messages.map((m) => (m.type === "SF" ? "S" : "C")),
      messages.map((m) => m.tdArea),
      messages.map((m) => JSON.stringify(m.rawEventJson)),
      messages.map((m) => m.eventAt.getTime()),
      messages.map((m) => String(m.eventAt.getTime())),
      messages.map((m) => m.eventAt),
      messages.map((m) => m.loggedAt),
      messages.map((m) =>
        createHash("sha256").update(JSON.stringify(m.rawEventJson)).digest("hex"),
      ),
      messages.map((m) =>
        JSON.stringify({
          source: "openrail-eps tddb-detail.log",
          file: basename(args.file),
          line_number: m.lineNumber,
          line: m.line,
          adr: ADR,
        }),
      ),
    ],
  );
  const byIndex = new Map(rawRows.map((r) => [r.child_index, r]));
  const id = (ref: string): string =>
    ref.startsWith(REC) ? byIndex.get(Number(ref.slice(REC.length)))!.id : ref;
  const seq = (ref: string): string =>
    ref.startsWith(REC) ? byIndex.get(Number(ref.slice(REC.length)))!.ingestion_sequence : ref;

  // Derived per-event rows.
  const idx = messages.map((m, i) => ({
    m,
    i,
    p: payloadOf(m),
    id: byIndex.get(i)!.id,
    seq: byIndex.get(i)!.ingestion_sequence,
  }));
  const c = idx.filter((x) => x.m.type === "CA" || x.m.type === "CB" || x.m.type === "CC");
  const ct = idx.filter((x) => x.m.type === "CT");
  const s = idx.filter((x) => x.m.type === "SF");
  await db.query(
    `insert into td_berth_event (raw_event_id, raw_event_normalized_at_utc, td_area, message_type, from_berth,
                                 to_berth, description, event_at, ingestion_sequence, normalization_version, recovered)
     select t.id, t.at, t.area, t.type, t.f, t.t, t.d, t.at, t.seq, $8, true
     from unnest($1::bigint[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $9::bigint[])
       as t(id, at, area, type, f, t, d, seq)`,
    [
      c.map((x) => x.id),
      c.map((x) => x.m.eventAt),
      c.map((x) => x.m.tdArea),
      c.map((x) => x.m.type),
      c.map((x) => x.p.from ?? null),
      c.map((x) => x.p.to ?? null),
      c.map((x) => x.p.descr ?? null),
      TD_NORMALIZATION_VERSION,
      c.map((x) => x.seq),
    ],
  );
  await db.query(
    `insert into td_heartbeat (raw_event_id, raw_event_normalized_at_utc, td_area, report_time, event_at, received_at)
     select t.id, t.at, t.area, t.at, t.at, now()
     from unnest($1::bigint[], $2::timestamptz[], $3::text[]) as t(id, at, area)`,
    [ct.map((x) => x.id), ct.map((x) => x.m.eventAt), ct.map((x) => x.m.tdArea)],
  );
  const decoded = s.map((x) => decodeSClassPayload("SF_MSG", x.p.address, x.p.data));
  if (decoded.some((d) => !d.ok))
    throw new Error("Refusing: a recovered S-Class row failed to decode.");
  await db.query(
    `insert into td_s_event (raw_event_id, raw_event_normalized_at_utc, td_area, message_type, address, raw_value,
                             decoded_bitset, event_at, ingestion_sequence, normalization_version, decode_status,
                             decode_version, decode_error_code)
     select t.id, t.at, t.area, 'SF_MSG', t.addr, t.val, t.bits::jsonb, t.at, t.seq, $7, 'decoded', $8, null
     from unnest($1::bigint[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $9::bigint[])
       as t(id, at, area, addr, val, bits, seq)`,
    [
      s.map((x) => x.id),
      s.map((x) => x.m.eventAt),
      s.map((x) => x.m.tdArea),
      s.map((x) => x.p.address),
      s.map((x) => x.p.data),
      decoded.map((d) =>
        d.ok
          ? JSON.stringify({ bytes: Object.fromEntries(d.bytes.map((b) => [b.address, b.value])) })
          : null,
      ),
      TD_NORMALIZATION_VERSION,
      TD_S_DECODE_VERSION,
      s.map((x) => x.seq),
    ],
  );
  await addActivityCounts(
    db,
    c.map((x) => ({ area: x.m.tdArea, at: x.m.eventAt, from: x.p.from, to: x.p.to })),
  );
  await addAreaSummary(db, messages);

  // Berth repairs.
  for (const plan_ of plan.berthPlans) {
    if (plan_.preClose && plan_.preOccupancyId) {
      const r = await db.query(
        `update berth_occupancy set left_at = $2, exit_event_id = $3, exit_event_normalized_at_utc = $4, exit_reason = $5
         where id = $1 and projection_version = $6`,
        [
          plan_.preOccupancyId,
          plan_.preClose.leftAt,
          id(plan_.preClose.exitEventId),
          plan_.preClose.exitEventNormalizedAt,
          plan_.preClose.exitReason,
          TD_PROJECTION_VERSION,
        ],
      );
      if (r.rowCount !== 1)
        throw new Error(
          `pre-gap occupancy ${plan_.preOccupancyId} not found (${plan_.tdArea}/${plan_.berth})`,
        );
    }
    for (const ins of plan_.inserts) {
      await db.query(
        `insert into berth_occupancy (projection_version, td_area, berth_code, description, entered_at, entry_event_id,
                                      entry_event_normalized_at_utc, entry_reason, left_at, exit_event_id,
                                      exit_event_normalized_at_utc, exit_reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          TD_PROJECTION_VERSION,
          plan_.tdArea,
          plan_.berth,
          ins.description,
          ins.enteredAt,
          id(ins.entryEventId),
          ins.entryEventNormalizedAt,
          ins.entryReason,
          ins.close?.leftAt ?? null,
          ins.close ? id(ins.close.exitEventId) : null,
          ins.close?.exitEventNormalizedAt ?? null,
          ins.close?.exitReason ?? null,
        ],
      );
    }
    if (plan_.replaceAnomaliesOfEventId) {
      await db.query(
        `delete from td_projection_anomaly where projection_version = $1 and raw_event_id = $2 and td_area = $3 and berth_code = $4 and event_at = $5`,
        [
          TD_PROJECTION_VERSION,
          plan_.replaceAnomaliesOfEventId,
          plan_.tdArea,
          plan_.berth,
          plan_.replaceAnomaliesEventAt,
        ],
      );
    }
    for (const a of plan_.anomalies) {
      await db.query(
        `insert into td_projection_anomaly (projection_version, td_area, berth_code, raw_event_id, raw_event_normalized_at_utc,
                                            anomaly_code, details, event_at, ingestion_sequence)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
        [
          TD_PROJECTION_VERSION,
          plan_.tdArea,
          plan_.berth,
          id(a.rawEventId),
          a.rawEventNormalizedAt,
          a.anomalyCode,
          JSON.stringify(a.details),
          a.eventAt,
          seq(a.ingestionSequence),
        ],
      );
    }
    if (plan_.currentState) {
      const cs = plan_.currentState;
      await db.query(
        `update berth_current_state set description = $4, occupancy_id = null, occupancy_entered_at = $5, event_at = $6,
                source_event_id = $7, source_event_normalized_at_utc = $6, source_ingestion_sequence = $8, updated_at = now()
         where projection_version = $1 and td_area = $2 and berth_code = $3 and source_ingestion_sequence <= $9`,
        [
          TD_PROJECTION_VERSION,
          plan_.tdArea,
          plan_.berth,
          cs.description,
          cs.enteredAt,
          cs.source.eventAt,
          id(cs.source.rawEventId),
          seq(cs.source.ingestionSequence),
          plan.lastPreSeq,
        ],
      );
    }
  }

  // S-Class byte repairs.
  for (const bp of plan.bytePlans) {
    if (bp.replaceTransitionsOfEventId) {
      await db.query(
        `delete from td_s_bit_transition where projection_version = $1 and source_event_id = $2 and td_area = $3 and address = $4 and event_at = $5`,
        [
          TD_S_STATE_PROJECTION_VERSION,
          bp.replaceTransitionsOfEventId,
          bp.tdArea,
          bp.address,
          bp.replaceTransitionsEventAt,
        ],
      );
    }
    for (const t of bp.transitions) {
      await db.query(
        `insert into td_s_bit_transition (projection_version, td_area, address, bit_index, previous_value, new_value, event_at,
                                          source_event_id, source_event_normalized_at_utc, source_kind, source_ingestion_sequence)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          TD_S_STATE_PROJECTION_VERSION,
          bp.tdArea,
          bp.address,
          t.bitIndex,
          t.previousValue,
          t.newValue,
          t.event.eventAt,
          id(t.event.rawEventId),
          t.event.rawEventNormalizedAt,
          t.event.sourceKind,
          seq(t.event.ingestionSequence),
        ],
      );
    }
    if (bp.currentState) {
      const v = bp.currentState.value;
      const src = bp.currentState.source;
      await db.query(
        `update td_s_current_state set raw_value = $4, byte_value = $5, decoded_bitset = $6::jsonb, event_at = $7,
                source_event_id = $8, source_event_normalized_at_utc = $7, source_ingestion_sequence = $9,
                source_kind = 'update', updated_at = now()
         where projection_version = $1 and td_area = $2 and address = $3 and source_ingestion_sequence <= $10`,
        [
          TD_S_STATE_PROJECTION_VERSION,
          bp.tdArea,
          bp.address,
          v.toString(16).toUpperCase().padStart(2, "0"),
          v,
          JSON.stringify(sBits(v)),
          src.eventAt,
          id(src.rawEventId),
          seq(src.ingestionSequence),
          plan.lastPreSeq,
        ],
      );
    }
  }

  const note =
    `ADR ${ADR}: ${messages.length} TD messages for ${args.from.toISOString()}..${args.to.toISOString()} ` +
    `recovered from openrail-eps tddb-detail.log (sha256 ${fileSha.slice(0, 12)}…, archive ${archiveKey}); ` +
    `TD ${args.to.toISOString()}..${plan.gapEnd.toISOString()} is unrecoverable (captured by neither system).`;
  const gap = await db.query(
    `update feed_gap set operator_note = coalesce(operator_note || ' | ', '') || $3
     where feed_name = 'TD' and detected_start <= $2 and coalesce(detected_end, now()) >= $1`,
    [args.from, args.to, note],
  );
  console.log(`feed_gap rows annotated: ${gap.rowCount}`);
}

async function addActivityCounts(
  db: PoolClient,
  rows: { area: string; at: Date; from: string | undefined; to: string | undefined }[],
): Promise<void> {
  const counts = new Map<
    string,
    { area: string; date: string; berth: string; in: number; out: number; first: Date; last: Date }
  >();
  const add = (area: string, berth: string, at: Date, dir: "in" | "out"): void => {
    const date = at.toISOString().slice(0, 10);
    const k = `${area}|${date}|${berth}`;
    const e = counts.get(k) ?? { area, date, berth, in: 0, out: 0, first: at, last: at };
    e[dir] += 1;
    if (at < e.first) e.first = at;
    if (at > e.last) e.last = at;
    counts.set(k, e);
  };
  for (const r of rows) {
    if (r.to) add(r.area, r.to, r.at, "in");
    if (r.from) add(r.area, r.from, r.at, "out");
  }
  const a = [...counts.values()];
  if (a.length === 0) return;
  await db.query(
    `insert into td_berth_daily_activity (td_area, activity_date, berth, source, events_in, events_out, first_event_at, last_event_at)
     select t.area, t.d, t.berth, 'live', t.i, t.o, t.f, t.l
     from unnest($1::text[], $2::date[], $3::text[], $4::int[], $5::int[], $6::timestamptz[], $7::timestamptz[])
       as t(area, d, berth, i, o, f, l)
     on conflict (td_area, activity_date, berth, source) do update set
       events_in = td_berth_daily_activity.events_in + excluded.events_in,
       events_out = td_berth_daily_activity.events_out + excluded.events_out,
       first_event_at = least(td_berth_daily_activity.first_event_at, excluded.first_event_at),
       last_event_at = greatest(td_berth_daily_activity.last_event_at, excluded.last_event_at),
       updated_at = now()`,
    [
      a.map((x) => x.area),
      a.map((x) => x.date),
      a.map((x) => x.berth),
      a.map((x) => x.in),
      a.map((x) => x.out),
      a.map((x) => x.first),
      a.map((x) => x.last),
    ],
  );
}

async function addAreaSummary(db: PoolClient, messages: RecoveredTdMessage[]): Promise<void> {
  const by = new Map<string, { c: number; s: number }>();
  for (const m of messages) {
    const e = by.get(m.tdArea) ?? { c: 0, s: 0 };
    if (m.type === "SF") e.s += 1;
    else e.c += 1;
    by.set(m.tdArea, e);
  }
  const areas = [...by.keys()];
  await db.query(
    `update td_area_summary s set c_class_count = s.c_class_count + t.c, s_class_count = s.s_class_count + t.s, updated_at = now()
     from unnest($1::text[], $2::bigint[], $3::bigint[]) as t(area, c, s) where s.td_area = t.area`,
    [areas, areas.map((a) => by.get(a)!.c), areas.map((a) => by.get(a)!.s)],
  );
}
