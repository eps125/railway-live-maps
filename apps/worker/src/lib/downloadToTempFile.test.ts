import { gzipSync } from "node:zlib";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadToTempFile } from "./downloadToTempFile.js";

function fakeResponse(body: Buffer, headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(body));
        controller.close();
      },
    }),
  } as unknown as Response;
}

describe("downloadToTempFile", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const dir of createdDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gunzips a real gzip body even when the URL has no .gz suffix and there's no Content-Encoding header — the exact shape NR's SMART endpoint actually sends", async () => {
    const plain = Buffer.from('{"BERTHDATA":[]}');
    const gzipped = gzipSync(plain);
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(gzipped));
    vi.stubGlobal("fetch", fetchMock);

    const path = await downloadToTempFile({
      url: "https://publicdatafeeds.networkrail.co.uk/ntrod/SupportingFileAuthenticate?type=SMART",
      username: "u",
      password: "p",
    });
    createdDirs.push(dirname(path));

    const contents = await readFile(path);
    expect(contents.toString("utf8")).toBe(plain.toString("utf8"));
  });

  it("leaves a plain (non-gzip) body untouched", async () => {
    const plain = Buffer.from('{"BERTHDATA":[]}');
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(plain));
    vi.stubGlobal("fetch", fetchMock);

    const path = await downloadToTempFile({
      url: "https://publicdatafeeds.networkrail.co.uk/ntrod/SupportingFileAuthenticate?type=CORPUS",
      username: "u",
      password: "p",
    });
    createdDirs.push(dirname(path));

    const contents = await readFile(path);
    expect(contents.toString("utf8")).toBe(plain.toString("utf8"));
  });

  it("throws when the response is not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, body: null });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      downloadToTempFile({ url: "https://example.invalid", username: "u", password: "p" }),
    ).rejects.toThrow("HTTP 401");
  });
});
