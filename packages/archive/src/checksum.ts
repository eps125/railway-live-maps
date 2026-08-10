import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

export function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Streaming equivalent of sha256Hex, for files too large to buffer whole in memory —
 * confirmed necessary 2026-08-10: a real CIF SCHEDULE full extract was 3.29GB, well past
 * Node's fs.readFile hard 2 GiB ceiling (ERR_FS_FILE_TOO_LARGE) regardless of available RAM. */
export function sha256HexOfStream(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
