import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPool, ensureMonthlyPartitions } from "@railway/database";
import { recordFrame, markFrameAcked, type InboundFrame } from "./recorder.js";
import {
  runProjectTd,
  TD_PROJECTION_VERSION,
  TD_PROJECTION_NAME,
  advisoryLockKey,
} from "./projector.js";
import { BERTH_OCCUPANCY_WRITE_LOCK_KEY } from "../shared/advisoryLock.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for integration tests`);
  }
  return value;
}

/** Same fake used by recorder.integration.test.ts — MinIO isn't available in this sandbox, only
 * the Postgres side (what this suite actually exercises) needs to be real. */
class FakeS3Client {
  send = async (): Promise<Record<string, never>> => {
    return {};
  };
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });
const archiveClient = new FakeS3Client() as unknown as S3Client;
const bucket = "railway-raw-test";

function frameFor(children: unknown[], receivedAt: Date): InboundFrame {
  return {
    feedName: "TD",
    topic: "/topic/TD_ALL_SIG_AREA",
    brokerMessageId: randomUUID(),
    headers: {},
    body: Buffer.from(JSON.stringify(children), "utf8"),
    receivedAt,
    connectionSessionId: null,
  };
}

async function record(children: unknown[], receivedAt: Date): Promise<void> {
  const result = await recordFrame(frameFor(children, receivedAt), {
    pool,
    archiveClient,
    archiveBucket: bucket,
  });
  await markFrameAcked(pool, result.frameId);
}

const ca = (area: string, from: string, to: string, descr: string, t: number) => ({
  CA_MSG: { area_id: area, time: String(t), from, to, descr },
});
const cb = (area: string, from: string, descr: string, t: number) => ({
  CB_MSG: { area_id: area, time: String(t), from, descr },
});
const cc = (area: string, to: string, descr: string, t: number) => ({
  CC_MSG: { area_id: area, time: String(t), to, descr },
});
const ct = (area: string, t: number) => ({ CT_MSG: { area_id: area, report_time: String(t) } });
const sf = (area: string, address: string, data: string, t: number) => ({
  SF_MSG: { area_id: area, time: String(t), address, data },
});

