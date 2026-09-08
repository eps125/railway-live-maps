import { describe, expect, it } from "vitest";
import { readApiJson } from "./apiJson.js";

function res(body: string, status = 200): Response {
  return { status, text: async () => body } as unknown as Response;
}

describe("readApiJson", () => {
  it("parses a JSON body", async () => {
    await expect(readApiJson(res('{"versionNumber":3}'))).resolves.toEqual({ versionNumber: 3 });
  });

  it("returns {} for an empty body", async () => {
    await expect(readApiJson(res(""))).resolves.toEqual({});
  });

  it("throws a diagnostic error when the body is HTML (request fell through to the SPA)", async () => {
    await expect(readApiJson(res("<html> <head></head> ...", 404))).rejects.toThrow(
      /non-JSON response \(HTTP 404\).*EDITOR_ENABLED/s,
    );
  });
});
