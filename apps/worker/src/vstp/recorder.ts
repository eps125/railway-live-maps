import { parseVstpFrame } from "@railway/feed-parsers";
import type { Pool } from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  recordBrokerFrame,
  markFrameAcked as sharedMarkFrameAcked,
  type InboundBrokerFrame,
  type RecordBrokerFrameResult,
} from "../shared/recordBrokerFrame.js";

/** Milestone 7: thin VSTP wrapper over the shared archive-before-ack recorder — same shape as
 * `apps/worker/src/td/recorder.ts`, the third consumer after TD/(the M6 map-delta layer). */
export type InboundVstpFrame = InboundBrokerFrame & { feedName: "VSTP" };

export interface RecordVstpFrameDeps {
  pool: Pool;
  archiveClient: S3Client;
  archiveBucket: string;
}

export type RecordVstpFrameResult = RecordBrokerFrameResult;

export async function recordVstpFrame(
  frame: InboundVstpFrame,
  deps: RecordVstpFrameDeps,
): Promise<RecordVstpFrameResult> {
  return recordBrokerFrame(frame, { ...deps, archiveNamespace: "vstp", parseFn: parseVstpFrame });
}

export const markVstpFrameAcked = sharedMarkFrameAcked;
