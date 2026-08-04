import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { randomUUID } from "node:crypto";
import { encodeFrame, StompFrameDecoder } from "./frame.js";
import { computeBackoffDelayMs } from "../backoff.js";
import type {
  TdConnection,
  TdConnectionOptions,
  TdConnectionState,
  TdFrameHandle,
} from "../tdConnection.js";

export interface StompConnectionConfig {
  host: string;
  port: number;
  topic: string;
  username: string;
  password: string;
  heartbeatMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Real Network Rail STOMP connection. Only ever constructed when TD_LIVE_ENABLED=true (see
 * apps/worker/src/commands/ingestTd.ts) — untested against a live broker in this
 * environment; verify with `worker replay-fixtures` and the integration suite first, per
 * docs/IMPLEMENTATION_PLAN.md M3, before ever enabling this in a real deployment.
 */
export class StompTdConnection implements TdConnection {
  state: TdConnectionState = "idle";
  private socket: TLSSocket | null = null;
  private stopped = false;
  private attempt = 0;

  constructor(private readonly config: StompConnectionConfig) {}

  async start(options: TdConnectionOptions): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        await this.connectOnce(options);
        this.attempt = 0;
      } catch (error) {
        options.onError?.(error as Error);
      }
      if (this.stopped || (this.state as TdConnectionState) === "auth-failed") {
        return;
      }
      this.state = "reconnecting";
      const delay = computeBackoffDelayMs(this.attempt);
      this.attempt += 1;
      await sleep(delay);
    }
  }

  private connectOnce(options: TdConnectionOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      this.state = "connecting";
      const decoder = new StompFrameDecoder();
      const clientId = `railway-live-maps-${randomUUID()}`;
      const heartbeatMs = this.config.heartbeatMs ?? 15_000;
      let sessionId: string | null = null;
      let settled = false;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      const socket = tlsConnect({ host: this.config.host, port: this.config.port }, () => {
        socket.write(
          encodeFrame({
            command: "CONNECT",
            headers: {
              "accept-version": "1.2",
              host: this.config.host,
              login: this.config.username,
              passcode: this.config.password,
              "heart-beat": `${heartbeatMs},${heartbeatMs}`,
            },
            body: Buffer.alloc(0),
          }),
        );
      });
      this.socket = socket;

      socket.on("data", (chunk: Buffer) => {
        void this.handleChunk(decoder, chunk, socket, options, clientId, {
          getSessionId: () => sessionId,
          setSessionId: (id) => {
            sessionId = id;
          },
          onFatalError: finish,
        });
      });

      socket.on("error", (error) => finish(error));

      socket.on("close", () => {
        void (async () => {
          if (sessionId) {
            await options.onSessionEnd({
              sessionId,
              disconnectReason: "connection closed",
              at: new Date(),
            });
          }
          finish();
        })();
      });
    });
  }

  private async handleChunk(
    decoder: StompFrameDecoder,
    chunk: Buffer,
    socket: TLSSocket,
    options: TdConnectionOptions,
    clientId: string,
    session: {
      getSessionId: () => string | null;
      setSessionId: (id: string) => void;
      onFatalError: (error?: Error) => void;
    },
  ): Promise<void> {
    for (const frame of decoder.push(chunk)) {
      if (frame.command === "") continue; // heartbeat

      if (frame.command === "CONNECTED") {
        this.state = "connected";
        const sessionId = await options.onSessionStart({ clientId, connectedAt: new Date() });
        session.setSessionId(sessionId);
        socket.write(
          encodeFrame({
            command: "SUBSCRIBE",
            headers: { id: "0", destination: this.config.topic, ack: "client-individual" },
            body: Buffer.alloc(0),
          }),
        );
        continue;
      }

      if (frame.command === "ERROR") {
        const message = frame.headers.message ?? frame.body.toString("utf8");
        // Never retry permanent authentication errors indefinitely (docs/ARCHITECTURE.md §5).
        const isAuthError = /auth|login|credential/i.test(message);
        this.state = isAuthError ? "auth-failed" : "reconnecting";
        session.onFatalError(new Error(`STOMP ERROR: ${message}`));
        socket.destroy();
        return;
      }

      if (frame.command === "MESSAGE") {
        const messageId = frame.headers["message-id"] ?? "";
        const ackId = frame.headers.ack ?? messageId;
        const handle: TdFrameHandle = {
          frame: {
            feedName: "TD",
            topic: frame.headers.destination ?? this.config.topic,
            brokerMessageId: messageId,
            headers: frame.headers,
            body: frame.body,
            receivedAt: new Date(),
            connectionSessionId: session.getSessionId(),
          },
          ack: async () => {
            socket.write(
              encodeFrame({ command: "ACK", headers: { id: ackId }, body: Buffer.alloc(0) }),
            );
          },
          nack: async () => {
            socket.write(
              encodeFrame({ command: "NACK", headers: { id: ackId }, body: Buffer.alloc(0) }),
            );
          },
        };
        await options.onFrame(handle);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.state = "stopped";
    this.socket?.end();
  }
}
