import { z } from "zod";

const configSchema = z.object({
  APP_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),
  DISPLAY_TIMEZONE: z.string().default("Europe/London"),
  EDITOR_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  // Milestone 6: when true, the live WebSocket layer subscribes to worker-published Redis
  // pub/sub deltas instead of polling the database itself. Must match the worker's own flag
  // of the same name (apps/worker/src/config.ts) — if only one side has it on, deltas either
  // never arrive (worker not publishing) or never reach the API (API not subscribing).
  LIVE_WS_REDIS_PUBSUB_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  LIVE_WS_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  LIVE_WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
});

export type Config = z.infer<typeof configSchema>;

/** Validates process env at startup and fails fast on missing/invalid values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.message}`);
  }
  return result.data;
}
