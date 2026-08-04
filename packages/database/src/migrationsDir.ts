import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Resolves the package's own `migrations/` directory, regardless of caller cwd. */
export function resolveDefaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled to dist/migrationsDir.js; migrations/ lives at the package root, one level up.
  return join(here, "..", "migrations");
}
