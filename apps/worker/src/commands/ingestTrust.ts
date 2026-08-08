import { createPool } from "@railway/database";
import { createArchiveClient } from "@railway/archive";
import type { Config } from "../config.js";
import { StompTrustConnection } from "../trust/connection/stomp/stompConnection.js";
import { recordTrustFrame, markTrustFrameAcked } from "../trust/recorder.js";
import { createIngestStatsLogger } from "../shared/ingestStats.js";

const NR_TRUST_HOST = "publicdatafeeds.networkrail.co.uk";
const NR_TRUST_PORT = 61618;

/**
 * The live Network Rail TRUST connector. Refuses to start unless TRUST_LIVE_ENABLED=true and
 * NR_USERNAME/NR_PASSWORD (or _FILE variants) are set — same gating discipline as
 * `ingestTd.ts`/`ingestVstp.ts`: only enable after `worker replay-fixtures` and the integration
 * suite have passed. Not exercised against a live broker in this development environment.
 */
export async function runIngestTrust(config: Config): Promise<never> {
  if (!config.TRUST_LIVE_ENABLED) {
    throw new Error(
      "ingest-trust requires TRUST_LIVE_ENABLED=true. Run `worker replay-fixtures` and the " +
        "integration suite first — see docs/IMPLEMENTATION_PLAN.md Milestone 8.",
    );
  }
  if (!config.NR_USERNAME || !config.NR_PASSWORD) {
    throw new Error(
      "ingest-trust requires NR_USERNAME/NR_PASSWORD (or the _FILE variants) to be set",
    );
  }

  const pool = createPool({ connectionString: config.DATABASE_URL });
  const archiveClient = createArchiveClient({
    endpoint: config.RAW_ARCHIVE_ENDPOINT,
    region: config.RAW_ARCHIVE_REGION,
    accessKeyId: config.RAW_ARCHIVE_ACCESS_KEY,
    secretAccessKey: config.RAW_ARCHIVE_SECRET_KEY,
  });

  const connection = new StompTrustConnection({
    host: NR_TRUST_HOST,
    port: NR_TRUST_PORT,
    topic: config.NR_TRUST_TOPIC,
    username: config.NR_USERNAME,
    password: config.NR_PASSWORD,
  });

  const stats = createIngestStatsLogger("TRUST");

  await connection.start({
    onSessionStart: async (session) => {
      const result = await pool.query<{ id: string }>(
        `insert into feed_connection_session (feed_name, client_id, connected_at)
         values ('TRUST', $1, $2) returning id`,
        [session.clientId, session.connectedAt],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error("Failed to create feed_connection_session row");
      console.log(`TRUST session started: ${session.clientId}`);
      return id;
    },
    onSessionEnd: async (info) => {
      await pool.query(
        `update feed_connection_session set disconnected_at = $2, disconnect_reason = $3 where id = $1`,
        [info.sessionId, info.at, info.disconnectReason],
      );
      console.log(`TRUST session ended: ${info.disconnectReason}`);
    },
    onFrame: async (handle) => {
      const result = await recordTrustFrame(handle.frame, {
        pool,
        archiveClient,
        archiveBucket: config.RAW_ARCHIVE_BUCKET,
      });
      await markTrustFrameAcked(pool, result.frameId);
      await handle.ack();
      stats.record(handle.frame.receivedAt, result.newestNormalizedEventAtUtc);
    },
    onError: (error) => {
      console.error("TRUST connection error:", error);
    },
  });

  return new Promise<never>(() => {});
}
