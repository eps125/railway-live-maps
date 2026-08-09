// v2: VSTP's wire format was discovered to be JSON, not XML — v1 assumed an XML shape built
// from public documentation alone, never verified against a real captured message. Every real
// message failed XML validation and was silently retained as "malformed" instead of ever being
// projected into a schedule. See parseVstpFrame.ts's doc comment for the real shape.
export const VSTP_PARSER_VERSION = 2;