function uniqueArea(): string {
  return `T${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

interface CurrentStateRow {
  description: string | null;
  occupancy_id: string | null;
}

async function currentState(area: string, berth: string): Promise<CurrentStateRow | undefined> {
  const result = await pool.query<CurrentStateRow>(
    `select description, occupancy_id from berth_current_state
     where projection_version = $1 and td_area = $2 and berth_code = $3`,
    [TD_PROJECTION_VERSION, area, berth],
  );
  return result.rows[0];
}

interface OccupancyRow {
  description: string;
  exit_reason: string | null;
  left_at: Date | null;
}

async function occupancyHistory(area: string, berth: string): Promise<OccupancyRow[]> {
  const result = await pool.query<OccupancyRow>(
    `select description, exit_reason, left_at from berth_occupancy
     where projection_version = $1 and td_area = $2 and berth_code = $3
     order by entered_at asc`,
    [TD_PROJECTION_VERSION, area, berth],
  );
  return result.rows;
}

async function anomalyCount(area: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    "select count(*)::int as n from td_projection_anomaly where td_area = $1",
    [area],
  );
  return result.rows[0]?.n ?? 0;
}

describe("runProjectTd (integration)", () => {
  afterAll(async () => {
    await pool.end();
  });

  it("normal step: a matching CC-then-CA handoff produces no anomaly", async () => {
    const area = uniqueArea();
    const t = Date.now();
    await record([cc(area, "0100", "AAAA", t)], new Date(t));
    await record([ca(area, "0100", "0101", "AAAA", t + 1000)], new Date(t + 1000));

    await runProjectTd(pool);

    expect(await currentState(area, "0100")).toEqual({ description: null, occupancy_id: null });
    expect((await currentState(area, "0101"))?.description).toBe("AAAA");
    expect(await anomalyCount(area)).toBe(0);
  });

  it("cancel: CB closes the open occupancy and does not reopen it", async () => {
    const area = uniqueArea();
    const t = Date.now();
    await record([cc(area, "0200", "BBBB", t)], new Date(t));
    await record([cb(area, "0200", "BBBB", t + 1000)], new Date(t + 1000));

    await runProjectTd(pool);

    expect(await currentState(area, "0200")).toEqual({ description: null, occupancy_id: null });
    expect(await anomalyCount(area)).toBe(0);
    const history = await occupancyHistory(area, "0200");
    expect(history).toHaveLength(1);
    expect(history[0]?.exit_reason).toBe("cancelled");
  });

  it("interpose overwrite: CC into an occupied berth closes the prior occupancy", async () => {
    const area = uniqueArea();
    const t = Date.now();
    await record([cc(area, "0300", "CCCC", t)], new Date(t));
    await record([cc(area, "0300", "DDDD", t + 1000)], new Date(t + 1000));

    await runProjectTd(pool);

    expect((await currentState(area, "0300"))?.description).toBe("DDDD");
    const history = await occupancyHistory(area, "0300");
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      description: "CCCC",
      exit_reason: "overwritten_by_interpose",
    });
    expect(history[1]).toMatchObject({ description: "DDDD", exit_reason: null });
  });

  it("empty source: CA with nothing open in `from` records an anomaly but still opens `to`", async () => {
    const area = uniqueArea();
    const t = Date.now();
    await record([ca(area, "0400", "0401", "EEEE", t)], new Date(t));

    await runProjectTd(pool);

    expect((await currentState(area, "0401"))?.description).toBe("EEEE");
    expect(await anomalyCount(area)).toBe(1);
  });

  it("destination overwrite: CA into an occupied `to` closes the prior occupancy, no anomaly", async () => {
    const area = uniqueArea();
    const t = Date.now();
    await record([cc(area, "0500", "AAAA", t)], new Date(t));
    await record([cc(area, "0501", "ZZZZ", t + 500)], new Date(t + 500));
    await record([ca(area, "0500", "0501", "AAAA", t + 1000)], new Date(t + 1000));

    await runProjectTd(pool);

    expect((await currentState(area, "0501"))?.description).toBe("AAAA");
    expect(await anomalyCount(area)).toBe(0);
    const history = await occupancyHistory(area, "0501");
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ description: "ZZZZ", exit_reason: "overwritten_by_step" });
  });

  it("equal timestamp ordering: two children sharing one event_at are applied in ingestion_sequence order", async () => {
    const area = uniqueArea();
    const t = Date.now();
    // Same frame -> identical normalized_event_at_utc for both children, but child_index 0 gets
    // a lower ingestion_sequence than child_index 1 (assigned in insertion order in recorder.ts).
    await record([cc(area, "0600", "FIRST", t), cc(area, "0600", "SECOND", t)], new Date(t));

    await runProjectTd(pool);

    // If sequence order were not respected, either row could "win" depending on scan order.
    expect((await currentState(area, "0600"))?.description).toBe("SECOND");
  });

  it("duplicate delivery / restart-replay: rewinding the checkpoint and rerunning does not duplicate state", async () => {
    const area = uniqueArea();
    const t = Date.now();
    await record([cc(area, "0700", "GGGG", t)], new Date(t));
    await record([ca(area, "0700", "0701", "GGGG", t + 1000)], new Date(t + 1000));

    await runProjectTd(pool);
    const before = await currentState(area, "0701");
    const historyBefore = await occupancyHistory(area, "0701");
    expect(before?.description).toBe("GGGG");
    expect(historyBefore).toHaveLength(1);

    // Simulate a crash-before-checkpoint-advance by rewinding the shared checkpoint behind
    // these already-projected rows, then rerunning — the whole backlog (including these rows
    // and anything left over from earlier tests) gets reprocessed.
    await pool.query(
      `update projection_checkpoint set last_ingestion_sequence = 0
       where projection_definition_id = (
         select id from projection_definition where name = 'td-berth-and-s-class' and code_version = $1
       )`,
      [TD_PROJECTION_VERSION],
    );
    await runProjectTd(pool);

    const after = await currentState(area, "0701");
    const historyAfter = await occupancyHistory(area, "0701");
    expect(after).toEqual(before);
    expect(historyAfter).toHaveLength(1);
  });

  it("month partition boundary: occupancy spans two monthly partitions without error", async () => {
    await ensureMonthlyPartitions(
      pool,
      { parentTable: "berth_occupancy" },
      { referenceDate: new Date("2031-01-31T00:00:00Z"), monthsAhead: 1, monthsBehind: 0 },
    );

    const area = uniqueArea();
    const openMs = Date.UTC(2031, 0, 31, 23, 59, 0);
    const closeMs = Date.UTC(2031, 1, 1, 0, 5, 0);
    await record([cc(area, "0800", "HHHH", openMs)], new Date(openMs));
    await record([cb(area, "0800", "HHHH", closeMs)], new Date(closeMs));

    await runProjectTd(pool);

    const history = await occupancyHistory(area, "0800");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ description: "HHHH", exit_reason: "cancelled" });
    expect(history[0]?.left_at).not.toBeNull();
  });

  it("S-Class and heartbeat: SF updates td_s_current_state, CT updates td_heartbeat only", async () => {
    const area = uniqueArea();
    const t = Date.now();
    await record([sf(area, "A1", "3F", t)], new Date(t));
    await record([ct(area, t + 1000)], new Date(t + 1000));

    await runProjectTd(pool);

    const sState = await pool.query<{ raw_value: string | null }>(
      `select raw_value from td_s_current_state
       where projection_version = $1 and td_area = $2 and address = 'A1'`,
      [TD_PROJECTION_VERSION, area],
    );
    expect(sState.rows[0]?.raw_value).toBe("3F");

    const heartbeats = await pool.query<{ n: number }>(
      "select count(*)::int as n from td_heartbeat where td_area = $1",
      [area],
    );
    expect(heartbeats.rows[0]?.n).toBe(1);

    // CT never touches berth state.
    const berthRows = await pool.query<{ n: number }>(
      "select count(*)::int as n from berth_current_state where td_area = $1",
      [area],
    );
    expect(berthRows.rows[0]?.n).toBe(0);
  });

  it("rebuild: clears this version's projection state and reprocesses from zero", async () => {
    const area = uniqueArea();
    const t = Date.now();
    await record([cc(area, "0900", "IIII", t)], new Date(t));
    await runProjectTd(pool);
    expect((await currentState(area, "0900"))?.description).toBe("IIII");

    await runProjectTd(pool, { rebuild: true });

    // After a full rebuild the whole backlog (including this row) is reprocessed from scratch,
    // landing on the same end state — proving rebuild doesn't lose or duplicate data.
    expect((await currentState(area, "0900"))?.description).toBe("IIII");
    const history = await occupancyHistory(area, "0900");
    expect(history).toHaveLength(1);
  });

  it("rebuild still works once an occupancy has a berth_run_resolution row (Milestone 9)", async () => {
    // Regression test: berth_run_resolution's FK into berth_occupancy (added by the resolver
    // projector) previously made this delete fail with a foreign key violation the instant any
    // occupancy had ever been resolved — which in a real deployment is "always," once the
    // resolver runs regularly.
    const area = uniqueArea();
    const t = Date.now();
    await record([cc(area, "0910", "RSLV", t)], new Date(t));
    await runProjectTd(pool);

    const occupancy = await pool.query<{ id: string; entered_at: Date }>(
      `select id, entered_at from berth_occupancy where td_area = $1 and berth_code = $2`,
      [area, "0910"],
    );
    expect(occupancy.rows).toHaveLength(1);
    await pool.query(
      `insert into berth_run_resolution (occupancy_id, occupancy_entered_at, status, resolver_version)
       values ($1, $2, 'unmatched', 1)`,
      [occupancy.rows[0]!.id, occupancy.rows[0]!.entered_at],
    );

    await expect(runProjectTd(pool, { rebuild: true })).resolves.toBeDefined();
    expect((await currentState(area, "0910"))?.description).toBe("RSLV");
  });

  it("rebuild still works once an occupancy has been manually cleared, preserving the audit row", async () => {
    // Regression test: operator_berth_action's FK into berth_occupancy (added by the manual
    // berth-clear feature) previously made this delete fail the same way berth_run_resolution's
    // did — but unlike that pure derived-state table, this one is a permanent audit trail, so
    // the fix nulls out its dangling occupancy reference instead of deleting the audit row.
    const area = uniqueArea();
    const t = Date.now();
    await record([cc(area, "0911", "MCLR", t)], new Date(t));
    await runProjectTd(pool);

    const occupancy = await pool.query<{ id: string; entered_at: Date }>(
      `select id, entered_at from berth_occupancy where td_area = $1 and berth_code = $2`,
      [area, "0911"],
    );
    expect(occupancy.rows).toHaveLength(1);
    const action = await pool.query<{ id: string }>(
      `insert into operator_berth_action (
         td_area, berth_code, action_type, reason, closed_occupancy_id, closed_occupancy_entered_at
       ) values ($1, $2, 'clear', 'test', $3, $4)
       returning id`,
      [area, "0911", occupancy.rows[0]!.id, occupancy.rows[0]!.entered_at],
    );

    await expect(runProjectTd(pool, { rebuild: true })).resolves.toBeDefined();
    expect((await currentState(area, "0911"))?.description).toBe("MCLR");

    const preserved = await pool.query<{ closed_occupancy_id: string | null; reason: string }>(
      `select closed_occupancy_id, reason from operator_berth_action where id = $1`,
      [action.rows[0]!.id],
    );
    expect(preserved.rows[0]).toMatchObject({ closed_occupancy_id: null, reason: "test" });
  });

  it("skips instead of racing when another run already holds the advisory lock", async () => {
    // Reproduces the scenario that leaves a closeOccupancy silently unapplied: two concurrent
    // runProjectTd calls (e.g. the continuous projector loop overlapping a container restart, or
    // a manual console command) would otherwise both read the same checkpoint and race over the
    // same batch. This proves the lock makes that impossible — a second run backs off cleanly
    // instead of interleaving.
    const area = uniqueArea();
    const t = Date.now();
    await record([cc(area, "0950", "LOCK", t)], new Date(t));

    const lockKey = advisoryLockKey(TD_PROJECTION_NAME);
    const lockHolder = await pool.connect();
    try {
      const acquired = await lockHolder.query<{ locked: boolean }>(
        "select pg_try_advisory_lock($1) as locked",
        [lockKey],
      );
      expect(acquired.rows[0]?.locked).toBe(true);

      const summary = await runProjectTd(pool);
      expect(summary.skippedLockContention).toBe(true);
      expect(summary.batches).toBe(0);
      expect(await currentState(area, "0950")).toBeUndefined();
    } finally {
      await lockHolder.query("select pg_advisory_unlock($1)", [lockKey]);
      lockHolder.release();
    }

    // Once released, a normal run proceeds exactly as usual.
    const summary = await runProjectTd(pool);
    expect(summary.skippedLockContention).toBe(false);
    expect((await currentState(area, "0950"))?.description).toBe("LOCK");
  });

  it("blocks on the shared berth_occupancy write lock instead of risking a deadlock with project-resolver", async () => {
    // Regression test for a real production deadlock (40P01, 2026-08-14): project-td and
    // project-resolver each update several berth_occupancy rows per transaction, in different
    // orders, and Postgres can deadlock two such transactions even with no logical dependency
    // between the rows. apps/worker/src/shared/advisoryLock.ts's BERTH_OCCUPANCY_WRITE_LOCK_KEY
    // fixes this by making the two projectors' batch transactions take turns. This proves
    // runProjectTd actually acquires that lock (not just documents the intent) by holding it
    // externally and confirming the run genuinely blocks — not skips, not errors — until released.
    const area = uniqueArea();
    const t = Date.now();
    await record([cc(area, "0960", "DLCK", t)], new Date(t));
    await record([ca(area, "0960", "0961", "DLCK", t + 1000)], new Date(t + 1000));

    const lockHolder = await pool.connect();
    await lockHolder.query("begin");
    await lockHolder.query("select pg_advisory_xact_lock($1)", [BERTH_OCCUPANCY_WRITE_LOCK_KEY]);

    try {
      const runPromise = runProjectTd(pool);

      const outcome = await Promise.race([
        runPromise.then(() => "done" as const),
        sleep(300).then(() => "still-pending" as const),
      ]);
      expect(outcome).toBe("still-pending");

      await lockHolder.query("commit");
      await runPromise;
    } finally {
      lockHolder.release();
    }

    expect(await currentState(area, "0960")).toEqual({ description: null, occupancy_id: null });
    expect((await currentState(area, "0961"))?.description).toBe("DLCK");
  });
});
