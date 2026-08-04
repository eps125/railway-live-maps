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
  PARTITION_MONTHS_AHEAD: z.coerce.number().int().positive().default(3),
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

  const NR_USERNAME = readSecret(env, "NR_USERNAME", { required: base.TD_LIVE_ENABLED });
  const NR_PASSWORD = readSecret(env, "NR_PASSWORD", { required: base.TD_LIVE_ENABLED });

  return { ...base, NR_USERNAME, NR_PASSWORD };
}
