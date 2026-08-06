import { parseTdFrame } from "@railway/feed-parsers";
import type { Pool } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  recordBrokerFrame,
  markFrameAcked as sharedMarkFrameAcked,
  type InboundBrokerFrame,
  type RecordBrokerFrameResult,
} from "../shared/recordBrokerFrame.js";

/**
 * Milestone 7: the archive-before-ack recording sequence moved to
 * `apps/worker/src/shared/recordBrokerFrame.ts` (VSTP/TRUST reuse it too). This module is now
 * a thin TD-specific wrapper — same exports, same behavior, so every existing caller
 * (`recorder.integration.test.ts`, `projector.integration.test.ts`,
 * `fixtureReplayConnection.ts`, `commands/ingestTd.ts`) is unaffected.
 */
export type InboundFrame = InboundBrokerFrame & { feedName: "TD" };

export interface RecordFrameDeps {
  pool: Pool;
  archiveClient: S3Client;
  archiveBucket: string;
}

export type RecordFrameResult = RecordBrokerFrameResult;

export async function recordFrame(
  frame: InboundFrame,
  deps: RecordFrameDeps,
): Promise<RecordFrameResult> {
  return recordBrokerFrame(frame, { ...deps, archiveNamespace: "td", parseFn: parseTdFrame });
}

export const markFrameAcked = sharedMarkFrameAcked;
