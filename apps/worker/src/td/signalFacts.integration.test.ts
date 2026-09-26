import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createPool, fetchSByteFactsAt } from "@railway/database";
import { SIGNAL_STATE_LOOKBACK_MS } from "@railway/domain";
import { recordFrame, markFrameAcked, type InboundFrame } from "./recorder.js";
import { runProjectTd } from "./projector.js";

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

async function recordSf(area: string, address: string, data: string, at: number): Promise<void> {
  const frame: InboundFrame = {
    feedName: "TD",
    topic: "/topic/TD_ALL_SIG_AREA",
    brokerMessageId: randomUUID(),
    headers: {},
    body: Buffer.from(
      JSON.stringify([{ SF_MSG: { area_id: area, time: String(at), address, data } }]),
      "utf8",
    ),
    receivedAt: new Date(at),
    connectionSessionId: null,
  };
  const result = await recordFrame(frame, {
    pool,
    archiveClient: new FakeS3Client() as unknown as S3Client,
    archiveBucket: "railway-raw-test",
  });
  await markFrameAcked(pool, result.frameId);
}

describe("fetchSByteFactsAt (integration, 2026-09-26 quiet bytes)", () => {
  afterAll(async () => {
    // The fixtures are hours apart, so the projector records receive silences; clean them up
    // (a gap with no td_area applies to every area in later suites).
    await pool.query("delete from feed_gap where detection_reason = 'td_receive_silence'");
    await pool.end();
  });

  it("finds a byte last stated more than six hours ago, and falls back to history for playback", async () => {
    const area = `Q${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = Date.now();
    const eightHoursAgo = now - 8 * 3_600_000;
    const oneHourAgo = now - 3_600_000;
    // Byte 10 stated 05, then (much later) 07. Byte 11 is never stated.
    await recordSf(area, "10", "05", eightHoursAgo);
    await recordSf(area, "10", "07", oneHourAgo);
    await runProjectTd(pool);

    const bytes = [
      { tdArea: area, address: "10" },
      { tdArea: area, address: "11" },
    ];

    // Live: the latest statement, straight from td_s_current_state.
    const live = await fetchSByteFactsAt(pool, bytes, new Date(now), SIGNAL_STATE_LOOKBACK_MS);
    expect(live.get(`${area}|10`)?.value).toBe(7);
    expect(live.has(`${area}|11`)).toBe(false);

    // Playback two hours ago: after the first statement, before the second — from td_s_event.
    const past = await fetchSByteFactsAt(
      pool,
      bytes,
      new Date(now - 2 * 3_600_000),
      SIGNAL_STATE_LOOKBACK_MS,
    );
    expect(past.get(`${area}|10`)?.value).toBe(5);

    // A byte quiet for longer than the lookback is unknown rather than carried forward.
    const shortWindow = await fetchSByteFactsAt(
      pool,
      bytes,
      new Date(now - 2 * 3_600_000),
      3_600_000,
    );
    expect(shortWindow.has(`${area}|10`)).toBe(false);

    // And the old six-hour window would have lost the byte at eight hours: the live row is the
    // one-hour-old statement, so check the eight-hour-old one directly at a time just after it.
    const quiet = await fetchSByteFactsAt(
      pool,
      bytes,
      new Date(eightHoursAgo + 6.5 * 3_600_000),
      SIGNAL_STATE_LOOKBACK_MS,
    );
    expect(quiet.get(`${area}|10`)?.value).toBe(5);
  });
});
