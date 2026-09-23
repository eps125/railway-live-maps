import { Redis } from "ioredis";
import { createPool } from "@railway/database";
import { createArchiveClient } from "@railway/archive";
import type { Config } from "../config.js";
import { StompTdConnection } from "../td/connection/stomp/stompConnection.js";
import { recordFrame, markFrameAcked } from "../td/recorder.js";
import { applyLiveFromEvents, BindingsCache } from "../td/liveProjector.js";
import { createRedisDeltaPublisher } from "../td/deltaPublisher.js";
import { createIngestStatsLogger } from "../shared/ingestStats.js";
import { runUntilShutdownSignal } from "../shared/runUntilShutdownSignal.js";
import { retryUntilDone } from "../shared/retryUntilDone.js";

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

  // ADR 0003 Tier 3: fold each frame's C-Class rows into berth_current_state + publish the
  // WebSocket deltas inline here, right after recordFrame durably stores them — no wait for the
  // separate projector-td-live poll. That projector stays running as the catch-up / rebuild
  // path. Without LIVE_WS_REDIS_PUBSUB_ENABLED the upsert still runs (keeps berth_current_state
  // fresh for the API's polling delta source); only the Redis publish is skipped.
  const redisClient = config.LIVE_WS_REDIS_PUBSUB_ENABLED
    ? new Redis(config.REDIS_URL, {
        connectTimeout: 5000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      })
    : null;
  redisClient?.on("error", (error) => {
    console.error("ingest-td: redis client error (inline delta publish may be degraded):", error);
  });
  const redis = redisClient ? createRedisDeltaPublisher(redisClient) : null;
  const bindings = new BindingsCache(pool);

  const connection = new StompTdConnection({
    host: NR_TD_HOST,
    port: NR_TD_PORT,
    topic: config.NR_TD_TOPIC,
    username: config.NR_USERNAME,
    password: config.NR_PASSWORD,
  });

  const stats = createIngestStatsLogger("TD");
  let stopping = false;
  const isStopped = (): boolean => stopping;

  // Deliberately NOT awaited (2026-09-11 fix — see runUntilShutdownSignal.test.ts's "root
  // cause" test for the reproduction). StompConnection.start() runs `while (!this.stopped) {
  // ... }` internally and only resolves once `stop()` sets `stopped = true` — i.e. never,
  // during ordinary healthy operation, since nothing calls `stop()` until the shutdown handler
  // below runs. Awaiting it here first meant `runUntilShutdownSignal` (and the SIGTERM/SIGINT
  // listeners it registers) was never reached while the feed was running, so every ordinary
  // container stop/restart/redeploy sent SIGTERM to a process with no handler for it — Node's
  // default disposition terminates immediately, skipping `connection.stop()` entirely: no STOMP
  // DISCONNECT ever sent (leaving a stale session at Network Rail's broker, which can then
  // reject the next connection attempt until its own timeout releases it — see stop()'s own
  // comment), and `feed_connection_session.disconnected_at` never gets written (confirmed
  // always NULL in production). Any error from a failed connection attempt is already surfaced
  // via `onError` below, not via this promise rejecting, so nothing here needs to observe it.
  void connection.start({
    // Retried rather than thrown: SUBSCRIBE is only sent once this returns, so failing here
    // would drop the connection and pay a full reconnect for what is usually a brief DB blip.
    // Retrying a plain insert can leave an orphan row if an earlier attempt actually committed,
    // which only costs a spare bookkeeping row.
    onSessionStart: async (session) => {
      const id = await retryUntilDone(
        async () => {
          const result = await pool.query<{ id: string }>(
            `insert into feed_connection_session (feed_name, client_id, connected_at)
             values ('TD', $1, $2) returning id`,
            [session.clientId, session.connectedAt],
          );
          const inserted = result.rows[0]?.id;
          if (!inserted) throw new Error("Failed to create feed_connection_session row");
          return inserted;
        },
        { label: "TD session start record", isStopped },
      );
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
      // Retried until stored, never thrown. A frame we've received but not stored exists only
      // in this process's memory, and the subscription isn't durable, so the broker won't
      // redeliver it. Retrying is safe because every step is idempotent: the archive key is
      // content-addressed, the archive index upserts, and feed_frame dedupes on body_hash (a
      // retry after a commit whose reply was lost comes back `alreadyRecorded`). Still
      // archive-before-ack (non-negotiable rule 2): the ack only goes out once this resolves.
      const result = await retryUntilDone(
        () =>
          recordFrame(handle.frame, {
            pool,
            archiveClient,
            archiveBucket: config.RAW_ARCHIVE_BUCKET,
          }),
        { label: "TD frame record", isStopped },
      );
      await retryUntilDone(() => markFrameAcked(pool, result.frameId), {
        label: "TD frame ack mark",
        isStopped,
      });
      await handle.ack();
      stats.record(handle.frame.receivedAt, result.newestNormalizedEventAtUtc);

      // Tier 3 inline live path — strictly after the ack, so archive-before-ack (non-negotiable
      // rule 2) is untouched and a failure here can neither block ingestion nor lose durability
      // (projector-td-live catches up from its checkpoint on the next tick / a restart).
      const cClassRows = result.insertedEvents
        .filter((e) => e.messageClass === "C" && ["CA", "CB", "CC"].includes(e.eventType))
        .map((e) => ({
          id: e.id,
          normalized_event_at_utc: new Date(e.normalizedEventAtUtc),
          ingestion_sequence: e.ingestionSequence,
          event_type: e.eventType as "CA" | "CB" | "CC",
          td_area: e.tdArea ?? "",
          raw_event_json: (e.rawEventJson ?? {}) as Record<string, unknown>,
        }));
      // Milestone 36b: S-Class rows too, so signal deltas go out on the same inline path — and in
      // the same sequence order — as berth deltas.
      const sClassRows = result.insertedEvents
        .filter((e) => e.messageClass === "S")
        .map((e) => ({
          id: e.id,
          normalized_event_at_utc: new Date(e.normalizedEventAtUtc),
          ingestion_sequence: e.ingestionSequence,
          event_type: e.eventType,
          td_area: e.tdArea ?? "",
          raw_event_json: (e.rawEventJson ?? {}) as Record<string, unknown>,
        }));
      if (cClassRows.length > 0 || sClassRows.length > 0) {
        try {
          await applyLiveFromEvents(pool, redis, bindings, cClassRows, sClassRows);
        } catch (error) {
          console.error(
            "ingest-td: inline live projection failed (non-fatal; projector-td-live will catch up):",
            error,
          );
        }
      }
    },
    onError: (error) => {
      console.error("TD connection error:", error);
    },
  });

  return runUntilShutdownSignal(async () => {
    stopping = true;
    await connection.stop();
    redisClient?.disconnect();
  });
}
