import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTdFrame } from "./parseTdFrame.js";
import { loadTdFixture } from "./loadTdFixture.js";
import { resolveTdFixturesDir } from "./fixturesDir.js";

const RECEIVED_AT = new Date("2025-01-01T00:00:05.000Z");
const fixturesDir = resolveTdFixturesDir();

async function loadBody(name: string): Promise<Buffer> {
  const fixture = await loadTdFixture(join(fixturesDir, name));
  return fixture.body;
}

describe("parseTdFrame", () => {
  it("parses a CA/CC/CB/CT sequence for one area", async () => {
    const body = await loadBody("frame-zz-c-class-sequence.json");
    const result = parseTdFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(4);
    expect(result.children.map((c) => c.eventType)).toEqual(["CA", "CC", "CB", "CT"]);
    for (const child of result.children) {
      expect(child.parseStatus).toBe("parsed");
      expect(child.tdArea).toBe("ZZ");
      expect(child.messageClass).toBe("C");
    }
  });

  it("retains a second, distinct TD area without any filtering", async () => {
    const body = await loadBody("frame-zy-c-class-sequence.json");
    const result = parseTdFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.tdArea).toBe("ZY");
    expect(result.children[0]?.parseStatus).toBe("parsed");
  });

  it("parses an S-Class message", async () => {
    const body = await loadBody("frame-zz-s-class.json");
    const result = parseTdFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({
      eventType: "SF_MSG",
      messageClass: "S",
      tdArea: "ZZ",
      parseStatus: "parsed",
    });
  });

  it("retains an unrecognized wrapper key as unsupported, not dropped", async () => {
    const body = await loadBody("frame-unknown-type.json");
    const result = parseTdFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.parseStatus).toBe("unsupported");
    expect(result.children[0]?.eventType).toBe("XX_MSG");
    expect(result.children[0]?.rawEventJson).toBeDefined();
  });

  it("isolates a malformed child from a valid sibling in the same frame", async () => {
    const body = await loadBody("frame-malformed-child.json");
    const result = parseTdFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(2);
    expect(result.children[0]?.parseStatus).toBe("parsed");
    expect(result.children[1]?.parseStatus).toBe("malformed");
    expect(result.children[1]?.parseErrorCode).toBe("missing_required_field");
    // The malformed child still carries its area/eventType — isolation, not total data loss.
    expect(result.children[1]?.tdArea).toBe("ZZ");
    expect(result.children[1]?.eventType).toBe("CB");
  });

  it("yields exactly one synthetic malformed child for a totally corrupt body", async () => {
    const body = await loadBody("frame-corrupt-body.json");
    const result = parseTdFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.parseStatus).toBe("malformed");
    expect(result.children[0]?.parseErrorCode).toBe("invalid_json");
  });

  it("never returns zero children even for an empty array body", () => {
    const result = parseTdFrame(Buffer.from("[]"), { receivedAt: RECEIVED_AT });
    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.parseStatus).toBe("malformed");
    expect(result.children[0]?.parseErrorCode).toBe("empty_array");
  });

  it("transparently decompresses a gzip-compressed body", async () => {
    const body = await loadBody("frame-zz-c-class-sequence.json");
    const gzipped = gzipSync(body);

    const plain = parseTdFrame(body, { receivedAt: RECEIVED_AT });
    const fromGzip = parseTdFrame(gzipped, { receivedAt: RECEIVED_AT });

    expect(fromGzip.children).toHaveLength(plain.children.length);
    expect(fromGzip.children.map((c) => c.eventType)).toEqual(
      plain.children.map((c) => c.eventType),
    );
  });

  it("falls back to receivedAt and records the reason when a timestamp is implausible", () => {
    const body = Buffer.from(
      JSON.stringify([
        { CT_MSG: { area_id: "ZZ", report_time: "1" } }, // 1970, wildly implausible vs RECEIVED_AT
      ]),
    );
    const result = parseTdFrame(body, { receivedAt: RECEIVED_AT });

    expect(result.children[0]?.parseStatus).toBe("parsed");
    expect(result.children[0]?.timestampCorrectionCode).toBe("implausible_skew");
    expect(result.children[0]?.normalizedEventAtUtc).toBe(RECEIVED_AT.toISOString());
    expect(result.children[0]?.rawSourceTimestampText).toBe("1");
  });
});
