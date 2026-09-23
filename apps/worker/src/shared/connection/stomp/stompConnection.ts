import { connect as netConnect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { FeedName } from "@railway/domain";
import { encodeFrame, StompFrameDecoder } from "./frame.js";
import { computeBackoffDelayMs } from "../backoff.js";
import type {
  BrokerConnection,
  BrokerConnectionOptions,
  BrokerConnectionState,
  BrokerFrameHandle,
} from "../brokerConnection.js";
import type { InboundBrokerFrame } from "../../recordBrokerFrame.js";

export interface StompConnectionConfig {
  feedName: FeedName;
  host: string;
  port: number;
  topic: string;
  username: string;
  password: string;
  heartbeatMs?: number;
  /** Bounds only the initial handshake (TCP/TLS connect through the broker's CONNECTED
   * response), not a healthy connection's subsequent lifetime. Without this, a connection
   * attempt that's silently dropped (e.g. a firewall blackholing the port rather than actively
   * refusing it) hangs the returned promise forever with nothing ever logged — indistinguishable
   * from a slow-but-working connection. Defaults to 20s. */
  connectTimeoutMs?: number;
  /** Once CONNECTED, if nothing at all arrives from the broker (not even a heartbeat LF) for
   * this long, the socket is force-closed so the reconnect loop takes over. Catches the
   * "silent stall" — the broker stops delivering but the TCP socket stays open, so neither
   * `error` nor `close` ever fires and the feed just goes dead with the container still "Up"
   * (observed twice, 2026-09-01). Defaults to `max(heartbeatMs * 3, 90s)`. */
  staleTimeoutMs?: number;
  /** Durable subscription identity. When set, CONNECT carries `client-id` and SUBSCRIBE names
   * the subscription, so the broker keeps queuing messages while we're disconnected (Network
   * Rail holds them for five minutes) and redelivers anything sent but not yet ACKed once we
   * reconnect. Both values must stay the same across reconnects and restarts, since together
   * they identify the subscription. Without this, every crash, restart or redeploy loses
   * whatever the broker sends while we're down. */
  durable?: { clientId: string; subscriptionName: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Milestone 7: generalized from `apps/worker/src/td/connection/stomp/stompConnection.ts`'s
 * `StompTdConnection` (same NR broker, different topic/`feedName` per feed) so VSTP/TRUST
 * reuse the exact same hand-rolled STOMP 1.2 client instead of each reimplementing connect/
 * reconnect/ack. `StompTdConnection` is now a thin wrapper fixing `feedName: "TD"`. Only ever
 * constructed when the relevant `*_LIVE_ENABLED` flag is true.
 *
 * Plain TCP, not TLS: despite port 61618 looking like it should be TLS-secured, Network Rail's
 * broker speaks plain STOMP on it — confirmed both by the official reference clients (e.g.
 * openraildata/td-trust-example-python3, which never calls stomp.py's `set_ssl`) and by hand:
 * a raw plaintext CONNECT frame gets a real STOMP ERROR response back immediately. Wrapping
 * this connection in TLS (the original implementation's bug) sends a TLS ClientHello to a
 * server that only understands plaintext STOMP frames — neither side ever gets a response it
 * understands, so the connection hangs forever rather than failing with a clear error.
 */
export class StompConnection implements BrokerConnection<InboundBrokerFrame> {
  state: BrokerConnectionState = "idle";
  private socket: Socket | null = null;
  private stopped = false;
  private attempt = 0;

  constructor(private readonly config: StompConnectionConfig) {}

  async start(options: BrokerConnectionOptions<InboundBrokerFrame>): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      try {
        await this.connectOnce(options);
        this.attempt = 0;
      } catch (error) {
        options.onError?.(error as Error);
      }
      if (this.stopped || (this.state as BrokerConnectionState) === "auth-failed") {
        return;
      }
      this.state = "reconnecting";
      const delay = computeBackoffDelayMs(this.attempt);
      this.attempt += 1;
      await sleep(delay);
    }
  }

  private connectOnce(options: BrokerConnectionOptions<InboundBrokerFrame>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.state = "connecting";
      const decoder = new StompFrameDecoder();
      const durable = this.config.durable;
      const clientId = durable?.clientId ?? `railway-live-maps-${randomUUID()}`;
      const heartbeatMs = this.config.heartbeatMs ?? 15_000;
      const connectTimeoutMs = this.config.connectTimeoutMs ?? 20_000;
      const staleTimeoutMs = this.config.staleTimeoutMs ?? Math.max(heartbeatMs * 3, 90_000);
      let sessionId: string | null = null;
      let settled = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      let watchdogTimer: ReturnType<typeof setInterval> | undefined;
      let lastInboundAt = Date.now();

      const stopTimers = (): void => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = undefined;
        }
        if (watchdogTimer) {
          clearInterval(watchdogTimer);
          watchdogTimer = undefined;
        }
      };

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        stopTimers();
        if (error) reject(error);
        else resolve();
      };

      const connectTimer = setTimeout(() => {
        finish(
          new Error(
            `STOMP connect to ${this.config.host}:${this.config.port} timed out after ` +
              `${connectTimeoutMs}ms — TCP connect or broker CONNECTED response never ` +
              "completed (commonly a firewall silently dropping the port rather than refusing it)",
          ),
        );
        socket.destroy();
      }, connectTimeoutMs);

      const socket = netConnect({ host: this.config.host, port: this.config.port }, () => {
        socket.write(
          encodeFrame({
            command: "CONNECT",
            headers: {
              "accept-version": "1.2",
              host: this.config.host,
              login: this.config.username,
              passcode: this.config.password,
              "heart-beat": `${heartbeatMs},${heartbeatMs}`,
              ...(durable ? { "client-id": durable.clientId } : {}),
            },
            body: Buffer.alloc(0),
          }),
        );
      });
      this.socket = socket;

      // Any rejection out of handleChunk (onSessionStart/onFrame throwing) must end in a
      // reconnect, never an unhandled rejection. Node kills the process on one of those,
      // which took ingest-td down 13 times on 2026-09-23 and lost each in-flight frame plus
      // everything the broker sent during the restart.
      const failFromHandler = (error: unknown): void => {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (settled) options.onError?.(failure);
        else finish(failure);
        if (!this.stopped) this.state = "reconnecting";
        socket.destroy();
      };

      socket.on("data", (chunk: Buffer) => {
        lastInboundAt = Date.now();
        this.handleChunk(decoder, chunk, socket, options, clientId, {
          getSessionId: () => sessionId,
          setSessionId: (id) => {
            sessionId = id;
          },
          onFatalError: finish,
          onConnected: () => {
            clearTimeout(connectTimer);
            lastInboundAt = Date.now();
            // Silent-stall watchdog: NR's broker promised bidirectional heartbeats in the
            // CONNECT frame, so *something* (a MESSAGE, an ACK receipt, or a bare LF) must
            // arrive well within `heartbeatMs`. If nothing does for `staleTimeoutMs`, the feed
            // is dead even though the socket is still open — tear it down so `start()`'s loop
            // reconnects instead of the process sitting on a corpse.
            watchdogTimer = setInterval(
              () => {
                const idleMs = Date.now() - lastInboundAt;
                if (idleMs > staleTimeoutMs && !socket.destroyed) {
                  console.error(
                    `${this.config.feedName} feed stalled: no inbound data for ${idleMs}ms ` +
                      `(> ${staleTimeoutMs}ms) — forcing reconnect`,
                  );
                  this.state = "reconnecting";
                  socket.destroy();
                }
              },
              Math.max(1000, Math.floor(staleTimeoutMs / 3)),
            );
            // STOMP 1.2 heartbeat: a lone LF on the wire. The CONNECT frame above promised
            // `heartbeatMs` via the heart-beat header, but nothing was actually sending one —
            // ACK frames happened to cover for it on busy feeds (TD), but a quiet one (VSTP,
            // TRUST overnight, TD itself outside busy areas) can go longer than the promised
            // interval between ACKs, and Network Rail's broker then concludes the client has
            // disappeared and closes the connection ("AMQ229014: Did not receive data ...
            // within the connection TTL"). Send somewhat faster than promised (80%) for
            // jitter/processing-delay margin.
            const sendIntervalMs = Math.max(1000, Math.floor(heartbeatMs * 0.8));
            heartbeatTimer = setInterval(() => {
              if (!socket.destroyed) socket.write(Buffer.from("\n"));
            }, sendIntervalMs);
          },
        }).catch(failFromHandler);
      });

      socket.on("error", (error) => finish(error));

      socket.on("close", () => {
        void (async () => {
          if (sessionId) {
            // Bookkeeping only. A failure here must neither crash the process nor stop
            // finish() from running, since finish() is what lets start() reconnect.
            try {
              await options.onSessionEnd({
                sessionId,
                disconnectReason: "connection closed",
                at: new Date(),
              });
            } catch (error) {
              options.onError?.(error instanceof Error ? error : new Error(String(error)));
            }
          }
          finish();
        })();
      });
    });
  }

  private async handleChunk(
    decoder: StompFrameDecoder,
    chunk: Buffer,
    socket: Socket,
    options: BrokerConnectionOptions<InboundBrokerFrame>,
    clientId: string,
    session: {
      getSessionId: () => string | null;
      setSessionId: (id: string) => void;
      onFatalError: (error?: Error) => void;
      onConnected: () => void;
    },
  ): Promise<void> {
    for (const frame of decoder.push(chunk)) {
      if (frame.command === "") continue; // heartbeat

      if (frame.command === "CONNECTED") {
        this.state = "connected";
        session.onConnected();
        const sessionId = await options.onSessionStart({ clientId, connectedAt: new Date() });
        session.setSessionId(sessionId);
        const durable = this.config.durable;
        socket.write(
          encodeFrame({
            command: "SUBSCRIBE",
            headers: {
              id: "0",
              destination: this.config.topic,
              ack: "client-individual",
              // Network Rail's broker is ActiveMQ Artemis (its errors are AMQ22xxxx). Artemis
              // reads `durable-subscription-name` first and still accepts the ActiveMQ Classic
              // `activemq.subscriptionName` that Network Rail's own examples use. Sending both
              // with the same value covers either reading.
              ...(durable
                ? {
                    "durable-subscription-name": durable.subscriptionName,
                    "activemq.subscriptionName": durable.subscriptionName,
                  }
                : {}),
            },
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
        const handle: BrokerFrameHandle<InboundBrokerFrame> = {
          frame: {
            feedName: this.config.feedName,
            topic: frame.headers.destination ?? this.config.topic,
            brokerMessageId: messageId,
            headers: frame.headers,
            body: frame.body,
            receivedAt: new Date(),
            connectionSessionId: session.getSessionId(),
          },
          // A frame whose storage was retried across a disconnect can finish after its socket is
          // gone. An ack id is only valid on the connection that delivered it, so skip the write.
          ack: async () => {
            if (socket.destroyed) return;
            socket.write(
              encodeFrame({ command: "ACK", headers: { id: ackId }, body: Buffer.alloc(0) }),
            );
          },
          nack: async () => {
            if (socket.destroyed) return;
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
    const socket = this.socket;
    if (socket && !socket.destroyed) {
      // A bare TCP close (this method's entire previous behavior) never tells the broker the
      // STOMP session itself is over — it just eventually notices the peer is gone, on its own
      // schedule. Observed in production: that schedule can be long enough that every
      // reconnect attempt in the meantime (even with a brand new client-id — NR's broker keys
      // the conflict off the login, not the client-id) gets rejected with "AMQ339009: Exception
      // getting session" until the stale session finally expires broker-side, sometimes many
      // minutes later. Sending a real STOMP DISCONNECT first — and giving the broker a brief
      // window to process it before the socket actually closes — makes the broker release the
      // session immediately instead. This matters most on every ordinary container
      // restart/redeploy (SIGTERM), which is the common case that reaches this method.
      socket.write(encodeFrame({ command: "DISCONNECT", headers: {}, body: Buffer.alloc(0) }));
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    socket?.end();
  }
}
