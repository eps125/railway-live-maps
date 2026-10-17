/**
 * ADR 0020: parses openrail-eps `tddb-detail.log` lines back into the exact NR TD wire shape.
 *
 * Verified against production on 2026-10-16 (23:55:00–23:55:39Z, where both systems had data):
 * - openrail logs every TD message, one line each. Per-class counts equal RLM's raw_feed_event
 *   exactly (CA 247, CB 30, CC 89, CT 145, SF 785).
 * - NR's `time` is whole seconds (ms always 000), and openrail's `(Timestamp …Z)` equals it.
 * - openrail lower-cases S-Class hex; NR sends upper case. Rebuilding upper case restores the
 *   wire form, and the verbatim line is kept in `recovery_source` so nothing is silently altered.
 *
 * Pure: no I/O. Lines that don't match a known shape are returned as rejects, never guessed.
 */

export type RecoveredTdType = "CA" | "CB" | "CC" | "CT" | "SF";

export interface RecoveredTdMessage {
  lineNumber: number;
  line: string;
  /** openrail's own write time for the line (when it captured the message). */
  loggedAt: Date;
  /** NR message time (whole seconds). */
  eventAt: Date;
  tdArea: string;
  type: RecoveredTdType;
  /** Exact NR wrapper shape, e.g. `{ CA_MSG: { time, area_id, msg_type, from, to, descr } }`. */
  rawEventJson: Record<string, Record<string, string>>;
}

export interface ParseReject {
  lineNumber: number;
  line: string;
  reason: string;
}

const LINE =
  /^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})Z \] \(Timestamp (\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})Z\) ([A-Z0-9]{2}) ([A-Z]{2}): (.*)$/;
const CA_BODY = /^(\S{4}) from (\S{4}) to (\S{4})\s*$/;
const CB_BODY = /^(\S{4}) from (\S{4})\s*$/;
const CC_BODY = /^(\S{4})\s+to (\S{4})\s*$/;
const CT_BODY = /^Heartbeat, report time (\d{4})\s*$/;
const SF_BODY = /^([0-9a-fA-F]{2}) = ([0-9a-fA-F]{2})(?:\s.*)?$/;

function utc(dd: string, mm: string, yy: string, h: string, m: string, s: string): Date {
  return new Date(
    Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(h), Number(m), Number(s)),
  );
}

export function parseOpenrailTddbLine(
  line: string,
  lineNumber: number,
): RecoveredTdMessage | ParseReject {
  const m = LINE.exec(line);
  if (!m) return { lineNumber, line, reason: "unrecognised_line" };
  const loggedAt = utc(m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!);
  const eventAt = utc(m[7]!, m[8]!, m[9]!, m[10]!, m[11]!, m[12]!);
  const tdArea = m[13]!;
  const kind = m[14]!;
  const body = m[15]!;
  const time = String(eventAt.getTime());
  const base = { lineNumber, line, loggedAt, eventAt, tdArea };

  switch (kind) {
    case "CA": {
      const b = CA_BODY.exec(body);
      if (!b) return { lineNumber, line, reason: "bad_ca_body" };
      return {
        ...base,
        type: "CA",
        rawEventJson: {
          CA_MSG: { time, area_id: tdArea, msg_type: "CA", from: b[2]!, to: b[3]!, descr: b[1]! },
        },
      };
    }
    case "CB": {
      const b = CB_BODY.exec(body);
      if (!b) return { lineNumber, line, reason: "bad_cb_body" };
      return {
        ...base,
        type: "CB",
        rawEventJson: {
          CB_MSG: { time, area_id: tdArea, msg_type: "CB", from: b[2]!, descr: b[1]! },
        },
      };
    }
    case "CC": {
      const b = CC_BODY.exec(body);
      if (!b) return { lineNumber, line, reason: "bad_cc_body" };
      return {
        ...base,
        type: "CC",
        rawEventJson: {
          CC_MSG: { time, area_id: tdArea, msg_type: "CC", to: b[2]!, descr: b[1]! },
        },
      };
    }
    case "CT": {
      const b = CT_BODY.exec(body);
      if (!b) return { lineNumber, line, reason: "bad_ct_body" };
      return {
        ...base,
        type: "CT",
        rawEventJson: { CT_MSG: { time, area_id: tdArea, msg_type: "CT", report_time: b[1]! } },
      };
    }
    case "SF": {
      const b = SF_BODY.exec(body);
      if (!b) return { lineNumber, line, reason: "bad_sf_body" };
      return {
        ...base,
        type: "SF",
        rawEventJson: {
          SF_MSG: {
            time,
            area_id: tdArea,
            msg_type: "SF",
            address: b[1]!.toUpperCase(),
            data: b[2]!.toUpperCase(),
          },
        },
      };
    }
    default:
      // SG/SH refreshes have never been observed in this log; reject rather than guess a shape.
      return { lineNumber, line, reason: `unsupported_type_${kind}` };
  }
}

export function isRecoveredMessage(
  value: RecoveredTdMessage | ParseReject,
): value is RecoveredTdMessage {
  return "type" in value;
}

/** Identity used to drop recovered messages RLM already holds (same NR content). */
export function nrIdentity(json: Record<string, Record<string, string>>): string {
  const [key, payload] = Object.entries(json)[0]!;
  const fields = Object.keys(payload)
    .sort()
    .map((k) => `${k}=${payload[k]}`)
    .join("|");
  return `${key}|${fields}`;
}
