import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Resolves this package's own `fixtures/trust/` directory, regardless of caller cwd. */
export function resolveTrustFixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled to dist/trust/fixturesDir.js; fixtures/ lives at the package root, two levels up.
  return join(here, "..", "..", "fixtures", "trust");
}
