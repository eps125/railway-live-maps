import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "@railway/database";
import { createArchiveClient } from "@railway/archive";
import { resolveTdFixturesDir } from "@railway/feed-parsers";
import type { Config } from "../config.js";
import { FixtureReplayTdConnection } from "../td/connection/fixtureReplayConnection.js";
import { recordFrame, markFrameAcked } from "../td/recorder.js";

interface ScenarioFile {
  fixtures: string[];
}

function resolveScenariosDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled to dist/commands/replayFixtures.js; fixtures/scenarios/ is at the package root.
  return join(here, "..", "..", "fixtures", "scenarios");
}

/**
 * Drives fixture frames through the exact same recordFrame pipeline the live TD connector
 * uses (docs/IMPLEMENTATION_PLAN.md M3: "fixture replay command that does not require live
 * credentials"). Needs DATABASE_URL/RAW_ARCHIVE_* — never NR_USERNAME/NR_PASSWORD.
 */
export async function runReplayFixtures(config: Config, argv: string[]): Promise<void> {
  const scenarioName = argv[0] ?? "multi-area-smoke";
  const scenarioPath = join(resolveScenariosDir(), `${scenarioName}.json`);
  const scenario = JSON.parse(await readFile(scenarioPath, "utf8")) as ScenarioFile;

  const fixturesDir = resolveTdFixturesDir();
  const fixturePaths = scenario.fixtures.map((name) => join(fixturesDir, name));

  const pool = createPool({ connectionString: config.DATABASE_URL });
  const archiveClient = createArchiveClient({
    endpoint: config.RAW_ARCHIVE_ENDPOINT,
    region: config.RAW_ARCHIVE_REGION,
    accessKeyId: config.RAW_ARCHIVE_ACCESS_KEY,
    secretAccessKey: config.RAW_ARCHIVE_SECRET_KEY,
  });

  const summary = {
    framesProcessed: 0,
    alreadyRecorded: 0,
    parsedChildren: 0,
    unsupportedChildren: 0,
    failedChildren: 0,
  };

  const connection = new FixtureReplayTdConnection({ fixturePaths });
  try {
    await connection.start({
      onSessionStart: async (session) => {
        const result = await pool.query<{ id: string }>(
          `insert into feed_connection_session (feed_name, client_id, connected_at)
           values ('TD', $1, $2) returning id`,
          [session.clientId, session.connectedAt],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error("Failed to create feed_connection_session row");
        return id;
      },
      onSessionEnd: async (info) => {
        await pool.query(
          `update feed_connection_session set disconnected_at = $2, disconnect_reason = $3 where id = $1`,
          [info.sessionId, info.at, info.disconnectReason],
        );
      },
      onFrame: async (handle) => {
        const result = await recordFrame(handle.frame, {
          pool,
          archiveClient,
          archiveBucket: config.RAW_ARCHIVE_BUCKET,
        });
        await markFrameAcked(pool, result.frameId);
        await handle.ack();

        summary.framesProcessed += 1;
        if (result.alreadyRecorded) summary.alreadyRecorded += 1;
        summary.parsedChildren += result.parsedChildCount;
        summary.unsupportedChildren += result.unsupportedChildCount;
        summary.failedChildren += result.failedChildCount;
      },
    });
  } finally {
    await pool.end();
  }

  console.log(`Fixture replay "${scenarioName}" complete:`, summary);
}
