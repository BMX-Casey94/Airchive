import { createLogger } from "@airchive/logger";
import {
  isWocUnavailable,
  WocClient,
  WocRateLimitedError,
  WocUnavailableError,
  type WocClientOptions,
  type WocRequestOptions,
  type WocTxStatus,
} from "./woc-client.js";

const log = createLogger({ service: "blockchain-writer:chain-lookup" });

/**
 * What a provider is known to answer. BananaBlocks speaks the WhatsOnChain
 * dialect for confirmations, proofs and headers, but has no address/UTXO
 * surface yet; Bitails is the opposite — strong on UTXOs, different shapes
 * elsewhere. Routing by capability keeps each request on a source that can
 * actually serve it, instead of burning budgets on guaranteed 404s.
 */
export type ChainCapability =
  | "utxo"
  | "txStatus"
  | "tscProof"
  | "headers"
  /** A block's transaction id list, used to derive proofs locally. */
  | "blockTx"
  | "tx";

export interface ChainProviderConfig extends WocClientOptions {
  name: string;
  capabilities: ChainCapability[];
  /**
   * BananaBlocks serves individual transactions under `/tx/hash/{txid}`
   * rather than WhatsOnChain's `/tx/{txid}`.
   */
  txPathStyle?: "direct" | "hash";
  /**
   * BananaBlocks returns a single TSC proof object; WhatsOnChain returns an
   * array. When true, a lone object is wrapped so callers can always index [0].
   */
  wrapTscProof?: boolean;
}

interface BitailsUnspentRow {
  txid: string;
  vout: number;
  satoshis: number;
  blockheight?: number;
  confirmations?: number;
}

interface BitailsUnspentResponse {
  address?: string;
  unspent?: BitailsUnspentRow[];
}

/** WoC-shaped UTXO row that utxo-manager / funding / agent-refill expect. */
export interface ChainUtxo {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
}

export interface BitailsProviderConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey?: string;
  maxRequestsPerSecond: number;
}

const ADDRESS_UNSPENT = /^\/address\/([^/]+)\/unspent$/;
const TX_PATH = /^\/tx\/([0-9a-fA-F]{64})(?:\/|$)/;
const TSC_PROOF = /^\/tx\/[0-9a-fA-F]{64}\/proof\/tsc$/;
// Block headers and block bodies are separate capabilities because a provider
// can serve one correctly and not the other.
const BLOCK_HEADER = /^\/block\/(?:headers|\d+\/header)$/;
const BLOCK_TX = /^\/block\/(?:height\/\d+|hash\/[0-9a-fA-F]{64}(?:\/page\/\d+)?)$/;

function capabilityFor(path: string, method: "GET" | "POST"): ChainCapability | null {
  if (ADDRESS_UNSPENT.test(path)) return "utxo";
  if (path === "/txs/status" && method === "POST") return "txStatus";
  if (TSC_PROOF.test(path)) return "tscProof";
  if (BLOCK_HEADER.test(path)) return "headers";
  if (BLOCK_TX.test(path)) return "blockTx";
  if (TX_PATH.test(path)) return "tx";
  return null;
}

/**
 * Fan-out across independent chain-data providers so a WhatsOnChain 429 no
 * longer freezes confirmations, reconciliation and agent refills at once.
 *
 * Surface matches `WocClient` so existing callers keep their call sites; the
 * only change at the wiring layer is constructing this instead of a single
 * client.
 */
export class ChainLookup {
  private readonly providers: WocClient[];
  private readonly providerMeta: Map<string, ChainProviderConfig>;
  private readonly bitails: WocClient | null;
  private readonly bitailsEnabled: boolean;

