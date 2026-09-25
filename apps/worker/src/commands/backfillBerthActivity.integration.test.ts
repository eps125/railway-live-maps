import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPool } from "@railway/database";
import { recordFrame, markFrameAcked, type InboundFrame } from "../td/recorder.js";
import { runProjectTd } from "../td/projector.js";
import { backfillBerthActivityDay } from "./backfillBerthActivity.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for integration tests`);
  return value;
}

/** Only the Postgres side is exercised; same fake as the projector's own integration test. */
class FakeS3Client {
  send = async (): Promise<Record<string, never>> => ({});
}

const pool = createPool({ connectionString: requireEnv("DATABASE_URL") });

async function record(children: unknown[], receivedAt: Date): Promise<void> {
  const frame: InboundFrame = {
    feedName: "TD",
    topic: "/topic/TD_ALL_SIG_AREA",
    brokerMessageId: randomUUID(),
    headers: {},
    body: Buffer.from(JSON.stringify(children), "utf8"),
    receivedAt,
    connectionSessionId: null,
  };
  const result = await recordFrame(frame, {
    pool,
    archiveClient: new FakeS3Client() as unknown as S3Client,
    archiveBucket: "railway-raw-test",
  });
  await markFrameAcked(pool, result.frameId);
}

describe("backfill-berth-activity (integration, Milestone 72)", () => {
  afterAll(async () => {
    await pool.query("delete from feed_gap where detection_reason = 'td_receive_silence'");
    await pool.end();
  });

  it("recounts a day's events up to the cutover as absolute 'backfill' rows, idempotently", async () => {
    const area = `B${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();
    const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 10);
    const day = new Date(t).toISOString().slice(0, 10);
    await record(
      [{ CC_MSG: { area_id: area, time: String(t), to: "0001", descr: "1A01" } }],
      new Date(t),
    );
    await record(
      [
        {
          CA_MSG: {
            area_id: area,
            time: String(t + 1000),
            from: "0001",
            to: "0002",
            descr: "1A01",
          },
        },
      ],
      new Date(t + 1000),
    );
    await record(
      [{ CB_MSG: { area_id: area, time: String(t + 2000), from: "0002", descr: "1A01" } }],
      new Date(t + 2000),
    );
    await runProjectTd(pool);

    const sequences = await pool.query<{ ingestion_sequence: string }>(
      "select ingestion_sequence from td_berth_event where td_area = $1 order by ingestion_sequence",
      [area],
    );
    expect(sequences.rows).toHaveLength(3);
    // Pretend the live counter took over after the second event.
    const cutover = sequences.rows[1]!.ingestion_sequence;

    const backfillRows = async (): Promise<unknown[]> =>
      (
        await pool.query(
          `select berth, events_in, events_out, first_event_at, last_event_at
             from td_berth_daily_activity
            where td_area = $1 and activity_date = $2::date and source = 'backfill'
            order by berth`,
          [area, day],
        )
      ).rows;

    expect(await backfillBerthActivityDay(pool, area, day, cutover)).toBe(2);
    const first = await backfillRows();
    expect(first).toEqual([
      {
        berth: "0001",
        events_in: 1,
        events_out: 1,
        first_event_at: new Date(t),
        last_event_at: new Date(t + 1000),
      },
      // The CB after the cutover is not counted here.
      {
        berth: "0002",
        events_in: 1,
        events_out: 0,
        first_event_at: new Date(t + 1000),
        last_event_at: new Date(t + 1000),
      },
    ]);

    // Absolute, not additive: a re-run leaves the same totals.
    await backfillBerthActivityDay(pool, area, day, cutover);
    expect(await backfillRows()).toEqual(first);

    // Another day has nothing for this area.
    const otherDay = new Date(t - 86_400_000).toISOString().slice(0, 10);
    expect(await backfillBerthActivityDay(pool, area, otherDay, cutover)).toBe(0);
  });
});
