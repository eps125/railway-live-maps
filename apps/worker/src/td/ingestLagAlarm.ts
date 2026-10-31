import type { Pool } from "pg";
import { TD_INGEST_LAG_LOSS_REASON, TD_INGEST_LAG_REASON } from "@railway/domain";

/** Lag (broker timestamp → frame stored) at which an outage opens: amber. */
export const INGEST_LAG_OPEN_MS = 60_000;
/** Lag at which it escalates to red: close to the broker's ~5-minute limit, past which Network
 * Rail discards messages before they are delivered (31 Oct 06:43–06:54, ~40% of frames lost). */
export const INGEST_LAG_LOSS_MS = 240_000;
/** Lag below which an open outage closes. */
export const INGEST_LAG_CLOSE_MS = 15_000;

export type LagAction =
  | { kind: "none" }
  | { kind: "open"; reason: string; startedAt: Date }
  | { kind: "escalate" }
  | { kind: "close" };

/**
 * Pure: what one stats window's worst lag means for the outage record. `open` is the current
 * open row's reason, if any. Lag is measured from the broker's own timestamp, not event times,
 * so a TD area with a wrong clock can't raise it.
 */
export function lagAction(maxLagMs: number | null, open: string | null, now: Date): LagAction {
  if (maxLagMs === null) return { kind: "none" };
  if (open === null) {
    if (maxLagMs < INGEST_LAG_OPEN_MS) return { kind: "none" };
    return {
      kind: "open",
      reason: maxLagMs >= INGEST_LAG_LOSS_MS ? TD_INGEST_LAG_LOSS_REASON : TD_INGEST_LAG_REASON,
      startedAt: new Date(now.getTime() - maxLagMs),
    };
  }
  if (maxLagMs < INGEST_LAG_CLOSE_MS) return { kind: "close" };
  if (open === TD_INGEST_LAG_REASON && maxLagMs >= INGEST_LAG_LOSS_MS) return { kind: "escalate" };
  return { kind: "none" };
}

/**
 * 2026-10-31: records `ingest-td` falling behind the broker as a `feed_gap` row the admin Data
 * outages page shows (the receive stream never pauses, so no silence is recorded). Fed the
 * worst lag of each stats window; one open row at a time, closed when the lag recovers. Rows
 * left open by a restart are closed when the next process starts.
 */
export class IngestLagAlarm {
  private openId: string | null = null;
  private openReason: string | null = null;
  private worstMs = 0;

  constructor(private readonly pool: Pool) {}

  async closeLeftOpen(now = new Date()): Promise<void> {
    await this.pool.query(
      `update feed_gap set detected_end = $1, affected_time_end = $1,
              operator_note = coalesce(operator_note || ' | ', '') || 'closed when ingest-td restarted'
        where feed_name = 'TD' and detection_reason = any($2::text[]) and detected_end is null`,
      [now, [TD_INGEST_LAG_REASON, TD_INGEST_LAG_LOSS_REASON]],
    );
  }

  async observe(maxLagMs: number | null, now = new Date()): Promise<void> {
    const action = lagAction(maxLagMs, this.openReason, now);
    if (maxLagMs !== null && maxLagMs > this.worstMs) this.worstMs = maxLagMs;
    const note = () =>
      `auto: ingest-td up to ${Math.round(this.worstMs / 1000)} s behind the broker`;
    if (action.kind === "open") {
      this.worstMs = maxLagMs ?? 0;
      const result = await this.pool.query<{ id: string }>(
        `insert into feed_gap (feed_name, td_area, detected_start, detection_reason, recoverability,
                               affected_time_start, operator_note)
         values ('TD', null, $1, $2, 'unknown', $1, $3) returning id::text as id`,
        [action.startedAt, action.reason, note()],
      );
      this.openId = result.rows[0]?.id ?? null;
      this.openReason = this.openId ? action.reason : null;
    } else if (action.kind === "escalate" && this.openId) {
      await this.pool.query(
        `update feed_gap set detection_reason = $2, operator_note = $3 where id = $1`,
        [this.openId, TD_INGEST_LAG_LOSS_REASON, note()],
      );
      this.openReason = TD_INGEST_LAG_LOSS_REASON;
    } else if (action.kind === "close" && this.openId) {
      await this.pool.query(
        `update feed_gap set detected_end = $2, affected_time_end = $2, operator_note = $3
          where id = $1`,
        [this.openId, now, note()],
      );
      this.openId = null;
      this.openReason = null;
      this.worstMs = 0;
    } else if (this.openId && maxLagMs !== null) {
      await this.pool.query(`update feed_gap set operator_note = $2 where id = $1`, [
        this.openId,
        note(),
      ]);
    }
  }
}
