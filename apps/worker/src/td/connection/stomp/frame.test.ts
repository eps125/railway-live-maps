import { describe, expect, it } from "vitest";
import { encodeFrame, StompFrameDecoder } from "./frame.js";

describe("encodeFrame / StompFrameDecoder round trip", () => {
  it("round-trips a simple frame with no body", () => {
    const encoded = encodeFrame({
      command: "SUBSCRIBE",
      headers: { id: "0", destination: "/topic/x" },
      body: Buffer.alloc(0),
    });
    const decoder = new StompFrameDecoder();
    const [frame] = decoder.push(encoded);

    expect(frame?.command).toBe("SUBSCRIBE");
    expect(frame?.headers).toEqual({ id: "0", destination: "/topic/x" });
    expect(frame?.body.length).toBe(0);
  });

  it("round-trips a frame with a JSON body and content-length", () => {
    const body = Buffer.from('[{"CA_MSG":{"area_id":"ZZ"}}]', "utf8");
    const encoded = encodeFrame({
      command: "MESSAGE",
      headers: { "content-length": String(body.length), destination: "/topic/TD_ALL_SIG_AREA" },
      body,
    });
    const decoder = new StompFrameDecoder();
    const [frame] = decoder.push(encoded);

    expect(frame?.command).toBe("MESSAGE");
    expect(frame?.body.toString("utf8")).toBe(body.toString("utf8"));
  });

  it("unescapes header values (colon, backslash, newline, carriage return)", () => {
    const encoded = encodeFrame({
      command: "MESSAGE",
      headers: { message: "a:b\\c\nd\re" },
      body: Buffer.alloc(0),
    });
    const decoder = new StompFrameDecoder();
    const [frame] = decoder.push(encoded);

    expect(frame?.headers.message).toBe("a:b\\c\nd\re");
  });

  it("does not escape CONNECT/CONNECTED frame headers per spec", () => {
    const encoded = encodeFrame({
      command: "CONNECTED",
      headers: { version: "1.2", session: "abc" },
      body: Buffer.alloc(0),
    });
    expect(encoded.toString("utf8")).toContain("version:1.2");
  });

  it("handles a frame split across multiple push() calls (partial TCP chunks)", () => {
    const encoded = encodeFrame({
      command: "RECEIPT",
      headers: { "receipt-id": "1" },
      body: Buffer.alloc(0),
    });
    const decoder = new StompFrameDecoder();
    const mid = Math.floor(encoded.length / 2);

    const firstPass = decoder.push(encoded.subarray(0, mid));
    expect(firstPass).toEqual([]);

    const secondPass = decoder.push(encoded.subarray(mid));
    expect(secondPass).toHaveLength(1);
    expect(secondPass[0]?.command).toBe("RECEIPT");
  });

  it("handles multiple frames arriving in a single chunk", () => {
    const a = encodeFrame({
      command: "MESSAGE",
      headers: { "message-id": "1" },
      body: Buffer.from("a"),
    });
    const b = encodeFrame({
      command: "MESSAGE",
      headers: { "message-id": "2" },
      body: Buffer.from("b"),
    });
    const decoder = new StompFrameDecoder();

    const frames = decoder.push(Buffer.concat([a, b]));
    expect(frames).toHaveLength(2);
    expect(frames[0]?.headers["message-id"]).toBe("1");
    expect(frames[1]?.headers["message-id"]).toBe("2");
  });

  it("treats a lone newline as a heartbeat (empty command)", () => {
    const decoder = new StompFrameDecoder();
    const frames = decoder.push(Buffer.from("\n"));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.command).toBe("");
  });

  it("resyncs on a too-short content-length (bytes available, terminator missing) by searching for the next NUL", () => {
    // content-length claims 5 bytes ("short"), but the real frame body is "short-body" (10
    // bytes) — enough bytes exist to check position 5, but it's 'b' from "-body", not a NUL,
    // so the decoder falls back to scanning for the real terminator.
    const raw = Buffer.concat([
      Buffer.from("MESSAGE\ncontent-length:5\n\nshort-body", "utf8"),
      Buffer.from([0]),
    ]);
    const decoder = new StompFrameDecoder();
    const frames = decoder.push(raw);

    expect(frames).toHaveLength(1);
    expect(frames[0]?.body.toString("utf8")).toBe("short-body");
  });
});
