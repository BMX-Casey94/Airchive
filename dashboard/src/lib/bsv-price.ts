/**
 * Shared BSV→GBP price helpers for the cost calculator.
 *
 * Live quotes are fetched server-side via `/api/bsv-price`. The fallback is
 * only used when every upstream is unreachable so GBP figures never blank out.
 */
export const BSV_PRICE_FALLBACK_GBP = 9.49;

export const BSV_PRICE_REFRESH_MS = 5 * 60_000;

export type BsvPriceSource = "coingecko" | "coinbase" | "fallback";

export interface BsvPriceResponse {
  gbp: number;
  source: BsvPriceSource;
  /** Upstream quote time when known; otherwise the moment we served the value. */
  updatedAt: number;
  stale: boolean;
}

export function isFinitePositivePrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
