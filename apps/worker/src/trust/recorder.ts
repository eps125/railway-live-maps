import { parseTrustFrame } from "@railway/feed-parsers";
import type { Pool } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  recordBrokerFrame,
  markFrameAcked as sharedMarkFrameAcked,
  type InboundBrokerFrame,
  type RecordBrokerFrameResult,
} from "../shared/recordBrokerFrame.js";

/** Milestone 8: thin TRUST wrapper over the shared archive-before-ack recorder — same shape as
 * `apps/worker/src/vstp/recorder.ts`, the third consumer of `recordBrokerFrame`. */
export type InboundTrustFrame = InboundBrokerFrame & { feedName: "TRUST" };

export interface RecordTrustFrameDeps {
  pool: Pool;
  archiveClient: S3Client;
  archiveBucket: string;
}

export type RecordTrustFrameResult = RecordBrokerFrameResult;

export async function recordTrustFrame(
  frame: InboundTrustFrame,
  deps: RecordTrustFrameDeps,
): Promise<RecordTrustFrameResult> {
  return recordBrokerFrame(frame, { ...deps, archiveNamespace: "trust", parseFn: parseTrustFrame });
}

export const markTrustFrameAcked = sharedMarkFrameAcked;
