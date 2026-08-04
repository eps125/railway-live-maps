import { randomUUID } from "node:crypto";
import { loadTdFixture } from "@railway/feed-parsers";
import type {
  TdConnection,
  TdConnectionOptions,
  TdConnectionState,
  TdFrameHandle,
} from "./tdConnection.js";

export interface FixtureReplayOptions {
  /** Absolute paths to fixture JSON files, in order. May repeat an entry to simulate redelivery. */
  fixturePaths: string[];
}

/** No credentials, no network — replays fixtures through the exact same recordFrame
 * pipeline the live connection uses (docs/IMPLEMENTATION_PLAN.md M3: "fixture replay
 * command that does not require live credentials"). */
export class FixtureReplayTdConnection implements TdConnection {
  state: TdConnectionState = "idle";

  constructor(private readonly options: FixtureReplayOptions) {}

  async start(connectionOptions: TdConnectionOptions): Promise<void> {
    this.state = "connecting";
    const clientId = `fixture-replay-${randomUUID()}`;
    const connectedAt = new Date();
    const sessionId = await connectionOptions.onSessionStart({ clientId, connectedAt });
    this.state = "connected";

    try {
      for (const path of this.options.fixturePaths) {
        const fixture = await loadTdFixture(path);
        const handle: TdFrameHandle = {
          frame: {
            feedName: "TD",
            topic: fixture.headers.destination ?? "/topic/TD_ALL_SIG_AREA",
            brokerMessageId: fixture.headers["message-id"],
            headers: fixture.headers,
            body: fixture.body,
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
