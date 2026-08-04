import { describe, expect, it } from "vitest";
import { sha256Hex } from "./checksum.js";

describe("sha256Hex", () => {
  it("matches a known vector", () => {
    expect(sha256Hex(Buffer.from("hello world"))).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });

  it("is deterministic for identical input", () => {
    const buf = Buffer.from("same bytes");
    expect(sha256Hex(buf)).toBe(sha256Hex(Buffer.from(buf)));
  });

  it("differs for different input", () => {
    expect(sha256Hex(Buffer.from("a"))).not.toBe(sha256Hex(Buffer.from("b")));
  });
});