  constructor(
    providers: ChainProviderConfig[],
    bitails?: BitailsProviderConfig,
  ) {
    if (providers.length === 0) {
      throw new Error("ChainLookup requires at least one WhatsOnChain-compatible provider");
    }

    this.providerMeta = new Map();
    this.providers = providers.map((config) => {
      this.providerMeta.set(config.name, config);
      return new WocClient({
        ...config,
        name: config.name,
      });
    });

    this.bitailsEnabled = Boolean(bitails?.enabled && bitails.baseUrl.trim());
    this.bitails = this.bitailsEnabled && bitails
      ? new WocClient({
          name: "bitails",
          baseUrl: bitails.baseUrl,
          apiKey: bitails.apiKey,
          // Bitails documents the key as an `apikey` header, not Authorization.
          apiKeyHeader: "apikey",
          maxRequestsPerSecond: bitails.maxRequestsPerSecond,
          // Bitails free tier is ~10 RPS; keep concurrency modest so a burst
          // of reconciliations cannot monopolise the daily quota.
          maxConcurrent: 2,
        })
      : null;

    log.info(
      {
        providers: providers.map((p) => ({
          name: p.name,
          endpoint: p.baseUrl,
          capabilities: p.capabilities,
          maxRps: p.maxRequestsPerSecond ?? 3,
        })),
        bitails: this.bitailsEnabled
          ? { endpoint: bitails?.baseUrl, maxRps: bitails?.maxRequestsPerSecond }
          : null,
      },
      "Chain lookup ready — independent providers share the work",
    );
  }

  isRateLimited(): boolean {
    const allWocLimited = this.providers.every((p) => p.isRateLimited());
    if (!this.bitails) return allWocLimited;
    return allWocLimited && this.bitails.isRateLimited();
  }

  get rateLimitRemainingMs(): number {
    const waits = this.providers.map((p) => p.rateLimitRemainingMs);
    if (this.bitails) waits.push(this.bitails.rateLimitRemainingMs);
    return Math.min(...waits);
  }

  async getJson<T>(path: string, options: WocRequestOptions): Promise<T | null> {
    const unspent = ADDRESS_UNSPENT.exec(path);
    if (unspent?.[1]) {
      return (await this.fetchUnspent(unspent[1], options)) as T | null;
    }

    const capability = capabilityFor(path, "GET") ?? "tx";
    return this.withFailover(capability, options.label, async (client, meta) => {
      const resolved = this.resolvePath(path, meta);
      const body = await client.getJson<unknown>(resolved, options);
      return this.normaliseGet(path, body, meta) as T | null;
    });
  }

  async postJson<T>(
    path: string,
    body: unknown,
    options: WocRequestOptions,
  ): Promise<T | null> {
    const capability = capabilityFor(path, "POST") ?? "txStatus";
    return this.withFailover(capability, options.label, (client) =>
      client.postJson<T>(path, body, options),
    );
  }

  async fetchTxStatuses(txids: string[]): Promise<Map<string, WocTxStatus> | null> {
    return this.withFailover("txStatus", "txs_status", async (client) => {
      const statuses = await client.fetchTxStatuses(txids);
      return statuses;
    });
  }

  /**
   * Address UTXOs, normalised to the WhatsOnChain shape every wallet manager
   * already speaks. Prefer Bitails when configured — that is the workload
   * WhatsOnChain is worst at under load — then fall back to any
   * WoC-compatible provider that advertises the `utxo` capability.
   */
  private async fetchUnspent(
    address: string,
    options: WocRequestOptions,
  ): Promise<ChainUtxo[] | null> {
    const errors: Error[] = [];

    if (this.bitails && !this.bitails.isRateLimited()) {
      try {
        const payload = await this.bitails.getJson<BitailsUnspentResponse>(
          `/address/${address}/unspent`,
          { ...options, label: "bitails_unspent", allowNotFound: true },
        );
        if (payload?.unspent) {
          return payload.unspent.map((row) => ({
            tx_hash: row.txid,
            tx_pos: row.vout,
            value: row.satoshis,
            height: Number(row.blockheight ?? 0) > 0 ? Number(row.blockheight) : 0,
          }));
        }
      } catch (err) {
        if (isWocUnavailable(err)) {
          errors.push(err as Error);
          log.debug(
            { address, reason: (err as Error).message },
            "Bitails UTXO lookup deferred — trying WhatsOnChain-compatible providers",
          );
        } else {
          throw err;
        }
      }
    }

    try {
      return await this.withFailover("utxo", options.label, async (client) => {
        const rows = await client.getJson<ChainUtxo[]>(
          `/address/${address}/unspent`,
          options,
        );
        return rows;
      });
    } catch (err) {
      if (errors.length > 0 && isWocUnavailable(err)) {
        throw errors[0];
      }
      throw err;
    }
  }

