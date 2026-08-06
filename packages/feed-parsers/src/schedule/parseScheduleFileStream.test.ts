import { createReadStream } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScheduleFileStream, type ScheduleFileRecord } from "./parseScheduleFileStream.js";
import { resolveScheduleFixturesDir } from "./fixturesDir.js";

const fixturesDir = resolveScheduleFixturesDir();

async function collect(name: string): Promise<ScheduleFileRecord[]> {
  const stream = createReadStream(join(fixturesDir, name));
  const records: ScheduleFileRecord[] = [];
  for await (const record of parseScheduleFileStream(stream)) {
    records.push(record);
  }
  return records;
}

describe("parseScheduleFileStream", () => {
  it("classifies header/schedule/tiploc/association/trailer records by wrapper key", async () => {
    const records = await collect("full-extract-small.jsonl");
    expect(records.map((r) => r.recordType)).toEqual([
      "header",
      "schedule",
      "schedule",
      "schedule",
      "schedule",
      "tiploc",
      "association",
      "trailer",
    ]);
  });

  it("STP indicators are readable straight off the schedule records (P/O/N/C for one file)", async () => {
    const records = await collect("full-extract-small.jsonl");
    const scheduleRecords = records.filter((r) => r.recordType === "schedule");
    const indicators = scheduleRecords.map(
      (r) => (r.raw as { CIF_stp_indicator: string }).CIF_stp_indicator,
    );
    expect(indicators).toEqual(["P", "O", "N", "C"]);
  });

  it("a line that isn't valid JSON becomes exactly one malformed record, not a thrown error", async () => {
    const records = await collect("malformed-line.jsonl");
    expect(records.map((r) => r.recordType)).toEqual([
      "header",
      "schedule",
      "malformed",
      "trailer",
    ]);
    expect(records[2]?.parseErrorCode).toBe("invalid_json");
  });

  it("an unrecognized-but-well-formed wrapper key is retained as unknown, never dropped", async () => {
    const records = await collect("unsupported-record-type.jsonl");
    expect(records.map((r) => r.recordType)).toEqual(["header", "unknown", "trailer"]);
  });
});
