import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseVstpFrame } from "./parseVstpFrame.js";
import { resolveVstpFixturesDir } from "./fixturesDir.js";

const RECEIVED_AT = new Date("2026-08-06T00:00:05.000Z");
const fixturesDir = resolveVstpFixturesDir();

async function loadBody(name: string): Promise<Buffer> {
  return readFile(join(fixturesDir, name));
}

describe("parseVstpFrame", () => {
  it("parses a Create transaction", async () => {
    const body = await loadBody("create-normal.json");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({ eventType: "vstp.create", parseStatus: "parsed" });
  });

  it("parses an Overwrite transaction", async () => {
    const body = await loadBody("overwrite-normal.json");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({
      eventType: "vstp.overwrite",
      parseStatus: "parsed",
    });
  });

  it("parses a Delete transaction", async () => {
    const body = await loadBody("delete-normal.json");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({ eventType: "vstp.delete", parseStatus: "parsed" });
  });

  it("parses an Update transaction (a real, undocumented fourth transaction type)", async () => {
    const body = await loadBody("update-normal.json");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({ eventType: "vstp.update", parseStatus: "parsed" });
  });

  it("retains an unrecognized root key as unsupported, never dropped", async () => {
    const body = await loadBody("unsupported-root-element.json");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.parseStatus).toBe("unsupported");
    expect(result.children[0]?.eventType).toContain("SomeFutureVSTPMessageType");
  });

  it("a totally malformed body still yields exactly one synthetic malformed child, never zero", async () => {
    const body = await loadBody("malformed.json");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.parseStatus).toBe("malformed");
    expect(result.children[0]?.parseErrorCode).toBe("invalid_json");
  });

  it("transparently decompresses a gzip-compressed body", async () => {
    const body = await loadBody("gzip-normal.json.gz");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({ eventType: "vstp.create", parseStatus: "parsed" });
  });

  it("captures a real-shaped payload's fields correctly (no CIF_bs wrapper, segment-nested train details)", async () => {
    const body = await loadBody("create-normal.json");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });
    const child = result.children[0]!;

    expect(child.parseStatus).toBe("parsed");
    const parsedJson = child.rawEventJson as {
      VSTPCIFMsgV1: { schedule: { CIF_train_uid: string; schedule_segment: unknown[] } };
    };
    expect(parsedJson.VSTPCIFMsgV1.schedule.CIF_train_uid).toBe("ZZ12345");
    expect(Array.isArray(parsedJson.VSTPCIFMsgV1.schedule.schedule_segment)).toBe(true);
  });

  it("extracts the real message-level timestamp field instead of falling back to receivedAt", async () => {
    const body = await loadBody("create-normal.json");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });
    const child = result.children[0]!;

    // create-normal.json's timestamp is "1785974400000" (epoch ms) -> 2026-08-06T00:00:00.000Z.
    expect(child.rawSourceTimestampMs).toBe(1785974400000);
    expect(child.normalizedEventAtUtc).toBe("2026-08-06T00:00:00.000Z");
    expect(child.timestampCorrectionCode).toBe("none");
  });
});
