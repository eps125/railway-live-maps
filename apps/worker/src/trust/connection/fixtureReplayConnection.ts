import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  TrustConnection,
  TrustConnectionOptions,
  TrustConnectionState,
  TrustFrameHandle,
} from "./trustConnection.js";

export interface FixtureReplayOptions {
  /** Absolute paths to fixture JSON (optionally gzipped) files, in order. May repeat an entry
   * to simulate redelivery. Same raw-wire-body convention as
   * `vstp/connection/fixtureReplayConnection.ts` — no separate headers/body wrapper. */
  fixturePaths: string[];
}

/** No credentials, no network — replays fixtures through the exact same recordTrustFrame
 * pipeline the live connection uses, mirroring `vstp/connection/fixtureReplayConnection.ts`. */
export class FixtureReplayTrustConnection implements TrustConnection {
  state: TrustConnectionState = "idle";

  constructor(private readonly options: FixtureReplayOptions) {}

  async start(connectionOptions: TrustConnectionOptions): Promise<void> {
    this.state = "connecting";
    const clientId = `fixture-replay-${randomUUID()}`;
    const connectedAt = new Date();
    const sessionId = await connectionOptions.onSessionStart({ clientId, connectedAt });
    this.state = "connected";

    try {
      for (const path of this.options.fixturePaths) {
        const body = await readFile(path);
        const handle: TrustFrameHandle = {
          frame: {
            feedName: "TRUST",
            topic: "/topic/TRAIN_MVT_ALL_TOC",
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
