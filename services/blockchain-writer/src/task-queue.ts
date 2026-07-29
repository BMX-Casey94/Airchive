import { createLogger } from "@airchive/logger";

const log = createLogger({ service: "blockchain-writer:task-queue" });

export interface BoundedTaskQueueOptions {
  /** Low-cardinality name used in logs and metrics. */
  name: string;
  concurrency: number;
  maxDepth: number;
  /** Called once per shed task so the caller can count or degrade gracefully. */
  onOverflow?: () => void;
}

/**
 * Runs tasks at a fixed concurrency behind a capped backlog.
 *
 * `void handler(event)` on a hot event stream has no back pressure at all: a
 * burst upstream becomes a burst of in-flight promises, each pinning its
 * payload plus whatever database work it has queued behind a connection pool
 * that is orders of magnitude smaller. A few thousand of those is enough to
 * exhaust the heap, which is how a storm of rejection events turned the writer
 * into a crash loop. Bounding both dimensions makes the failure mode "some
 * events are shed and counted" instead of "the process dies".
 */
export class BoundedTaskQueue {
  private readonly pending: Array<() => Promise<void>> = [];
  private active = 0;
  private dropped = 0;

  constructor(private readonly options: BoundedTaskQueueOptions) {}

  get depth(): number {
    return this.pending.length;
  }

  get inFlight(): number {
    return this.active;
  }

  get droppedTotal(): number {
    return this.dropped;
  }

  /** Returns false when the backlog was full and the task was shed. */
  push(task: () => Promise<void>): boolean {
    if (this.pending.length >= this.options.maxDepth) {
      this.dropped++;
      this.options.onOverflow?.();
      return false;
    }
    this.pending.push(task);
    this.pump();
    return true;
  }

  /** Resolves once the backlog is empty and nothing is in flight. */
  async drain(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.active > 0 || this.pending.length > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private pump(): void {
    while (this.active < this.options.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) return;

      this.active++;
      void task()
        .catch((err) => {
          log.error({ err, queue: this.options.name }, "Queued task failed");
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}
