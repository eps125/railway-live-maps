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
