import { createReadStream } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSmartFileStream } from "./parseSmartFileStream.js";
import { resolveReferenceFixturesDir } from "./fixturesDir.js";

const fixturesDir = resolveReferenceFixturesDir();

describe("parseSmartFileStream", () => {
  it("yields one record per BERTHDATA array entry", async () => {
    const stream = createReadStream(join(fixturesDir, "smart-small.json"));
    const records = [];
    for await (const record of parseSmartFileStream(stream)) {
      records.push(record);
    }
    expect(records).toHaveLength(2);
    expect((records[0]!.raw as { FROMBERTH: string }).FROMBERTH).toBe("0001");
  });

  it("throws (whole-file failure) when the file isn't valid JSON", async () => {
    const stream = createReadStream(join(fixturesDir, "smart-malformed.json"));
    await expect(async () => {
      for await (const _record of parseSmartFileStream(stream)) {
        // draining is enough to trigger the parse
      }
    }).rejects.toThrow();
  });
});
