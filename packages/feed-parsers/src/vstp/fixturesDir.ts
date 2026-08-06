import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Resolves this package's own `fixtures/vstp/` directory, regardless of caller cwd. */
export function resolveVstpFixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled to dist/vstp/fixturesDir.js; fixtures/ lives at the package root, two levels up.
  return join(here, "..", "..", "fixtures", "vstp");
}
