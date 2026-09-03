import { z } from "zod";
import { readSecret } from "./secrets.js";

const baseSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  RAW_ARCHIVE_ENDPOINT: z.string().min(1, "RAW_ARCHIVE_ENDPOINT is required"),
  RAW_ARCHIVE_BUCKET: z.string().min(1, "RAW_ARCHIVE_BUCKET is required"),
  RAW_ARCHIVE_ACCESS_KEY: z.string().min(1, "RAW_ARCHIVE_ACCESS_KEY is required"),
  RAW_ARCHIVE_SECRET_KEY: z.string().min(1, "RAW_ARCHIVE_SECRET_KEY is required"),
  RAW_ARCHIVE_REGION: z.string().default("us-east-1"),
  // Nationwide ingestion is a non-negotiable invariant (docs/ARCHITECTURE.md §9);
  // there must never be an area allow-list, so this is validated rather than just read.
  CAPTURE_ALL_TD: z
    .string()
    .default("true")
    .refine((value) => value === "true", {
      message: "CAPTURE_ALL_TD must be 'true' — nationwide ingestion cannot be disabled",
    }),
  NR_TD_TOPIC: z.string().default("/topic/TD_ALL_SIG_AREA"),
  // Default off everywhere (including CI and the default Compose worker command).
  // The live STOMP connection is not constructible unless this is explicitly "true".
  TD_LIVE_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  // VSTP_LIVE_ENABLED / TRUST_LIVE_ENABLED / NR_VSTP_TOPIC / NR_TRUST_TOPIC / NR_SCHEDULE_DOWNLOAD_URL
  // were removed with ADR 0002 (2026-09-01): RLM no longer subscribes to NR for VSTP/TRUST/SCHEDULE.
  // That data is mirrored from openrail-eps via the GARNER_* config below.
  // CORPUS/SMART confirmed correct against the live NR file service (2026-08-10).
  NR_CORPUS_DOWNLOAD_URL: z
    .string()
    .default(
      "https://publicdatafeeds.networkrail.co.uk/ntrod/SupportingFileAuthenticate?type=CORPUS",
    ),
  NR_SMART_DOWNLOAD_URL: z
    .string()
    .default(
      "https://publicdatafeeds.networkrail.co.uk/ntrod/SupportingFileAuthenticate?type=SMART",
    ),
  // Off by default. Gates the download-{corpus,smart} commands and the schedule-reference-refresh
  // role. Still named SCHEDULE_DOWNLOAD_ENABLED for env compatibility; the CIF SCHEDULE download
  // was removed with ADR 0002.
  SCHEDULE_DOWNLOAD_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  // Europe/London wall-clock time (HH:MM, 24h) the schedule-reference-refresh long-running role
  // runs download-smart / download-corpus at, once a day. Only takes effect when
  // SCHEDULE_DOWNLOAD_ENABLED=true.
  REFERENCE_DATA_REFRESH_TIME: z
    .string()
    .default("01:00")
    .refine((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value), {
      message: "REFERENCE_DATA_REFRESH_TIME must be HH:MM 24-hour (e.g. 01:00)",
    }),
  PARTITION_MONTHS_AHEAD: z.coerce.number().int().positive().default(3),
  // Milestone 15 / ADR 0002: the `ingest-garner` bridge reads TRUST/VSTP-schedule/CORPUS/SMART
  // data from the operator's openrail-eps MariaDB instead of RLM subscribing to Network Rail a
  // second time. Off by default — same discipline as TD_LIVE_ENABLED. When true, GARNER_DB_* must
  // all be set (loadConfig fails otherwise) and should point at a read-only user (see
  // openrail-eps' docker/README "External read access").
  GARNER_BRIDGE_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  GARNER_DB_HOST: z.string().default(""),
  GARNER_DB_PORT: z.coerce.number().int().positive().default(3306),
  GARNER_DB_NAME: z.string().default("rail"),
  GARNER_DB_USER: z.string().default(""),
  GARNER_DB_PASSWORD: z.string().default(""),
  /** How far back the bridge's first run backfills each garner source table (by `created`
   * epoch-seconds). garner keeps ~15 days live before archiving; a bounded initial window keeps
   * RLM's mirror small (ADR 0002: RLM is not the long-term store for these feeds). */
  GARNER_BRIDGE_BACKFILL_DAYS: z.coerce.number().int().positive().default(14),
  // Milestone 6: gates the optional `project-map-deltas` Redis pub/sub publisher. Must match
  // apps/api/src/config.ts's flag of the same name — if only the API side is on, it subscribes
  // to a channel nothing publishes to (falls back to nothing, since polling stays the source
  // of correctness regardless); if only the worker side is on, publishes go nowhere.
  LIVE_WS_REDIS_PUBSUB_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  // Milestone 10: how often the `snapshot-maps-daemon` role writes a `map_state_snapshot` per
  // effective published map version. Snapshots are a cache/audit of the same reconstruction
  // `/state?at=` performs — 5 min is ample; not latency-sensitive.
  SNAPSHOT_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
});

export interface Config extends z.infer<typeof baseSchema> {
  /** Resolved from NR_USERNAME or NR_USERNAME_FILE. Only present/required when TD_LIVE_ENABLED. */
  NR_USERNAME: string | undefined;
  /** Resolved from NR_PASSWORD or NR_PASSWORD_FILE. Only present/required when TD_LIVE_ENABLED. Never logged. */
  NR_PASSWORD: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = baseSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.message}`);
  }
  const base = result.data;

  const nrCredentialsRequired = base.TD_LIVE_ENABLED || base.SCHEDULE_DOWNLOAD_ENABLED;
  const NR_USERNAME = readSecret(env, "NR_USERNAME", { required: nrCredentialsRequired });
  const NR_PASSWORD = readSecret(env, "NR_PASSWORD", { required: nrCredentialsRequired });

  if (base.GARNER_BRIDGE_ENABLED && (!base.GARNER_DB_HOST || !base.GARNER_DB_USER)) {
    throw new Error(
      "Invalid configuration: GARNER_BRIDGE_ENABLED=true requires GARNER_DB_HOST and GARNER_DB_USER (and normally GARNER_DB_PASSWORD)",
    );
  }

  return { ...base, NR_USERNAME, NR_PASSWORD };
}