  private resolvePath(path: string, meta: ChainProviderConfig): string {
    if (meta.txPathStyle !== "hash") return path;
    // Only rewrite the bare transaction lookup; proofs already share the
    // `/tx/{txid}/proof/tsc` path with WhatsOnChain.
    const match = /^\/tx\/([0-9a-fA-F]{64})$/.exec(path);
    if (!match) return path;
    return `/tx/hash/${match[1]}`;
  }

  private normaliseGet(
    path: string,
    body: unknown,
    meta: ChainProviderConfig,
  ): unknown {
    if (!meta.wrapTscProof || !TSC_PROOF.test(path) || body == null) return body;
    // BananaBlocks returns one proof object; WhatsOnChain returns an array.
    if (Array.isArray(body)) return body;
    if (typeof body === "object") return [body];
    return body;
  }

  private async withFailover<T>(
    capability: ChainCapability,
    label: string,
    run: (client: WocClient, meta: ChainProviderConfig) => Promise<T>,
  ): Promise<T> {
    const candidates = this.providers.filter((client) => {
      const meta = this.providerMeta.get(client.name);
      return meta?.capabilities.includes(capability);
    });

    if (candidates.length === 0) {
      throw new WocUnavailableError(
        `No chain provider advertises capability ${capability} for ${label}`,
      );
    }

    const errors: Error[] = [];
    for (const client of candidates) {
      if (client.isRateLimited()) {
        errors.push(new WocRateLimitedError(client.rateLimitRemainingMs));
        continue;
      }
      const meta = this.providerMeta.get(client.name);
      if (!meta) continue;

      try {
        return await run(client, meta);
      } catch (err) {
        if (isWocUnavailable(err)) {
          errors.push(err as Error);
          log.warn(
            {
              provider: client.name,
              label,
              capability,
              reason: (err as Error).message,
            },
            "Chain provider unavailable — trying next",
          );
          continue;
        }
        throw err;
      }
    }

    throw errors[0]
      ?? new WocUnavailableError(`All chain providers failed for ${label}`);
  }
}

/** Build the production lookup graph from environment-derived config. */
export function buildChainLookup(options: {
  woc: { baseUrl: string; apiKey?: string; maxRequestsPerSecond: number };
  bananaBlocks: {
    enabled: boolean;
    baseUrl: string;
    maxRequestsPerSecond: number;
  };
  bitails: BitailsProviderConfig;
}): ChainLookup {
  const providers: ChainProviderConfig[] = [];

  // BananaBlocks first for confirmations and proofs so WhatsOnChain's scarce
  // free-tier budget is kept for the UTXO work Bitails cannot cover once its
  // daily quota is spent.
  if (options.bananaBlocks.enabled && options.bananaBlocks.baseUrl.trim()) {
    providers.push({
      name: "bananablocks",
      baseUrl: options.bananaBlocks.baseUrl,
      maxRequestsPerSecond: options.bananaBlocks.maxRequestsPerSecond,
      // Confirmed live: txs/status, proof/tsc, tx/hash/{txid}, and block
      // bodies with the same pagination as WhatsOnChain.
      // Headers are deliberately excluded: its /block/headers payload omits
      // `previousblockhash`, so the header cannot be reserialised into the
      // canonical 80 bytes and fails proof-of-work verification. That defect is
      // specific to the header endpoint, so block bodies are still used — and
      // a tampered body cannot pass, since its tree has to reproduce a root we
      // already verified. Address/UTXO endpoints currently 404.
      capabilities: ["txStatus", "tscProof", "tx", "blockTx"],
      txPathStyle: "hash",
      wrapTscProof: true,
    });
  }

  providers.push({
    name: "whatsonchain",
    baseUrl: options.woc.baseUrl,
    apiKey: options.woc.apiKey,
    maxRequestsPerSecond: options.woc.maxRequestsPerSecond,
    capabilities: ["utxo", "txStatus", "tscProof", "headers", "blockTx", "tx"],
  });

  return new ChainLookup(providers, options.bitails);
}
