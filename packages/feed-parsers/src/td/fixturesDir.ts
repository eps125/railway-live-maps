import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Resolves this package's own `fixtures/td/` directory, regardless of caller cwd. */
export function resolveTdFixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled to dist/td/fixturesDir.js; fixtures/ lives at the package root, two levels up.
  return join(here, "..", "..", "fixtures", "td");
}
