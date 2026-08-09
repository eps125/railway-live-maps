// v2: VSTP's wire format was discovered to be JSON, not XML — v1 assumed an XML shape built
// from public documentation alone, never verified against a real captured message.
// v3: recognizes the real (undocumented) "Update" transaction type as a fourth valid value
// alongside Create/Overwrite/Delete, and extracts the real message-level `timestamp` field
// (epoch milliseconds, sibling of `schedule`) instead of always falling back to receivedAt.
// Both confirmed from real captured messages seen after v2 went live.
export const VSTP_PARSER_VERSION = 3;
