import { createPool } from "@railway/database";
import { createArchiveClient } from "@railway/archive";
import type { Config } from "../config.js";
import { StompTdConnection } from "../td/connection/stomp/stompConnection.js";
import { recordFrame, markFrameAcked } from "../td/recorder.js";
import { createIngestStatsLogger } from "../shared/ingestStats.js";

const NR_TD_HOST = "publicdatafeeds.networkrail.co.uk";
const NR_TD_PORT = 61618;

/**
 * The live Network Rail TD connector. Refuses to start unless TD_LIVE_ENABLED=true and
 * NR_USERNAME/NR_PASSWORD (or _FILE variants) are set — per docs/IMPLEMENTATION_PLAN.md M3,
 * this must only be enabled after `worker replay-fixtures` and the integration suite have
 * passed. Not exercised against a live broker in this development environment.
 */
export async function runIngestTd(config: Config): Promise<never> {
  if (!config.TD_LIVE_ENABLED) {
    throw new Error(
      "ingest-td requires TD_LIVE_ENABLED=true. Run `worker replay-fixtures` and the integration " +
        "suite first — see docs/IMPLEMENTATION_PLAN.md Milestone 3.",
    );
  }
  if (!config.NR_USERNAME || !config.NR_PASSWORD) {
    throw new Error("ingest-td requires NR_USERNAME/NR_PASSWORD (or the _FILE variants) to be set");
  }

  const pool = createPool({ connectionString: config.DATABASE_URL });
  const archiveClient = createArchiveClient({
    endpoint: config.RAW_ARCHIVE_ENDPOINT,
    region: config.RAW_ARCHIVE_REGION,
    accessKeyId: config.RAW_ARCHIVE_ACCESS_KEY,
    secretAccessKey: config.RAW_ARCHIVE_SECRET_KEY,
  });

  const connection = new StompTdConnection({
    host: NR_TD_HOST,
    port: NR_TD_PORT,
    topic: config.NR_TD_TOPIC,
    username: config.NR_USERNAME,
    password: config.NR_PASSWORD,
  });

  const stats = createIngestStatsLogger("TD");

  await connection.start({
    onSessionStart: async (session) => {
      const result = await pool.query<{ id: string }>(
        `insert into feed_connection_session (feed_name, client_id, connected_at)
         values ('TD', $1, $2) returning id`,
        [session.clientId, session.connectedAt],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error("Failed to create feed_connection_session row");
      console.log(`TD session started: ${session.clientId}`);
      return id;
    },
    onSessionEnd: async (info) => {
      await pool.query(
        `update feed_connection_session set disconnected_at = $2, disconnect_reason = $3 where id = $1`,
        [info.sessionId, info.at, info.disconnectReason],
      );
      console.log(`TD session ended: ${info.disconnectReason}`);
    },
    onFrame: async (handle) => {
      const result = await recordFrame(handle.frame, {
        pool,
        archiveClient,
        archiveBucket: config.RAW_ARCHIVE_BUCKET,
      });
      await markFrameAcked(pool, result.frameId);
      await handle.ack();
      stats.record(handle.frame.receivedAt, result.newestNormalizedEventAtUtc);
    },
    onError: (error) => {
      console.error("TD connection error:", error);
    },
  });

  return new Promise<never>(() => {});
}
