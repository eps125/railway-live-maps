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

/**
 * Downloads a Network Rail file endpoint (SCHEDULE/CORPUS/SMART all use HTTP Basic Auth over
 * the same publicdatafeeds.networkrail.co.uk host per docs/REFERENCES.md) to a temp file,
 * transparently gunzipping if the response is gzip-compressed. Only ever called when the
 * relevant `*_DOWNLOAD_ENABLED` flag is true — untested against the live endpoint in this
 * environment; the corresponding `import-*` command (file-path based) is what fixture/
 * integration tests exercise instead.
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
  const isGzip = options.url.endsWith(".gz") || response.headers.get("content-encoding") === "gzip";
  const source = Readable.fromWeb(
    response.body as unknown as import("node:stream/web").ReadableStream,
  );

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
