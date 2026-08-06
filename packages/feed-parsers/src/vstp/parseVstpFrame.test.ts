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
    const body = await loadBody("create-normal.xml");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({ eventType: "vstp.create", parseStatus: "parsed" });
  });

  it("parses an Overwrite transaction", async () => {
    const body = await loadBody("overwrite-normal.xml");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({
      eventType: "vstp.overwrite",
      parseStatus: "parsed",
    });
  });

  it("parses a Delete transaction", async () => {
    const body = await loadBody("delete-normal.xml");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({ eventType: "vstp.delete", parseStatus: "parsed" });
  });

  it("retains an unrecognized root element as unsupported, never dropped", async () => {
    const body = await loadBody("unsupported-root-element.xml");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.parseStatus).toBe("unsupported");
    expect(result.children[0]?.eventType).toContain("SomeFutureVSTPMessageType");
  });

  it("a totally malformed body still yields exactly one synthetic malformed child, never zero", async () => {
    const body = await loadBody("malformed.xml");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.parseStatus).toBe("malformed");
    expect(result.children[0]?.parseErrorCode).toBe("invalid_xml");
  });

  it("transparently decompresses a gzip-compressed body", async () => {
    const body = await loadBody("gzip-normal.xml.gz");
    const result = parseVstpFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({ eventType: "vstp.create", parseStatus: "parsed" });
  });
});
