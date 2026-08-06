import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTrustFrame } from "./parseTrustFrame.js";
import { resolveTrustFixturesDir } from "./fixturesDir.js";

const RECEIVED_AT = new Date("2026-08-06T00:00:05.000Z");
const fixturesDir = resolveTrustFixturesDir();

async function loadBody(name: string): Promise<Buffer> {
  return readFile(join(fixturesDir, name));
}

describe("parseTrustFrame", () => {
  it("parses an Activation message", async () => {
    const body = await loadBody("activation.json");
    const result = parseTrustFrame(body, { receivedAt: RECEIVED_AT });
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({ eventType: "activation", parseStatus: "parsed" });
  });

  it("parses a Movement message (on-time)", async () => {
    const body = await loadBody("movement-on-time.json");
    const result = parseTrustFrame(body, { receivedAt: RECEIVED_AT });
    expect(result.children[0]).toMatchObject({ eventType: "movement", parseStatus: "parsed" });
  });

  it("parses a Movement message (early)", async () => {
    const body = await loadBody("movement-early.json");
    const result = parseTrustFrame(body, { receivedAt: RECEIVED_AT });
    expect(result.children[0]).toMatchObject({ eventType: "movement", parseStatus: "parsed" });
  });

  it("parses a Movement message (late)", async () => {
    const body = await loadBody("movement-late.json");
    const result = parseTrustFrame(body, { receivedAt: RECEIVED_AT });
    expect(result.children[0]).toMatchObject({ eventType: "movement", parseStatus: "parsed" });
  });

  it("parses a Movement message (off-route)", async () => {
    const body = await loadBody("movement-off-route.json");
    const result = parseTrustFrame(body, { receivedAt: RECEIVED_AT });
    expect(result.children[0]).toMatchObject({ eventType: "movement", parseStatus: "parsed" });
  });

  it("parses a Cancellation message", async () => {
    const body = await loadBody("cancellation.json");
    const result = parseTrustFrame(body, { receivedAt: RECEIVED_AT });
    expect(result.children[0]).toMatchObject({ eventType: "cancellation", parseStatus: "parsed" });
  });

  it("parses a Reinstatement message", async () => {
    const body = await loadBody("reinstatement.json");
    const result = parseTrustFrame(body, { receivedAt: RECEIVED_AT });
    expect(result.children[0]).toMatchObject({
      eventType: "reinstatement",
      parseStatus: "parsed",
    });
  });

  it("parses a Change of Origin message", async () => {
    const body = await loadBody("change-of-origin.json");
    const result = parseTrustFrame(body, { receivedAt: RECEIVED_AT });
    expect(result.children[0]).toMatchObject({
      eventType: "change_of_origin",
      parseStatus: "parsed",
    });
  });

  it("parses a Change of Identity message", async () => {
    const body = await loadBody("change-of-identity.json");
    const result = parseTrustFrame(body, { receivedAt: RECEIVED_AT });
    expect(result.children[0]).toMatchObject({
      eventType: "change_of_identity",
      parseStatus: "parsed",
    });
  });

  it("parses a Change of Location message", async () => {
    const body = await loadBody("change-of-location.json");
    const result = parseTrustFrame(body, { receivedAt: RECEIVED_AT });
    expect(result.children[0]).toMatchObject({
      eventType: "change_of_location",
      parseStatus: "parsed",
    });
  });

  it("parses an Unidentified Train message", async () => {
    const body = await loadBody("unidentified.json");
    const result = parseTrustFrame(body, { receivedAt: RECEIVED_AT });
    expect(result.children[0]).toMatchObject({
      eventType: "unidentified",
      parseStatus: "parsed",
    });
  });

  it("retains a message with a missing body as malformed, never dropped", async () => {
    const body = await loadBody("malformed-missing-body.json");
    const result = parseTrustFrame(body, { receivedAt: RECEIVED_AT });
    expect(result.children).toHaveLength(1);
    expect(result.children[0]).toMatchObject({
      parseStatus: "malformed",
      parseErrorCode: "missing_or_invalid_body",
    });
  });

  it("retains an unrecognized msg_type as unsupported, never dropped", async () => {
    const body = await loadBody("unsupported-msg-type.json");
    const result = parseTrustFrame(body, { receivedAt: RECEIVED_AT });
    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.parseStatus).toBe("unsupported");
    expect(result.children[0]?.eventType).toBe("trust.unsupported_msg_type:0099");
  });

  it("a totally malformed body still yields exactly one synthetic malformed child, never zero", async () => {
    const result = parseTrustFrame(Buffer.from("not json at all"), { receivedAt: RECEIVED_AT });
    expect(result.children).toHaveLength(1);
    expect(result.children[0]?.parseStatus).toBe("malformed");
    expect(result.children[0]?.parseErrorCode).toBe("invalid_json");
  });

  it("transparently decompresses a gzip-compressed body", async () => {
    const body = await loadBody("gzip-normal.json.gz");
    const result = parseTrustFrame(body, { receivedAt: RECEIVED_AT });
    expect(result.children[0]).toMatchObject({ eventType: "activation", parseStatus: "parsed" });
  });
});
