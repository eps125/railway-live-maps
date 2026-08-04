import { describe, expect, it } from "vitest";
import { computeArchiveObjectKey } from "./objectKey.js";

describe("computeArchiveObjectKey", () => {
  it("builds a deterministic, content-addressed key", () => {
    const key = computeArchiveObjectKey({
      namespace: "td",
      contentSha256: "abc123",
      date: new Date("2026-08-04T13:55:00Z"),
    });

    expect(key).toBe("raw/td/2026/08/04/abc123.bin");
  });

  it("pads single-digit month and day", () => {
    const key = computeArchiveObjectKey({
      namespace: "td",
      contentSha256: "x",
      date: new Date("2026-01-05T00:00:00Z"),
    });

    expect(key).toBe("raw/td/2026/01/05/x.bin");
  });
});
