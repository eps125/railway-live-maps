import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Resolves this package's own `fixtures/schedule/` directory, regardless of caller cwd. */
export function resolveScheduleFixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "fixtures", "schedule");
}
