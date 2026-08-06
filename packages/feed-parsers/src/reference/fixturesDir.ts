import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Resolves this package's own `fixtures/reference/` directory, regardless of caller cwd. */
export function resolveReferenceFixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "fixtures", "reference");
}
