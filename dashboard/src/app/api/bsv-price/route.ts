import { NextResponse } from "next/server";
import {
  BSV_PRICE_FALLBACK_GBP,
  BSV_PRICE_REFRESH_MS,
  type BsvPriceResponse,
  type BsvPriceSource,
  isFinitePositivePrice,
} from "@/lib/bsv-price";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FETCH_TIMEOUT_MS = 8_000;

/** Last successful live quote retained across warm invocations. */
let lastGood: BsvPriceResponse | null = null;

interface Quote {
  gbp: number;
  source: Exclude<BsvPriceSource, "fallback">;
  updatedAt: number;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json();
}

async function fromCoinGecko(): Promise<Quote> {
  const json = (await fetchJson(
    "https://api.coingecko.com/api/v3/simple/price"
      + "?ids=bitcoin-cash-sv&vs_currencies=gbp&include_last_updated_at=true",
  )) as {
    "bitcoin-cash-sv"?: { gbp?: number; last_updated_at?: number };
  };

  const gbp = json["bitcoin-cash-sv"]?.gbp;
  if (!isFinitePositivePrice(gbp)) {
    throw new Error("CoinGecko returned no BSV/GBP price");
  }

  const updatedAt = json["bitcoin-cash-sv"]?.last_updated_at;
  return {
    gbp,
    source: "coingecko",
    updatedAt:
      typeof updatedAt === "number" && Number.isFinite(updatedAt)
        ? updatedAt * 1000
        : Date.now(),
  };
}

async function fromCoinbase(): Promise<Quote> {
  const json = (await fetchJson(
    "https://api.coinbase.com/v2/prices/BSV-GBP/spot",
  )) as { data?: { amount?: string } };

  const gbp = Number(json.data?.amount);
  if (!isFinitePositivePrice(gbp)) {
    throw new Error("Coinbase returned no BSV/GBP price");
  }

  return { gbp, source: "coinbase", updatedAt: Date.now() };
}

async function resolveLiveQuote(): Promise<Quote> {
  const errors: string[] = [];

  for (const attempt of [fromCoinGecko, fromCoinbase]) {
    try {
      return await attempt();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  throw new Error(errors.join("; ") || "All BSV price upstreams failed");
}

function cacheHeaders(maxAgeSec: number): HeadersInit {
  return {
    "Cache-Control": `public, s-maxage=${maxAgeSec}, stale-while-revalidate=${maxAgeSec * 2}`,
  };
}

export async function GET() {
  try {
    const quote = await resolveLiveQuote();
    const body: BsvPriceResponse = {
      gbp: quote.gbp,
      source: quote.source,
      updatedAt: quote.updatedAt,
      stale: false,
    };
    lastGood = body;
    return NextResponse.json(body, {
      headers: cacheHeaders(Math.floor(BSV_PRICE_REFRESH_MS / 1000)),
    });
  } catch {
    if (lastGood) {
      return NextResponse.json(
        { ...lastGood, stale: true },
        { headers: cacheHeaders(60), status: 200 },
      );
    }

    const body: BsvPriceResponse = {
      gbp: BSV_PRICE_FALLBACK_GBP,
      source: "fallback",
      updatedAt: Date.now(),
      stale: true,
    };
    return NextResponse.json(body, {
      headers: cacheHeaders(60),
      status: 200,
    });
  }
}
