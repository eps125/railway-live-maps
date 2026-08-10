import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface DownloadToTempFileOptions {
  url: string;
  username: string;
  password: string;
}

const GZIP_MAGIC_BYTES = Buffer.from([0x1f, 0x8b]);

/** Peeks the first chunk of `source` to sniff the real gzip magic bytes (`1f 8b`), then returns
 * a stream that replays that chunk followed by the rest — so the peek doesn't lose any bytes. */
async function sniffGzip(source: Readable): Promise<{ isGzip: boolean; stream: Readable }> {
  const iterator = source[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) {
    return { isGzip: false, stream: Readable.from([]) };
  }
  const firstChunk: Buffer = Buffer.isBuffer(first.value)
    ? first.value
    : Buffer.from(first.value as string);
  const isGzip =
    firstChunk.length >= 2 && firstChunk.subarray(0, 2).equals(GZIP_MAGIC_BYTES);

  async function* replay(): AsyncGenerator<Buffer> {
    yield firstChunk;
    for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    }
  }

  return { isGzip, stream: Readable.from(replay()) };
}

/**
 * Downloads a Network Rail file endpoint (SCHEDULE/CORPUS/SMART all use HTTP Basic Auth over
 * the same publicdatafeeds.networkrail.co.uk host per docs/REFERENCES.md) to a temp file,
 * transparently gunzipping if the response is gzip-compressed.
 *
 * Confirmed against a real SMART download (2026-08-10): NR serves the file as literal gzip
 * bytes (magic `1f 8b`) with no `.gz` URL suffix and no `Content-Encoding: gzip` response
 * header — the two signals this function originally relied on to decide whether to gunzip.
 * Both would have missed a real download entirely, leaving `parseSmartFileStream` to
 * `JSON.parse` raw gzip bytes and fail immediately. Sniffing the actual leading bytes is the
 * only signal that reflects what NR actually sends, regardless of what any particular endpoint
 * claims — same fix class as the VSTP XML/JSON and TRUST signallingId issues.
 */
export async function downloadToTempFile(options: DownloadToTempFileOptions): Promise<string> {
  const response = await fetch(options.url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`,
    },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download of ${options.url} failed: HTTP ${response.status}`);
  }

  const dir = await mkdtemp(join(tmpdir(), "railway-download-"));
  const destPath = join(dir, "download.jsonl");
  const rawSource = Readable.fromWeb(
    response.body as unknown as import("node:stream/web").ReadableStream,
  );
  const { isGzip, stream: source } = await sniffGzip(rawSource);

  try {
    if (isGzip) {
      await pipeline(source, createGunzip(), createWriteStream(destPath));
    } else {
      await pipeline(source, createWriteStream(destPath));
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  return destPath;
}
