import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { sha256Hex, sha256HexOfStream } from "./checksum.js";

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

describe("sha256HexOfStream", () => {
  it("matches sha256Hex's result for the same content read as a stream instead of a buffer", async () => {
    const content = "hello world";
    const streamed = await sha256HexOfStream(Readable.from(Buffer.from(content)));
    expect(streamed).toBe(sha256Hex(Buffer.from(content)));
  });

  it("matches across multiple small chunks, not just a single-chunk stream", async () => {
    // Readable.from on an array yields one chunk per element — proves the hash is actually
    // accumulated incrementally across chunks (hash.update per 'data' event), not just working
    // by accident for a stream that happens to deliver everything in one chunk.
    const chunks = ["hello ", "world", ", this ", "is ", "streamed"];
    const streamed = await sha256HexOfStream(Readable.from(chunks.map((c) => Buffer.from(c))));
    expect(streamed).toBe(sha256Hex(Buffer.from(chunks.join(""))));
  });

  it("differs for different content", async () => {
    const a = await sha256HexOfStream(Readable.from(Buffer.from("a")));
    const b = await sha256HexOfStream(Readable.from(Buffer.from("b")));
    expect(a).not.toBe(b);
  });
});
