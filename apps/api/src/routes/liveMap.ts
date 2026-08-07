import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  LIVE_PROTOCOL_VERSION,
  type SnapshotMessage,
  type HeartbeatMessage,
  type ResyncRequiredMessage,
  type LiveDeltaMessage,
} from "@railway/protocol";
import { currentVersionForSlug } from "../lib/mapVersion.js";
import { computeLiveState } from "../lib/liveState.js";
import type { LiveDeltaSource } from "../live/deltaSource.js";

export interface LiveMapRoutesDeps {
  pool: Pool;
  deltaSource: LiveDeltaSource;
  heartbeatIntervalMs: number;
  /** How often to check whether a newer map_version has opened for this slug while a socket
   * is connected. Reuses the delta poll cadence — no need for a separate, faster timer. */
  versionCheckIntervalMs: number;
}

/**
 * Milestone 6 (docs/API_CONTRACT.md §2): `GET /api/v1/maps/{slug}/live` — snapshot on connect,
 * then ordered deltas from `deps.deltaSource` for exactly the map_version resolved at connect
 * time. Public/unauthenticated, same as `/definition` and `/state` (no existing auth mechanism
 * on any public GET route to extend for this alone).
 */
export async function registerLiveMapRoutes(
  app: FastifyInstance,
  deps: LiveMapRoutesDeps,
): Promise<void> {
  const { pool, deltaSource, heartbeatIntervalMs, versionCheckIntervalMs } = deps;

  app.get<{ Params: { slug: string } }>(
    "/api/v1/maps/:slug/live",
    { websocket: true },
    async (socket, request) => {
      const slug = request.params.slug;
      const now = new Date();
      const version = await currentVersionForSlug(pool, slug, now);
      if (!version) {
        socket.close(1008, "no published map for this slug");
        return;
      }

      // Subscribe before computing the snapshot, not after: computeLiveState's query and
      // socket.send() both take real time, and a delta published during that window (e.g. the
      // berth.cleared that immediately follows the occupied state the snapshot just read) would
      // otherwise never reach this socket at all — subscribe() only registers the listener for
      // *future* deltas. That's exactly what leaves a berth showing occupied forever: the
      // client has no periodic resync (docs/API_CONTRACT.md §2 makes gap-healing the server's
      // job here), so a silently dropped berth.cleared is never corrected until something else
      // happens to touch that same berth. Buffer everything that arrives before the snapshot's
      // sourceSequence is known, then replay only what it doesn't already reflect.
      let lastSentSequence = 0;
      let buffering = true;
      const buffered: LiveDeltaMessage[] = [];

      const forward = (message: LiveDeltaMessage): void => {
        lastSentSequence = message.sequence;
        if (socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      };

      const unsubscribe = deltaSource.subscribe(version.id, version.slug, (message) => {
        if (buffering) {
          buffered.push(message);
          return;
        }
        forward(message);
      });

      const { sourceSequence, berths, signals, quality } = await computeLiveState(
        pool,
        version.compiled_runtime_bundle,
        now,
      );
      lastSentSequence = sourceSequence;

      const snapshot: SnapshotMessage = {
        type: "snapshot",
        protocolVersion: LIVE_PROTOCOL_VERSION,
        sequence: sourceSequence,
        state: { mode: "live", quality, berths, signals },
      };
      socket.send(JSON.stringify(snapshot));

      // Flip synchronously (no await between here and the loop) so no delta arriving from here
      // on is missed or reordered relative to the buffer drain.
      buffering = false;
      for (const message of buffered) {
        if (message.sequence > sourceSequence) {
          forward(message);
        }
      }
      buffered.length = 0;

      const heartbeatTimer = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return;
        const heartbeat: HeartbeatMessage = {
          type: "heartbeat",
          sequence: lastSentSequence,
          eventAt: new Date().toISOString(),
        };
        socket.send(JSON.stringify(heartbeat));
      }, heartbeatIntervalMs);

      // A map republish while this socket is connected means the compiled bundle (and thus
      // which elements/bindings exist) may have changed — tell the client to reconnect and
      // fetch a fresh snapshot rather than trying to reconcile in place.
      const versionCheckTimer = setInterval(() => {
        currentVersionForSlug(pool, slug, new Date())
          .then((latest) => {
            if (socket.readyState !== socket.OPEN) return;
            if (!latest || latest.id !== version.id) {
              const resync: ResyncRequiredMessage = {
                type: "resync.required",
                reason: "map_version_changed",
              };
              socket.send(JSON.stringify(resync));
              socket.close(1000, "map version changed");
            }
          })
          .catch((error: unknown) => {
            request.log.error({ error, slug }, "liveMap: version-change check failed");
          });
      }, versionCheckIntervalMs);

      const cleanup = (): void => {
        unsubscribe();
        clearInterval(heartbeatTimer);
        clearInterval(versionCheckTimer);
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
    },
  );
}
