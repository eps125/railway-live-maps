import { createReadStream } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCorpusFileStream } from "./parseCorpusFileStream.js";
import { resolveReferenceFixturesDir } from "./fixturesDir.js";

const fixturesDir = resolveReferenceFixturesDir();

describe("parseCorpusFileStream", () => {
  it("yields one record per TIPLOCDATA array entry", async () => {
    const stream = createReadStream(join(fixturesDir, "corpus-small.json"));
    const records = [];
    for await (const record of parseCorpusFileStream(stream)) {
      records.push(record);
    }
    expect(records).toHaveLength(2);
    expect((records[0]!.raw as { TIPLOC: string }).TIPLOC).toBe("LANCSTR");
    expect(records[0]!.seqNoInFile).toBe(1);
  });

  it("throws (whole-file failure) when the file isn't valid JSON, rather than silently yielding nothing", async () => {
    const stream = createReadStream(join(fixturesDir, "corpus-malformed.json"));
    await expect(async () => {
      for await (const _record of parseCorpusFileStream(stream)) {
        // draining is enough to trigger the parse
      }
    }).rejects.toThrow();
  });
});
