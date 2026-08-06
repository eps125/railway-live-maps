import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  VstpConnection,
  VstpConnectionOptions,
  VstpConnectionState,
  VstpFrameHandle,
} from "./vstpConnection.js";

export interface FixtureReplayOptions {
  /** Absolute paths to fixture XML (optionally gzipped) files, in order. May repeat an entry to
   * simulate redelivery. Unlike TD's fixtures, VSTP fixtures are raw wire bodies with no
   * separate headers/body wrapper — `parseVstpFrame` detects gzip itself. */
  fixturePaths: string[];
}

/** No credentials, no network — replays fixtures through the exact same recordVstpFrame
 * pipeline the live connection uses, mirroring `td/connection/fixtureReplayConnection.ts`. */
export class FixtureReplayVstpConnection implements VstpConnection {
  state: VstpConnectionState = "idle";

  constructor(private readonly options: FixtureReplayOptions) {}

  async start(connectionOptions: VstpConnectionOptions): Promise<void> {
    this.state = "connecting";
    const clientId = `fixture-replay-${randomUUID()}`;
    const connectedAt = new Date();
    const sessionId = await connectionOptions.onSessionStart({ clientId, connectedAt });
    this.state = "connected";

    try {
      for (const path of this.options.fixturePaths) {
        const body = await readFile(path);
        const handle: VstpFrameHandle = {
          frame: {
            feedName: "VSTP",
            topic: "/topic/VSTP_ALL",
            brokerMessageId: undefined,
            headers: {},
            body,
            receivedAt: new Date(),
            connectionSessionId: sessionId,
          },
          ack: async () => {},
          nack: async () => {},
        };
        await connectionOptions.onFrame(handle);
      }
    } finally {
      this.state = "stopped";
      await connectionOptions.onSessionEnd({
        sessionId,
        disconnectReason: "fixture replay complete",
        at: new Date(),
      });
    }
  }

  async stop(): Promise<void> {
    this.state = "stopped";
  }
}
