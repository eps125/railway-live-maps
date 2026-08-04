import { Redis } from "ioredis";
import { createPool, checkConnectivity as checkPostgres } from "@railway/database";
import { createArchiveClient, checkArchiveConnectivity } from "@railway/archive";
import type { Config } from "../config.js";

export async function runCheckConnectivity(config: Config): Promise<void> {
  const pool = createPool({ connectionString: config.DATABASE_URL });
  const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });

  try {
    await checkPostgres(pool);
    console.log("postgres: ok");
  } finally {
    await pool.end();
  }

  try {
    await redis.connect();
    await redis.ping();
    console.log("redis: ok");
  } finally {
    redis.disconnect();
  }

  const client = createArchiveClient({
    endpoint: config.RAW_ARCHIVE_ENDPOINT,
    region: config.RAW_ARCHIVE_REGION,
    accessKeyId: config.RAW_ARCHIVE_ACCESS_KEY,
    secretAccessKey: config.RAW_ARCHIVE_SECRET_KEY,
  });
  // Read-only reachability check; bucket creation is the separate ensure-archive-bucket command.
  await checkArchiveConnectivity(client);
  console.log("archive: ok");
}
