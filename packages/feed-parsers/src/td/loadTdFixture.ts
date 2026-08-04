import { readFile } from "node:fs/promises";

export interface TdFixture {
  headers: Record<string, string>;
  body: Buffer;
}

interface RawFixtureFile {
  headers: Record<string, string>;
  bodyText: string;
}

/** Loads a `fixtures/td/*.json` file (used by both unit tests and the worker's
 * `replay-fixtures` command / FixtureReplayTdConnection — this is a real feature, not
 * test-only scaffolding, since no-credentials fixture replay is a Milestone 3 requirement). */
export async function loadTdFixture(path: string): Promise<TdFixture> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as RawFixtureFile;
  return { headers: parsed.headers, body: Buffer.from(parsed.bodyText, "utf8") };
}
