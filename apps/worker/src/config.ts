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
  NR_VSTP_TOPIC: z.string().default("/topic/VSTP_ALL"),
  // Same credential-gated discipline as TD_LIVE_ENABLED — see docs/IMPLEMENTATION_PLAN.md
  // Milestone 7's "live enablement checkpoint": only flip on after fixture replay + the
  // integration suite pass.
  VSTP_LIVE_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  NR_TRUST_TOPIC: z.string().default("/topic/TRAIN_MVT_ALL_TOC"),
  // Same credential-gated discipline, per Milestone 8's "live enablement checkpoint".
  TRUST_LIVE_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  // CORPUS/SMART confirmed correct against the live NR file service (2026-08-10 — both
  // downloaded and imported successfully). SCHEDULE originally pointed at
  // SupportingFileAuthenticate (a 404 in production, confirmed 2026-08-10) — the real CIF full
  // extract lives at a different endpoint, CifFileAuthenticate, and requires an additional
  // `day=toc-full` query param that SupportingFileAuthenticate's downloads never needed.
  NR_SCHEDULE_DOWNLOAD_URL: z
    .string()
    .default(
      "https://publicdatafeeds.networkrail.co.uk/ntrod/CifFileAuthenticate?type=CIF_ALL_FULL_DAILY&day=toc-full",
    ),
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
  // Off by default, same discipline as TD/VSTP_LIVE_ENABLED: only the file-path `import-*`
  // commands are exercised until this is explicitly turned on.
  SCHEDULE_DOWNLOAD_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  // Europe/London wall-clock time (HH:MM, 24h) the schedule-reference-refresh long-running role
  // runs download-schedule/download-smart/download-corpus at, once a day. Only takes effect when
  // SCHEDULE_DOWNLOAD_ENABLED=true — same gate every download-* command already enforces.
  REFERENCE_DATA_REFRESH_TIME: z
    .string()
    .default("01:00")
    .refine((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value), {
      message: "REFERENCE_DATA_REFRESH_TIME must be HH:MM 24-hour (e.g. 01:00)",
    }),
  PARTITION_MONTHS_AHEAD: z.coerce.number().int().positive().default(3),
  // Milestone 9: the `project-resolver` live loop only resolves berth occupancies whose
  // `entered_at` is within this many hours. Keeps a RESOLVER_VERSION bump (which starts a fresh
  // checkpoint at 0) from grinding oldest-first through every retained nationwide day before the
  // live map reflects "now". Not an ingestion/projection filter — ingestion and the
  // TD/berth-occupancy projections stay fully nationwide; older resolver history is caught up on
  // demand via `project-resolver --backfill --since <date>`, and `--rebuild` ignores this.
  RESOLVER_LIVE_WINDOW_HOURS: z.coerce.number().int().positive().default(72),
  // Milestone 6: gates the optional `project-map-deltas` Redis pub/sub publisher. Must match
  // apps/api/src/config.ts's flag of the same name — if only the API side is on, it subscribes
  // to a channel nothing publishes to (falls back to nothing, since polling stays the source
  // of correctness regardless); if only the worker side is on, publishes go nowhere.
  LIVE_WS_REDIS_PUBSUB_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
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

  const nrCredentialsRequired =
    base.TD_LIVE_ENABLED ||
    base.VSTP_LIVE_ENABLED ||
    base.TRUST_LIVE_ENABLED ||
    base.SCHEDULE_DOWNLOAD_ENABLED;
  const NR_USERNAME = readSecret(env, "NR_USERNAME", { required: nrCredentialsRequired });
  const NR_PASSWORD = readSecret(env, "NR_PASSWORD", { required: nrCredentialsRequired });

  return { ...base, NR_USERNAME, NR_PASSWORD };
}
