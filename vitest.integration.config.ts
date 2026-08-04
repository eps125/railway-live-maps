import { defineConfig } from "vitest/config";

/**
 * Needs a real, migrated Postgres (DATABASE_URL) and a real S3-compatible archive
 * (RAW_ARCHIVE_*) — see docs/progress.md / CI for how these are provisioned. Kept out of
 * the default `pnpm test` run so that stays infra-free; run explicitly via `pnpm run
 * test:integration`.
 */
export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.integration.test.ts", "packages/*/src/**/*.integration.test.ts"],
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
