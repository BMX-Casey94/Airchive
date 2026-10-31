/**
 * Blocks broadcasts while the startup pool sweep is running, and keeps an
 * aircraft or the treasury blocked when that sweep could not read the chain.
 *
 * The spend governor has no runtime pause this package can set. Call sites and
 * the governed broadcaster consult this hold instead.
 */
export class BroadcastHold {
  private globallyHeld = false;
  private fundingBlocked = false;
  private readonly blockedAircraft = new Set<string>();

  holdAll(): void {
    this.globallyHeld = true;
  }

  /** Clears the startup hold. Per-aircraft and treasury blocks stay. */
  releaseAll(): void {
    this.globallyHeld = false;
  }

  isHeld(): boolean {
    return this.globallyHeld;
  }

  blockAircraft(icao: string): void {
    const key = icao.trim().toUpperCase();
    if (key) this.blockedAircraft.add(key);
  }

  unblockAircraft(icao: string): void {
    this.blockedAircraft.delete(icao.trim().toUpperCase());
  }

  blockFunding(): void {
    this.fundingBlocked = true;
  }

  unblockFunding(): void {
    this.fundingBlocked = false;
  }

  blocksFunding(): boolean {
    return this.globallyHeld || this.fundingBlocked;
  }

  blocksAircraft(icao: string): boolean {
    return this.globallyHeld || this.blockedAircraft.has(icao.trim().toUpperCase());
  }

  /**
   * True when this broadcast must not be sent.
   * A refill spends the treasury even when it is tagged with an aircraft.
   * Agent top-ups use an `AGENT:` label and no aircraft pool.
   */
  blocksBroadcast(icao?: string, kind?: string): boolean {
    if (this.globallyHeld) return true;
    if (
      this.fundingBlocked
      && (kind === "refill" || !icao || icao.startsWith("AGENT:"))
    ) {
      return true;
    }
    if (!icao || icao.startsWith("AGENT:")) return false;
    return this.blockedAircraft.has(icao.trim().toUpperCase());
  }

  reset(): void {
    this.globallyHeld = false;
    this.fundingBlocked = false;
    this.blockedAircraft.clear();
  }
}

export const broadcastHold = new BroadcastHold();
