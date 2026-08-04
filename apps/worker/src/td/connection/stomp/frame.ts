/**
 * Minimal hand-rolled STOMP 1.2 frame encoder/decoder (LF line endings only — the NR feed
 * and most STOMP servers use LF; CRLF framing is not supported, a deliberate scope
 * trim since this code is gated off by TD_LIVE_ENABLED and untested against a live broker
 * in this environment). Chosen over an npm STOMP client (e.g. `stompit`) to avoid an
 * unmaintained dependency parsing untrusted network bytes — matches this project's existing
 * hand-rolled-over-ORM style (see packages/database's migration runner).
 */
export interface StompFrame {
  /** Empty string represents a heartbeat (a lone newline with no frame). */
  command: string;
  headers: Record<string, string>;
  body: Buffer;
}

const HEADER_ESCAPES: Array<[string, string]> = [
  ["\\", "\\\\"],
  ["\r", "\\r"],
  ["\n", "\\n"],
  [":", "\\c"],
];

function escapeHeaderValue(value: string): string {
  let result = value;
  for (const [raw, escaped] of HEADER_ESCAPES) {
    result = result.split(raw).join(escaped);
  }
  return result;
}

function unescapeHeaderValue(value: string): string {
  let result = "";
  for (let i = 0; i < value.length; i += 1) {
    const current = value.charAt(i);
    if (current === "\\" && i + 1 < value.length) {
      const next = value.charAt(i + 1);
      if (next === "\\") result += "\\";
      else if (next === "r") result += "\r";
      else if (next === "n") result += "\n";
      else if (next === "c") result += ":";
      else result += current + next;
      i += 1;
    } else {
      result += current;
    }
  }
  return result;
}

/** CONNECT/CONNECTED frames don't use header escaping per the STOMP 1.2 spec. */
function usesEscaping(command: string): boolean {
  return command !== "CONNECT" && command !== "CONNECTED";
}

export function encodeFrame(frame: StompFrame): Buffer {
  const escape = usesEscaping(frame.command);
  const headerLines = Object.entries(frame.headers).map(([key, value]) => {
    const encodedKey = escape ? escapeHeaderValue(key) : key;
    const encodedValue = escape ? escapeHeaderValue(value) : value;
    return `${encodedKey}:${encodedValue}`;
  });
  const head = `${frame.command}\n${headerLines.join("\n")}\n\n`;
  return Buffer.concat([Buffer.from(head, "utf8"), frame.body, Buffer.from([0])]);
}

function findHeaderBlockEnd(buffer: Buffer): number {
  const index = buffer.indexOf("\n\n");
  return index === -1 ? -1 : index + 2;
}

function splitHeaderLines(headerBlock: Buffer): string[] {
  // headerBlock includes the trailing blank line; slice it off before splitting.
  const text = headerBlock.subarray(0, headerBlock.length - 2).toString("utf8");
  return text.length === 0 ? [] : text.split("\n");
}

/** Stateful: buffers partial TCP chunks and yields every complete frame found so far. */
export class StompFrameDecoder {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): StompFrame[] {
    this.pending =
      this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    const frames: StompFrame[] = [];

    for (;;) {
      if (this.pending.length === 0) break;

      if (this.pending[0] === 0x0a) {
        frames.push({ command: "", headers: {}, body: Buffer.alloc(0) });
        this.pending = this.pending.subarray(1);
        continue;
      }

      const headerEnd = findHeaderBlockEnd(this.pending);
      if (headerEnd === -1) break; // wait for more data

      const lines = splitHeaderLines(this.pending.subarray(0, headerEnd));
      const command = lines[0] ?? "";
      const escape = usesEscaping(command);
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        if (line.length === 0) continue;
        const separatorIndex = line.indexOf(":");
        if (separatorIndex === -1) continue;
        const rawKey = line.slice(0, separatorIndex);
        const rawValue = line.slice(separatorIndex + 1);
        const key = escape ? unescapeHeaderValue(rawKey) : rawKey;
        // First occurrence of a repeated header wins (STOMP 1.2 spec).
        if (!(key in headers)) {
          headers[key] = escape ? unescapeHeaderValue(rawValue) : rawValue;
        }
      }

      const contentLengthHeader = headers["content-length"];
      let bodyEnd: number;
      if (contentLengthHeader !== undefined && /^\d+$/.test(contentLengthHeader)) {
        bodyEnd = headerEnd + Number(contentLengthHeader);
        if (this.pending.length < bodyEnd + 1) break; // wait for more data
        if (this.pending[bodyEnd] !== 0x00) {
          // content-length lied; resync by searching for the next NUL instead.
          const found = this.pending.indexOf(0x00, headerEnd);
          if (found === -1) break;
          bodyEnd = found;
        }
      } else {
        const found = this.pending.indexOf(0x00, headerEnd);
        if (found === -1) break; // wait for more data
        bodyEnd = found;
      }

      const body = Buffer.from(this.pending.subarray(headerEnd, bodyEnd));
      frames.push({ command, headers, body });
      this.pending = this.pending.subarray(bodyEnd + 1);
    }

    return frames;
  }
}
