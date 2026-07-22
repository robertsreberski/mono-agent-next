export interface QueueJob {
  readonly key: string;
  readonly bytes: number;
}

export interface BackgroundQueueSnapshot {
  readonly capacity: { readonly items: number; readonly bytes: number; readonly batchSize: number };
  readonly queued: number;
  readonly queuedBytes: number;
  readonly inFlight: number;
  readonly inFlightBytes: number;
  readonly highWaterItems: number;
  readonly highWaterBytes: number;
  readonly enqueued: number;
  readonly completed: number;
  readonly failed: number;
  readonly dropped: number;
  readonly discarded: number;
  readonly coalesced: number;
  readonly draining: boolean;
  readonly accepting: boolean;
}

/** A bounded, coalescing batch queue for best-effort memory work. */
export class BoundedBatchQueue<T extends QueueJob> {
  private readonly jobs: T[] = [];
  private readonly activeKeys = new Set<string>();
  private queuedBytes = 0;
  private inFlight = 0;
  private inFlightBytes = 0;
  private highWaterItems = 0;
  private highWaterBytes = 0;
  private enqueued = 0;
  private completed = 0;
  private failed = 0;
  private dropped = 0;
  private discarded = 0;
  private coalesced = 0;
  private scheduled = false;
  private draining = false;
  private accepting = true;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly options: {
    readonly maxItems: number;
    readonly maxBytes: number;
    readonly batchSize: number;
    readonly process: (jobs: readonly T[]) => Promise<void>;
    /** Stop the current drain after one failed batch and discard queued jobs. */
    readonly discardQueuedOnError?: boolean;
    readonly onBatchSettled?: () => void;
    readonly onError?: (error: unknown) => void;
    readonly onChange?: () => void;
  }) {}

  enqueue(job: T): "enqueued" | "coalesced" | "dropped" {
    if (!this.accepting) {
      this.dropped += 1;
      this.emitChange();
      return "dropped";
    }
    if (this.activeKeys.has(job.key)) {
      this.coalesced += 1;
      this.emitChange();
      return "coalesced";
    }
    if (
      this.jobs.length + this.inFlight >= this.options.maxItems
      || this.queuedBytes + this.inFlightBytes + job.bytes > this.options.maxBytes
    ) {
      this.dropped += 1;
      this.emitChange();
      return "dropped";
    }
    this.jobs.push(job);
    this.activeKeys.add(job.key);
    this.queuedBytes += job.bytes;
    this.enqueued += 1;
    this.highWaterItems = Math.max(this.highWaterItems, this.jobs.length + this.inFlight);
    this.highWaterBytes = Math.max(this.highWaterBytes, this.queuedBytes + this.inFlightBytes);
    this.scheduleDrain();
    this.emitChange();
    return "enqueued";
  }

  /** Stop admission while allowing already-accepted work to drain. */
  stopAccepting(): void {
    this.accepting = false;
    this.emitChange();
  }

  /** Discard queued (not in-flight) best-effort work. */
  discardQueued(): number {
    const discarded = this.jobs.length;
    for (const job of this.jobs) this.activeKeys.delete(job.key);
    this.jobs.splice(0);
    this.queuedBytes = 0;
    this.discarded += discarded;
    this.dropped += discarded;
    if (!this.draining && this.inFlight === 0) this.resolveWaiters();
    this.emitChange();
    return discarded;
  }

  /** Stop admission and discard queued (not in-flight) best-effort work. */
  stopAndDiscard(): number {
    this.stopAccepting();
    return this.discardQueued();
  }

  /** True when a key is queued or currently being processed. Does not mutate telemetry. */
  hasKey(key: string): boolean {
    return this.activeKeys.has(key);
  }

  /** Stable copy used to exclude queued/in-flight rows in a recovery query. */
  activeKeyList(): readonly string[] {
    return [...this.activeKeys];
  }

  snapshot(): BackgroundQueueSnapshot {
    return {
      capacity: {
        items: this.options.maxItems,
        bytes: this.options.maxBytes,
        batchSize: this.options.batchSize,
      },
      queued: this.jobs.length,
      queuedBytes: this.queuedBytes,
      inFlight: this.inFlight,
      inFlightBytes: this.inFlightBytes,
      highWaterItems: this.highWaterItems,
      highWaterBytes: this.highWaterBytes,
      enqueued: this.enqueued,
      completed: this.completed,
      failed: this.failed,
      dropped: this.dropped,
      discarded: this.discarded,
      coalesced: this.coalesced,
      draining: this.draining,
      accepting: this.accepting,
    };
  }

  async flush(): Promise<void> {
    if (!this.draining && this.jobs.length === 0 && this.inFlight === 0) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private scheduleDrain(): void {
    if (this.scheduled || this.draining) return;
    this.scheduled = true;
    // One macrotask coalescing boundary lets sequential appends become one
    // provider batch instead of a series of singleton calls.
    setImmediate(() => {
      this.scheduled = false;
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.emitChange();
    try {
      while (this.jobs.length > 0) {
        const batch = this.jobs.splice(0, this.options.batchSize);
        const bytes = batch.reduce((sum, job) => sum + job.bytes, 0);
        this.queuedBytes -= bytes;
        this.inFlight = batch.length;
        this.inFlightBytes = bytes;
        this.emitChange();
        try {
          await this.options.process(batch);
          this.completed += batch.length;
        } catch (error) {
          this.failed += batch.length;
          try {
            this.options.onError?.(error);
          } catch {
            // Diagnostics are best-effort and cannot poison future batches.
          }
          if (this.options.discardQueuedOnError === true) this.discardQueued();
        } finally {
          for (const job of batch) this.activeKeys.delete(job.key);
          this.inFlight = 0;
          this.inFlightBytes = 0;
          try {
            this.options.onBatchSettled?.();
          } catch {
            // Recovery/refill is best-effort; queue accounting remains valid.
          }
          this.emitChange();
        }
      }
    } finally {
      this.draining = false;
      if (this.jobs.length > 0) {
        this.scheduleDrain();
      } else {
        this.resolveWaiters();
      }
      this.emitChange();
    }
  }

  private resolveWaiters(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  private emitChange(): void {
    try {
      this.options.onChange?.();
    } catch {
      // Queue state reporting is best-effort.
    }
  }
}
