/**
 * Runs one step of each frame's handling in the order the frames arrived, while everything else
 * about them runs concurrently (2026-10-31).
 *
 * Frames are stored concurrently: the archive upload is slow, and storing one frame at a time
 * (c1d46b0, 30 Oct) let ingest fall behind the TD rate when storage slowed, until Network Rail's
 * broker discarded messages more than five minutes old (31 Oct 06:43–06:54, ~40% of frames lost).
 * But the step that assigns ingestion sequences must follow arrival order: the projectors apply
 * steps in sequence order, and a train's step into a berth sequenced after its step out of it
 * leaves the berth showing it (WA B016 1S95, 30 Oct). So only that step goes through here.
 *
 * Each frame takes a ticket the moment it is decoded (synchronously, so tickets follow arrival)
 * and calls `release` exactly once when it is finished with, whether or not it ran its ordered
 * step. A frame waits at most `maxWaitMs` for the frames before it: ordering is never allowed to
 * put retention at risk, so a stuck predecessor delays the rest by seconds, not minutes.
 */
export class ArrivalOrder {
  private issued = 0;
  /** The oldest ticket not yet released: every ticket below it is done. */
  private next = 0;
  private readonly released = new Set<number>();
  private readonly waiters = new Map<number, () => void>();
  /** Ordered steps that went ahead without waiting their turn (the predecessor took too long). */
  timedOut = 0;
  /** Total time spent waiting for a turn, for the stats log. */
  waitedMs = 0;

  constructor(private readonly maxWaitMs = 5_000) {}

  ticket(): number {
    return this.issued++;
  }

  /** Runs `fn` once every earlier ticket is released (or `maxWaitMs` has passed), then releases
   * this ticket. A ticket already released (a retry after its first attempt) runs straight away. */
  async run<T>(ticket: number, fn: () => Promise<T>): Promise<T> {
    if (ticket > this.next && !this.released.has(ticket)) {
      const started = Date.now();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(ticket);
          this.timedOut += 1;
          this.skipTo(ticket);
          resolve();
        }, this.maxWaitMs);
        timer.unref?.();
        this.waiters.set(ticket, () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.waitedMs += Date.now() - started;
    }
    try {
      return await fn();
    } finally {
      this.release(ticket);
    }
  }

  /** Gives up on every ticket before `ticket` (one of them is stuck), so only the first frame
   * behind a stuck one pays the wait, not every frame after it. Their late releases are ignored. */
  private skipTo(ticket: number): void {
    if (ticket <= this.next) return;
    for (const done of this.released) if (done < ticket) this.released.delete(done);
    this.next = ticket;
    for (const [waiting, wake] of this.waiters) {
      if (waiting < ticket) {
        this.waiters.delete(waiting);
        wake();
      }
    }
  }

  /** Marks a ticket done. Safe to call more than once. */
  release(ticket: number): void {
    if (ticket < this.next || this.released.has(ticket)) return;
    this.released.add(ticket);
    while (this.released.has(this.next)) {
      this.released.delete(this.next);
      this.next += 1;
    }
    const waiter = this.waiters.get(this.next);
    if (waiter) {
      this.waiters.delete(this.next);
      waiter();
    }
  }
}
