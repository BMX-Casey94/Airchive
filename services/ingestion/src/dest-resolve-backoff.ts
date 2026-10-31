/**
 * Minimum gap between destination-write attempts after one has failed.
 *
 * Approach and landing resolution runs on every telemetry frame (about 1 Hz).
 * Repeating a failed update on each frame is what filled the ingestion log
 * with `value too long for type character varying(4)`. One minute stops that
 * storm and still leaves time for another attempt during the same approach.
 */
export const DEST_RESOLVE_BACKOFF_MS = 60_000;

/**
 * Remembers a failed destination write for one flight session.
 * The first failure is the only one that should be logged. Later polls skip
 * the database until the backoff has elapsed, and a repeated failure stays quiet.
 */
export class DestResolveBackoff {
  private readonly failedAt = new Map<string, number>();

  private readonly logged = new Set<string>();

  constructor(
    private readonly backoffMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  shouldSkip(sessionId: string): boolean {
    const failedAt = this.failedAt.get(sessionId);
    if (failedAt === undefined) {
      return false;
    }
    return this.now() - failedAt < this.backoffMs;
  }

  /** Records a failure. Returns true only the first time this session should be logged. */
  recordFailure(sessionId: string): boolean {
    const emitWarning = !this.logged.has(sessionId);
    this.logged.add(sessionId);
    this.failedAt.set(sessionId, this.now());
    return emitWarning;
  }

  clear(sessionId: string): void {
    this.failedAt.delete(sessionId);
    this.logged.delete(sessionId);
  }
}
