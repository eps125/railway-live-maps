import { formatSAddress } from "./sClass.js";

/**
 * Milestone 36c (docs/adr/0013 decision 6): parsing published S-Class definition tables.
 *
 * Two real layouts exist (Open Rail Data wiki, 2026-09-19):
 * - `ADDR:BIT <tab> Function <tab> Destination` — e.g. R3 (`03:0  S3471`), address in hex.
 * - `BYTE <tab> BIT <tab> Function <tab> Destination` — e.g. M8 (`25  1  S3037`), byte in decimal.
 *
 * The byte radix is **never guessed**: the caller states it (`hex` | `decimal`). A token that isn't
 * valid in that radix is an error row, not silently reinterpreted — importing the M8 table as hex
 * would otherwise quietly bind every signal to the wrong byte.
 *
 * Rows whose function is blank or `?` carry no identification and are skipped (counted, not
 * imported). Nothing here is repaired: duplicates and conflicts are reported for the owner to
 * resolve (the R3 table lists S3533 twice).
 */

export type SClassDefinitionKind =
  "signal" | "route" | "points" | "track" | "trts" | "level_crossing" | "unknown";

export const S_CLASS_DEFINITION_KINDS: readonly SClassDefinitionKind[] = [
  "signal",
  "route",
  "points",
  "track",
  "trts",
  "level_crossing",
  "unknown",
];

export type SClassByteRadix = "hex" | "decimal";

export interface ParsedSClassDefinition {
  /** 1-based line number in the pasted text. */
  line: number;
  /** Canonical two-digit uppercase hex. */
  address: string;
  bit: number;
  kind: SClassDefinitionKind;
  label: string;
  destination: string | null;
}

export interface SClassImportIssue {
  line: number;
  code:
    | "invalid_address"
    | "invalid_bit"
    | "duplicate_bit" // the same address:bit defined twice in this import
    | "duplicate_label"; // the same label (+ destination) on more than one bit
  message: string;
}

export interface SClassImportParseResult {
  definitions: ParsedSClassDefinition[];
  /** Rows with no identification (`?` or blank function). */
  skippedUnidentified: number;
  /** Header/blank/unrecognised lines. */
  ignoredLines: number;
  errors: SClassImportIssue[];
  warnings: SClassImportIssue[];
}

/** Best-effort kind from a label: `S1234` → signal, `R1234` → route; anything else is
 * `unknown` (editable afterwards) rather than a guess. */
export function inferSClassKind(label: string): SClassDefinitionKind {
  if (/^S\d/i.test(label)) return "signal";
  if (/^R\d/i.test(label)) return "route";
  return "unknown";
}

function parseByte(token: string, radix: SClassByteRadix): number | null {
  const pattern = radix === "hex" ? /^[0-9A-Fa-f]{1,2}$/ : /^\d{1,3}$/;
  if (!pattern.test(token)) return null;
  const value = Number.parseInt(token, radix === "hex" ? 16 : 10);
  return value >= 0 && value <= 0xff ? value : null;
}

function splitColumns(line: string): string[] {
  // Tabs (a table pasted from a browser) or runs of 2+ spaces; single spaces can appear inside a
  // destination ("South Yard (IL1049)", "Berth ULLS").
  return line
    .split(/\t| {2,}/)
    .map((c) => c.trim())
    .filter((c, i, all) => c.length > 0 || i < all.length - 1);
}

export function parseSClassDefinitionTable(
  text: string,
  radix: SClassByteRadix,
): SClassImportParseResult {
  const result: SClassImportParseResult = {
    definitions: [],
    skippedUnidentified: 0,
    ignoredLines: 0,
    errors: [],
    warnings: [],
  };

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const columns = splitColumns(raw.trim());
    if (columns.length === 0 || columns[0] === "") {
      result.ignoredLines += 1;
      return;
    }

    let byteToken: string;
    let bitToken: string;
    let rest: string[];
    const combined = /^([0-9A-Za-z]{1,3}):(\S+)$/.exec(columns[0]!);
    if (combined) {
      byteToken = combined[1]!;
      bitToken = combined[2]!;
      rest = columns.slice(1);
    } else if (columns.length >= 2 && /^\w{1,3}$/.test(columns[0]!) && /^\d+$/.test(columns[1]!)) {
      byteToken = columns[0]!;
      bitToken = columns[1]!;
      rest = columns.slice(2);
    } else {
      // A header ("Byte Bit Function ...", "Address Function ...") or prose.
      result.ignoredLines += 1;
      return;
    }

    const byte = parseByte(byteToken, radix);
    if (byte === null) {
      result.errors.push({
        line,
        code: "invalid_address",
        message: `"${byteToken}" is not a ${radix} byte number (0-${radix === "hex" ? "FF" : "255"})`,
      });
      return;
    }
    const bit = /^[0-7]$/.test(bitToken) ? Number(bitToken) : null;
    if (bit === null) {
      result.errors.push({ line, code: "invalid_bit", message: `"${bitToken}" is not a bit 0-7` });
      return;
    }

    const label = (rest[0] ?? "").trim();
    if (label === "" || label === "?") {
      result.skippedUnidentified += 1;
      return;
    }
    const destination = (rest[1] ?? "").trim();
    result.definitions.push({
      line,
      address: formatSAddress(byte),
      bit,
      kind: inferSClassKind(label),
      label,
      destination: destination === "" ? null : destination,
    });
  });

  const byBit = new Map<string, ParsedSClassDefinition>();
  const byLabel = new Map<string, ParsedSClassDefinition>();
  for (const definition of result.definitions) {
    const bitKey = `${definition.address}:${definition.bit}`;
    const first = byBit.get(bitKey);
    if (first) {
      result.errors.push({
        line: definition.line,
        code: "duplicate_bit",
        message: `${bitKey} is already defined on line ${first.line} (${first.label})`,
      });
    } else {
      byBit.set(bitKey, definition);
    }
    const labelKey = `${definition.label}|${definition.destination ?? ""}`;
    const sameLabel = byLabel.get(labelKey);
    if (sameLabel) {
      result.warnings.push({
        line: definition.line,
        code: "duplicate_label",
        message: `${definition.label}${definition.destination ? ` → ${definition.destination}` : ""} is also on ${sameLabel.address}:${sameLabel.bit} (line ${sameLabel.line}) — one of them is probably wrong`,
      });
    } else {
      byLabel.set(labelKey, definition);
    }
  }
  return result;
}
