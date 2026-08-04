import { createHash } from "node:crypto";

/** Deterministic given identical input JSON (same shape/key order); used for future
 * cross-frame duplicate-emission detection (docs/DATA_MODEL.md's "duplicate-redelivery"
 * parse_status — reserved but not yet populated, see packages/feed-parsers README notes). */
export function computeSemanticHash(rawEventJson: unknown): string {
  return createHash("sha256").update(JSON.stringify(rawEventJson)).digest("hex");
}
